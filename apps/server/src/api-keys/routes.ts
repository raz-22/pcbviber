/**
 * API key routes.
 *
 *   POST   /api/orgs/:orgId/api-keys           — generate (owner/admin)
 *   GET    /api/orgs/:orgId/api-keys           — list (owner/admin)
 *   PATCH  /api/orgs/:orgId/api-keys/:keyId    — update default workspace
 *   DELETE /api/orgs/:orgId/api-keys/:keyId    — revoke (owner/admin)
 *
 * The plaintext key is returned exactly once on POST; the server stores
 * only sha256(plaintext). Subsequent listings carry only metadata
 * (name, scopes, expiresAt, lastUsedAt, revokedAt).
 *
 * Authorization is delegated to `can()`. The `api_key.*` actions are
 * owner/admin only — handing out keys grants MCP tool access at the
 * org level and is the kind of thing members shouldn't be able to do
 * unilaterally.
 *
 * Revoke is a soft-delete: ApiKey.revokedAt is set, the row stays.
 * Keeps the audit trail intact and lets the SPA show "revoked at X"
 * for keys an admin previously created.
 *
 * Stable error codes:
 *   not_authenticated  forbidden  not_found  invalid_input
 *   api_key_already_revoked      — DELETE on a key whose revokedAt is set
 *   workspace_not_in_org         — PATCH/POST defaultWorkspaceId belongs to another org
 *
 * Audit log:
 *   api_key.create   — target = apiKey.id, metadata = { name, scopes, hasExpiry }
 *   api_key.update   — target = apiKey.id, metadata = { defaultWorkspaceId }
 *   api_key.revoke   — target = apiKey.id, metadata = { name }
 *
 * NEVER write the plaintext or hash to the audit log.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenantTx } from "../db/tenant-tx.js";
import type { AuthProvider } from "@altium-mcp/auth";
import { makeRequireAuth } from "../auth/middleware.js";
import { makeRequireOrgRole } from "../auth/tenant.js";
import { writeAuditLog, clientIp } from "../auth/audit.js";
import { can } from "../auth/can.js";
import { generateApiKey } from "./keys.js";
import { csrfOrPassthrough } from "../security/csrf.js";

// ─── Input schemas ────────────────────────────────────────────────────

const CreateApiKeyBody = z.object({
  name: z.string().min(1).max(100),
  /**
   * Free-form scope strings — the vocabulary isn't fixed yet; the
   * MCP transport-auth path that consumes them lands later. Capped
   * so an attacker reaching this endpoint can't blow up the row.
   *
   * Whitespace is rejected: scopes are persisted space-joined in the
   * `scopes` column, so a scope containing a space would split apart
   * on read (`["foo bar"]` round-trips as `["foo","bar"]`). Pinning
   * "no whitespace" keeps the round-trip lossless.
   */
  scopes: z
    .array(
      z
        .string()
        .min(1)
        .max(64)
        .regex(/^\S+$/, "scope must not contain whitespace")
    )
    .max(32)
    .optional()
    .default([]),
  /**
   * Optional ISO-8601 expiry. Zod's z.coerce.date() accepts strings
   * + Date instances and rejects garbage. We require it to be in the
   * future — past expiry is meaningless and probably a UI bug.
   */
  expiresAt: z.coerce
    .date()
    .refine((d) => d.getTime() > Date.now(), {
      message: "expiresAt must be in the future",
    })
    .optional(),
  /**
   * Workspace this API key binds MCP tool calls to when the call
   * doesn't carry its own workspaceId. Optional at create time;
   * settable later via PATCH. Validated against orgId — a key in
   * org A can't be bound to a workspace in org B.
   */
  defaultWorkspaceId: z.string().min(1).optional(),
});

const PatchApiKeyBody = z
  .object({
    /**
     * `null` clears the binding; a string sets/changes it. The body
     * MUST include defaultWorkspaceId — `{}` is rejected (use the
     * existing route to be a no-op).
     */
    defaultWorkspaceId: z.union([z.string().min(1), z.null()]),
  })
  .strict();

// ─── Registration ─────────────────────────────────────────────────────

