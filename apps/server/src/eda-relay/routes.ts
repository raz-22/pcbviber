/**
 * /api/eda-relay/* — HTTP routes for the EasyEDA Pro extension's
 * long-poll bridge.
 *
 * Sprint 9 PR 9.4b. The broker primitive (`EdaRelay`) landed in PR
 * 9.4a. This PR adds the three endpoints the extension calls and the
 * auth gate that keeps a leaked API key from a different tenant
 * pulling another tenant's commands.
 *
 * Auth: `Authorization: Bearer pcb_...`. The API key resolves to its
 * `defaultWorkspaceId` (the workspace the extension is bound to);
 * every endpoint operates against that workspace's per-workspace
 * state inside `EdaRelay`. The cross-tenant isolation pinned in
 * PR 9.4a's tests carries through end-to-end: an API key for ws-a
 * can never poll, post results to, or read status of ws-b.
 *
 * Endpoint shapes mirror `/ad-relay/*` but with extra guards:
 *   - The API key must be configured with a default workspace
 *     (else `api_key_no_workspace` 400).
 *   - That workspace must be `platform=easyeda` (else
 *     `wrong_platform` 400). An Altium workspace's API key shouldn't
 *     accidentally get wired to the EasyEDA bridge.
 *
 * Extension package (PR 9.4c) is the consumer of these endpoints.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@altium-mcp/db";
import { makeRequireApiKey } from "../api-keys/middleware.js";
import type { EdaRelay } from "./relay.js";

// Mirrors EdaResultEnvelope from relay.ts but with a Zod schema so the
// route can validate untrusted bodies. Stays inline rather than getting
// promoted to @altium-mcp/shared until a second consumer (e.g. the SPA)
// needs it.
const EdaResultEnvelope = z.object({
  id: z.string().min(1),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z
    .object({
      message: z.string().min(1),
      code: z.string().optional(),
      detail: z.string().optional(),
    })
    .optional(),
});

const PollQuery = z.object({
  /**
   * Long-poll timeout in ms. 0 = short-poll (return null immediately
   * if no command queued). Capped server-side at 25s — extensions
   * polling longer than that risk hitting platform proxy timeouts.
   */
  pollTimeoutMs: z.coerce.number().int().min(0).max(25_000).default(0),
});

/**
 * Resolves the API key context to a (workspaceId, platform-validated)
 * pair. Centralized so each endpoint reads the same way and the
 * platform-mismatch guard can't accidentally drift between routes.
 */
async function resolveWorkspace(
  req: import("fastify").FastifyRequest,
  reply: import("fastify").FastifyReply
): Promise<{ workspaceId: string } | null> {
  const apiKeyCtx = req.apiKeyCtx;
  if (!apiKeyCtx) {
    // Programmer error: middleware should have populated this.
    reply.code(500).send({ error: "internal_error" });
    return null;
  }
  const apiKey = await prisma.apiKey.findUnique({
    where: { id: apiKeyCtx.apiKey.id },
    select: { defaultWorkspaceId: true },
  });
  if (!apiKey?.defaultWorkspaceId) {
    reply.code(400).send({ error: "api_key_no_workspace" });
    return null;
  }
  const ws = await prisma.workspace.findUnique({
    where: { id: apiKey.defaultWorkspaceId },
    select: { id: true, platform: true, orgId: true },
  });
  // The api key's defaultWorkspaceId references a Workspace that
  // could in principle have been deleted out from under it; the
  // schema's SetNull on workspace delete should prevent this, but
  // defense-in-depth: surface as the same 400 the SPA already
  // handles.
  if (!ws) {
    reply.code(400).send({ error: "api_key_no_workspace" });
    return null;
  }
  // Tenant safety: the API key's org MUST match the workspace's
  // org. SetNull-on-workspace-delete keeps this consistent today,
  // but a programmer-error refactor that detached the two could
  // bypass tenant isolation. Cheap to check; uncatchable bug if
  // missing.
  if (ws.orgId !== apiKeyCtx.apiKey.orgId) {
    reply.code(400).send({ error: "api_key_workspace_org_mismatch" });
    return null;
  }
  if (ws.platform !== "easyeda") {
    reply.code(400).send({
      error: "wrong_platform",
      detail: `This API key is bound to a ${ws.platform} workspace; the EasyEDA bridge accepts easyeda workspaces only.`,
    });
    return null;
  }
  return { workspaceId: ws.id };
}

export function registerEdaRelayRoutes(
  app: FastifyInstance,
  relay: EdaRelay
): void {
  const requireApiKey = makeRequireApiKey();

  // Extension → server: poll for the next command.
  // GET semantics, even though Fastify accepts a body — extensions
  // pass the long-poll timeout via query string so caches/proxies
  // see distinct URIs and don't fold polls together.
  app.get(
    "/api/eda-relay/poll",
    { preHandler: [requireApiKey] },
    async (req, reply) => {
      const parsed = PollQuery.safeParse(req.query);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid_input", detail: parsed.error.flatten() };
      }
      const ws = await resolveWorkspace(req, reply);
      if (!ws) return; // resolveWorkspace already replied
      const cmd = await relay.nextCommand(ws.workspaceId, parsed.data.pollTimeoutMs);
      if (!cmd) {
        reply.code(204);
        return null;
      }
      return cmd;
    }
  );

  // Extension → server: post the result for a dispatched command.
  app.post(
    "/api/eda-relay/result",
    { preHandler: [requireApiKey] },
    async (req, reply) => {
      const parsed = EdaResultEnvelope.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid_input", detail: parsed.error.flatten() };
      }
      const ws = await resolveWorkspace(req, reply);
      if (!ws) return;
      const outcome = relay.postResult(ws.workspaceId, parsed.data);
      if (!outcome.accepted) {
        // 410 Gone — command id no longer tracked (timed out or
        // never dispatched). Same shape as ad-relay/result.
        reply.code(410);
        return { error: "result_rejected", detail: outcome.reason };
      }
      return { ok: true };
    }
  );

  // Extension diagnostic: status snapshot for THIS workspace only.
  // The SPA's /status page (Sprint 8 PR 8.4) shows a single-line
  // "extension connected" indicator; this endpoint gives it the
  // data without touching other tenants' counters.
  app.get(
    "/api/eda-relay/status",
    { preHandler: [requireApiKey] },
    async (req, reply) => {
      const ws = await resolveWorkspace(req, reply);
      if (!ws) return;
      return relay.status(ws.workspaceId);
    }
  );

  // installApiKeyErrorHandler intentionally NOT called here —
  // http.ts already calls it once at the end of route registration
  // so 401s from the api-key middleware reshape uniformly across
  // /mcp, /api/eda-relay/*, and any future bearer-authed endpoints.
  // Tests that mount these routes in isolation install it
  // themselves.
}
