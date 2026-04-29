/**
 * Sprint 13 PR 13.1: /api/artifacts/* — HTTP routes for the
 * manufacturing-export artifact store.
 *
 * Two endpoints:
 *   - POST /api/artifacts: extension/relay uploads raw bytes.
 *     application/octet-stream body, format + filename via headers.
 *     Returns {id, byteSize, expiresAt, downloadUrl}.
 *   - GET /api/artifacts/:id: anyone with the API key for the
 *     creating org can download. Streams the bytes back with the
 *     stored mime/filename. 404s when missing/expired/cross-org.
 *
 * Auth: same Bearer-token API-key middleware as /api/eda-relay/*.
 * The auth context's `org.id` scopes both the upload (sets
 * orgId on the artifact) AND the download (filters retrieval).
 *
 * Body limit bump: 50 MB matches the artifact-store cap. Without
 * the override Fastify rejects at 1 MB default.
 *
 * Why scope the binary content-type parser to a child plugin:
 * the rest of the server JSON-parses bodies. This route needs to
 * see raw bytes, but only for the upload endpoint — pattern from
 * billing/webhook.ts.
 */

import type { FastifyInstance } from "fastify";
import { makeRequireApiKey } from "../api-keys/middleware.js";
import { artifactStore, type ArtifactFormat } from "./store.js";

/** Upload body cap. Matches MAX_ARTIFACT_BYTES in store.ts. */
const UPLOAD_BODY_LIMIT_BYTES = 50 * 1024 * 1024;

const VALID_FORMATS: ArtifactFormat[] = [
  "gerber-zip",
  "excellon-drill",
  "csv-bom",
  "csv-pick-and-place",
];

export async function registerArtifactRoutes(
  app: FastifyInstance
): Promise<void> {
  const requireApiKey = makeRequireApiKey();

  // Child-plugin scope: binary content-type parser applies only
  // here. Body limit bump same scope so other routes keep their
  // 1 MB default.
  await app.register(async (childApp) => {
    childApp.addContentTypeParser(
      "application/octet-stream",
      { parseAs: "buffer", bodyLimit: UPLOAD_BODY_LIMIT_BYTES },
      (_req, body, done) => done(null, body)
    );

    childApp.post(
      "/api/artifacts",
      {
        preHandler: [requireApiKey],
        bodyLimit: UPLOAD_BODY_LIMIT_BYTES,
      },
      async (req, reply) => {
        const apiKeyCtx = req.apiKeyCtx;
        if (!apiKeyCtx) {
          reply.code(500);
          return { error: "internal_error" };
        }
        const body = req.body;
        if (!Buffer.isBuffer(body) || body.byteLength === 0) {
          reply.code(400);
          return {
            error: "invalid_input",
            detail: "Body must be a non-empty application/octet-stream payload.",
          };
        }
        // Format/filename/mime/meta come via headers since the body
        // is the raw bytes. Headers are case-insensitive in Fastify.
        const format = String(req.headers["x-artifact-format"] ?? "");
        if (!VALID_FORMATS.includes(format as ArtifactFormat)) {
          reply.code(400);
          return {
            error: "invalid_input",
            detail: `X-Artifact-Format header must be one of: ${VALID_FORMATS.join(", ")}.`,
          };
        }
        const filename = String(req.headers["x-artifact-filename"] ?? "artifact.bin");
        const mimeType = String(
          req.headers["x-artifact-mime"] ??
            req.headers["content-type"] ??
            "application/octet-stream"
        );
        // X-Artifact-Meta is an optional JSON header for format-
        // specific metadata. Defensive: parse-failure → empty object,
        // not error — meta is informational.
        let meta: Record<string, unknown> = {};
        const metaHeader = req.headers["x-artifact-meta"];
        if (typeof metaHeader === "string" && metaHeader.length > 0) {
          try {
            const parsed = JSON.parse(metaHeader);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              meta = parsed as Record<string, unknown>;
            }
          } catch {
            // Silently ignore malformed JSON in the meta header —
            // not worth failing the upload over.
          }
        }
        try {
          const summary = artifactStore.put({
            orgId: apiKeyCtx.org.id,
            format: format as ArtifactFormat,
            bytes: body,
            mimeType,
            filename,
            meta,
          });
          return {
            id: summary.id,
            byteSize: summary.byteSize,
            format: summary.format,
            expiresAt: summary.expiresAt.toISOString(),
            downloadUrl: `/api/artifacts/${summary.id}`,
            meta: summary.meta,
          };
        } catch (err) {
          // store.put throws on oversized bytes — surface as 413.
          reply.code(413);
          return {
            error: "artifact_too_large",
            detail: err instanceof Error ? err.message : String(err),
          };
        }
      }
    );
  });

  // Download endpoint stays in the parent scope (default JSON
  // parsing — no body needed for GET).
  app.get(
    "/api/artifacts/:id",
    { preHandler: [requireApiKey] },
    async (req, reply) => {
      const apiKeyCtx = req.apiKeyCtx;
      if (!apiKeyCtx) {
        reply.code(500);
        return { error: "internal_error" };
      }
      const params = req.params as { id?: string };
      const id = params.id;
      if (!id || typeof id !== "string") {
        reply.code(400);
        return { error: "invalid_input", detail: "id path param required" };
      }
      const record = artifactStore.get(id, apiKeyCtx.org.id);
      if (!record) {
        // 404 covers all three cases (not found / expired / wrong
        // org) — see store.ts for why we don't 403 cross-org.
        reply.code(404);
        return { error: "artifact_not_found" };
      }
      reply.header("content-type", record.mimeType);
      reply.header(
        "content-disposition",
        `attachment; filename="${record.filename.replace(/"/g, '\\"')}"`
      );
      reply.header("x-artifact-format", record.format);
      return record.bytes;
    }
  );
}