export async function registerApiKeyRoutes(
  app: FastifyInstance,
  auth: AuthProvider
): Promise<void> {
  const requireAuth = makeRequireAuth(auth);
  const requireMember = makeRequireOrgRole([]);

  // ── POST /api/orgs/:orgId/api-keys ───────────────────────────────────
  app.post(
    "/api/orgs/:orgId/api-keys",
    { preHandler: [csrfOrPassthrough(app), requireAuth, requireMember] },
    async (req, reply) => {
      const parsed = CreateApiKeyBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid_input", detail: parsed.error.flatten() };
      }
      const ctx = req.ctx!;
      if (!can({ userId: ctx.user.id, role: ctx.role }, "api_key.create")) {
        reply.code(403);
        return { error: "forbidden" };
      }

      // If the caller asked to bind a default workspace, validate
      // it belongs to this org. Cross-tenant collapse to 404 keeps
      // the behavior consistent with the workspace routes. Both the
      // validate and the create run inside the same withTenantTx so
      // the workspace check is RLS-bounded too.
      const generated = generateApiKey();
      const result = await withTenantTx(ctx.org.id, async (tx) => {
        if (parsed.data.defaultWorkspaceId) {
          const ws = await tx.workspace.findUnique({
            where: { id: parsed.data.defaultWorkspaceId },
            select: { orgId: true },
          });
          if (!ws || ws.orgId !== ctx.org.id) {
            return { kind: "workspace_not_in_org" } as const;
          }
        }
        const created = await tx.apiKey.create({
          data: {
            orgId: ctx.org.id,
            name: parsed.data.name,
            hashedKey: generated.hash,
            scopes: parsed.data.scopes.join(" "),
            expiresAt: parsed.data.expiresAt ?? null,
            defaultWorkspaceId: parsed.data.defaultWorkspaceId ?? null,
          },
        });
        return { kind: "ok", created } as const;
      });
      if (result.kind === "workspace_not_in_org") {
        reply.code(404);
        return { error: "workspace_not_in_org" };
      }
      const created = result.created;

      await writeAuditLog({
        orgId: ctx.org.id,
        actorUserId: ctx.user.id,
        action: "api_key.create",
        target: created.id,
        ip: clientIp(req),
        userAgent: req.headers["user-agent"],
        metadata: {
          name: created.name,
          scopes: parsed.data.scopes,
          hasExpiry: parsed.data.expiresAt !== undefined,
          hasDefaultWorkspace: parsed.data.defaultWorkspaceId !== undefined,
        },
      });

      reply.code(201);
      return {
        apiKey: serializeApiKey(created, { preview: generated.preview }),
        // Plaintext returned exactly once. Listing endpoints never echo
        // it back — the server can't reconstruct it from the hash.
        key: generated.plaintext,
      };
    }
  );

  // ── PATCH /api/orgs/:orgId/api-keys/:keyId ───────────────────────────
  // Sole settable field today: defaultWorkspaceId. Lets an operator
  // bind / rebind / clear the workspace an MCP tool call gets routed
  // to without rotating the key plaintext.
  app.patch(
    "/api/orgs/:orgId/api-keys/:keyId",
    { preHandler: [csrfOrPassthrough(app), requireAuth, requireMember] },
    async (req, reply) => {
      const parsed = PatchApiKeyBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid_input", detail: parsed.error.flatten() };
      }
      const ctx = req.ctx!;
      const { keyId } = req.params as { keyId: string };
      if (!can({ userId: ctx.user.id, role: ctx.role }, "api_key.update")) {
        reply.code(403);
        return { error: "forbidden" };
      }
      const result = await withTenantTx(ctx.org.id, async (tx) => {
        const existing = await tx.apiKey.findUnique({
          where: { id: keyId },
          select: { id: true, orgId: true, name: true, revokedAt: true },
        });
        if (!existing || existing.orgId !== ctx.org.id) {
          return { kind: "not_found" } as const;
        }
        // Don't let an operator silently re-arm a revoked key by
        // patching it. Revoke → rotate is the documented flow; PATCH
        // on revoked rows stays an explicit 409.
        if (existing.revokedAt) {
          return { kind: "api_key_already_revoked" } as const;
        }

        // Validate the new workspace (when set) belongs to this org.
        if (parsed.data.defaultWorkspaceId !== null) {
          const ws = await tx.workspace.findUnique({
            where: { id: parsed.data.defaultWorkspaceId },
            select: { orgId: true },
          });
          if (!ws || ws.orgId !== ctx.org.id) {
            return { kind: "workspace_not_in_org" } as const;
          }
        }

        const updated = await tx.apiKey.update({
          where: { id: keyId },
          data: { defaultWorkspaceId: parsed.data.defaultWorkspaceId },
        });
        return { kind: "ok", existing, updated } as const;
      });
      if (result.kind === "not_found") {
        reply.code(404);
        return { error: "not_found" };
      }
      if (result.kind === "api_key_already_revoked") {
        reply.code(409);
        return { error: "api_key_already_revoked" };
      }
      if (result.kind === "workspace_not_in_org") {
        reply.code(404);
        return { error: "workspace_not_in_org" };
      }
      const { existing, updated } = result;

      await writeAuditLog({
        orgId: ctx.org.id,
        actorUserId: ctx.user.id,
        action: "api_key.update",
        target: keyId,
        ip: clientIp(req),
        userAgent: req.headers["user-agent"],
        metadata: {
          name: existing.name,
          defaultWorkspaceId: parsed.data.defaultWorkspaceId,
        },
      });

      return { apiKey: serializeApiKey(updated) };
    }
  );

  // ── GET /api/orgs/:orgId/api-keys ────────────────────────────────────
  app.get(
    "/api/orgs/:orgId/api-keys",
    { preHandler: [requireAuth, requireMember] },
    async (req, reply) => {
      const ctx = req.ctx!;
      if (!can({ userId: ctx.user.id, role: ctx.role }, "api_key.list")) {
        reply.code(403);
        return { error: "forbidden" };
      }
      const rows = await withTenantTx(ctx.org.id, (tx) =>
        tx.apiKey.findMany({
          where: { orgId: ctx.org.id },
          orderBy: { createdAt: "desc" },
        })
      );
      // Listings include revoked rows so the SPA can render history;
      // the SPA filters on `revokedAt === null` for "active" view.
      return { apiKeys: rows.map((r) => serializeApiKey(r)) };
    }
  );

  // ── DELETE /api/orgs/:orgId/api-keys/:keyId ──────────────────────────
  app.delete(
    "/api/orgs/:orgId/api-keys/:keyId",
    { preHandler: [csrfOrPassthrough(app), requireAuth, requireMember] },
    async (req, reply) => {
      const ctx = req.ctx!;
      const { keyId } = req.params as { keyId: string };
      if (!can({ userId: ctx.user.id, role: ctx.role }, "api_key.revoke")) {
        reply.code(403);
        return { error: "forbidden" };
      }
      const result = await withTenantTx(ctx.org.id, async (tx) => {
        const existing = await tx.apiKey.findUnique({ where: { id: keyId } });
        if (!existing || existing.orgId !== ctx.org.id) {
          return { kind: "not_found" } as const;
        }
        if (existing.revokedAt) {
          return { kind: "api_key_already_revoked" } as const;
        }
        await tx.apiKey.update({
          where: { id: keyId },
          data: { revokedAt: new Date() },
        });
        return { kind: "ok", existing } as const;
      });
      if (result.kind === "not_found") {
        // Cross-tenant + unknown id collapse to 404 — same defense
        // as workspaces/invites: no enumeration of key ids across orgs.
        reply.code(404);
        return { error: "not_found" };
      }
      if (result.kind === "api_key_already_revoked") {
        reply.code(409);
        return { error: "api_key_already_revoked" };
      }
      const existing = result.existing;

      await writeAuditLog({
        orgId: ctx.org.id,
        actorUserId: ctx.user.id,
        action: "api_key.revoke",
        target: keyId,
        ip: clientIp(req),
        userAgent: req.headers["user-agent"],
        metadata: { name: existing.name },
      });

      return { ok: true };
    }
  );
}

// ─── Response shape ───────────────────────────────────────────────────

interface ApiKeyRow {
  id: string;
  orgId: string;
  name: string;
  scopes: string;
  defaultWorkspaceId: string | null;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
}

/**
 * Public ApiKey shape — never includes hashedKey or plaintext. The
 * `preview` field is populated only on the create response (the
 * caller passes it in); subsequent listings can't reproduce it
 * because the server never stored the body.
 */
function serializeApiKey(row: ApiKeyRow, opts?: { preview?: string }) {
  return {
    id: row.id,
    name: row.name,
    scopes: row.scopes ? row.scopes.split(" ").filter(Boolean) : [],
    defaultWorkspaceId: row.defaultWorkspaceId,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    preview: opts?.preview,
  };
}
