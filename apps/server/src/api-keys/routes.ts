/**
 * API key routes.
 *
 *   POST   /api/orgs/:orgId/api-keys           — generate (owner/admin)
 *   GET    /api/orgs/:orgId/api-keys           — list (owner/admin)
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
 *
 * Audit log:
 *   api_key.create   — target = apiKey.id, metadata = { name, scopes, hasExpiry }
 *   api_key.revoke   — target = apiKey.id, metadata = { name }
 *
 * NEVER write the plaintext or hash to the audit log.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@altium-mcp/db";
import type { AuthProvider } from "@altium-mcp/auth";
import { makeRequireAuth } from "../auth/middleware.js";
import { makeRequireOrgRole } from "../auth/tenant.js";
import { writeAuditLog, clientIp } from "../auth/audit.js";
import { can } from "../auth/can.js";
import { generateApiKey } from "./keys.js";

// ─── Input schemas ────────────────────────────────────────────────────

const CreateApiKeyBody = z.object({
  name: z.string().min(1).max(100),
  /**
   * Free-form scope strings — the vocabulary isn't fixed yet (the
   * MCP transport auth in PR 3.4 is what consumes them). Capped to
   * keep an attacker who reaches this endpoint from blowing up the
   * row. Empty array == no scopes claimed.
   */
  scopes: z
    .array(z.string().min(1).max(64))
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
});

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
    { preHandler: [requireAuth, requireMember] },
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

      const generated = generateApiKey();
      const created = await prisma.apiKey.create({
        data: {
          orgId: ctx.org.id,
          name: parsed.data.name,
          hashedKey: generated.hash,
          scopes: parsed.data.scopes.join(" "),
          expiresAt: parsed.data.expiresAt ?? null,
        },
      });

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
      const rows = await prisma.apiKey.findMany({
        where: { orgId: ctx.org.id },
        orderBy: { createdAt: "desc" },
      });
      // Listings include revoked rows so the SPA can render history;
      // the SPA filters on `revokedAt === null` for "active" view.
      return { apiKeys: rows.map((r) => serializeApiKey(r)) };
    }
  );

  // ── DELETE /api/orgs/:orgId/api-keys/:keyId ──────────────────────────
  app.delete(
    "/api/orgs/:orgId/api-keys/:keyId",
    { preHandler: [requireAuth, requireMember] },
    async (req, reply) => {
      const ctx = req.ctx!;
      const { keyId } = req.params as { keyId: string };
      if (!can({ userId: ctx.user.id, role: ctx.role }, "api_key.revoke")) {
        reply.code(403);
        return { error: "forbidden" };
      }
      const existing = await prisma.apiKey.findUnique({ where: { id: keyId } });
      if (!existing || existing.orgId !== ctx.org.id) {
        // Cross-tenant + unknown id collapse to 404 — same defense
        // as workspaces/invites: no enumeration of key ids across orgs.
        reply.code(404);
        return { error: "not_found" };
      }
      if (existing.revokedAt) {
        reply.code(409);
        return { error: "api_key_already_revoked" };
      }

      await prisma.apiKey.update({
        where: { id: keyId },
        data: { revokedAt: new Date() },
      });

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
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    preview: opts?.preview,
  };
}
