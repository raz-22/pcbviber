/**
 * /api/orgs/:orgId/ip-allowlist — read + update.
 *
 *   GET  → { entries: string[] }
 *           Returns the current allowlist. Empty array = disabled.
 *           Admin-only (matches Members / Audit gates).
 *
 *   PUT  body { entries: string[], force?: boolean }
 *           Replaces the allowlist. Each entry must parse as a valid
 *           IPv4/IPv6 address or CIDR; invalid entries → 400 with the
 *           parse failures listed.
 *
 *           Anti-self-lockout: if the new allowlist is non-empty and
 *           the requester's current IP doesn't match it, the route
 *           refuses with 409 `ip_allowlist_would_lock_out_self` unless
 *           `force: true` is set in the body. The operator who wants
 *           to lock their own IP out (e.g. configuring via VPN, then
 *           disconnecting) opts in explicitly.
 *
 * Writes an `ip_allowlist.update` audit row recording the size delta.
 * The actual entry strings stay out of the audit metadata — they're
 * sensitive (reveal company VPN ranges) and the audit is for "what
 * happened," not "what does it now look like."
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@altium-mcp/db";
import type { AuthProvider } from "@altium-mcp/auth";
import { makeRequireAuth } from "../auth/middleware.js";
import { makeRequireOrgRole } from "../auth/tenant.js";
import { writeAuditLog, clientIp } from "../auth/audit.js";
import { csrfOrPassthrough } from "./csrf.js";
import { withTenantTx } from "../db/tenant-tx.js";
import {
  isAllowed,
  MAX_ENTRIES,
  normalizeEntry,
  parseAllowlist,
} from "./ip-allowlist.js";

const PutBody = z.object({
  entries: z.array(z.string()).max(MAX_ENTRIES),
  force: z.boolean().optional(),
});

export async function registerIpAllowlistRoutes(
  app: FastifyInstance,
  auth: AuthProvider
): Promise<void> {
  const requireAuth = makeRequireAuth(auth);
  const requireAdmin = makeRequireOrgRole(["owner", "admin"]);

  app.get(
    "/api/orgs/:orgId/ip-allowlist",
    { preHandler: [requireAuth, requireAdmin] },
    async (req) => {
      const ctx = req.ctx!;
      // ipAllowlistJson is already on ctx.org (loaded by the tenant
      // middleware). Parse + normalize so the response shape is
      // stable even when a hand-edit dropped a trailing whitespace.
      const entries = parseAllowlist(ctx.org.ipAllowlistJson) ?? [];
      return { entries };
    }
  );

  app.put(
    "/api/orgs/:orgId/ip-allowlist",
    { preHandler: [csrfOrPassthrough(app), requireAuth, requireAdmin] },
    async (req, reply) => {
      const parsed = PutBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid_input", detail: parsed.error.flatten() };
      }
      const ctx = req.ctx!;

      // Normalize every entry. Collect parse failures so the
      // operator gets one clean list of bad inputs, not a single
      // "first broken one" error.
      const normalized: string[] = [];
      const invalid: string[] = [];
      for (const raw of parsed.data.entries) {
        const norm = normalizeEntry(raw);
        if (norm) normalized.push(norm);
        else invalid.push(raw);
      }
      if (invalid.length > 0) {
        reply.code(400);
        return {
          error: "invalid_ip_entries",
          detail: { invalid },
        };
      }

      // De-duplicate while preserving order — same IP from two
      // different sources (e.g. a typo'd lowercase + uppercase
      // IPv6) collapses to one.
      const deduped = Array.from(new Set(normalized));

      // Self-lockout guard. Only checks when the new allowlist is
      // non-empty (an empty list disables enforcement, so it
      // can't lock anyone out). `force: true` opts out.
      if (deduped.length > 0 && parsed.data.force !== true) {
        const myIp = clientIp(req);
        if (!isAllowed(myIp, deduped)) {
          reply.code(409);
          return {
            error: "ip_allowlist_would_lock_out_self",
            detail: {
              hint:
                "Your current IP isn't in the new allowlist. Add it, " +
                "or pass force: true if you intend to lock out this " +
                "connection.",
              clientIp: myIp,
            },
          };
        }
      }

      const previousSize = parseAllowlist(ctx.org.ipAllowlistJson)?.length ?? 0;
      const nextValue = deduped.length > 0 ? JSON.stringify(deduped) : null;

      await withTenantTx(ctx.org.id, async (tx) => {
        await tx.organization.update({
          where: { id: ctx.org.id },
          data: { ipAllowlistJson: nextValue },
        });
      });

      await writeAuditLog({
        orgId: ctx.org.id,
        actorUserId: ctx.user.id,
        action: "ip_allowlist.update",
        ip: clientIp(req),
        userAgent: req.headers["user-agent"],
        metadata: {
          // Sizes only — the entries themselves are sensitive
          // (corporate VPN ranges) and don't belong in the audit
          // payload that admins routinely export.
          previousSize,
          newSize: deduped.length,
          forced: parsed.data.force === true,
        },
      });

      return { entries: deduped };
    }
  );
}
