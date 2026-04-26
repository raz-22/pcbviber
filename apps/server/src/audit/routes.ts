/**
 * Audit-log read API.
 *
 *   GET /api/orgs/:orgId/audit?cursor=&limit=&action=
 *
 * Reads from the AuditLog table that's already populated by signup,
 * login, workspace.*, member.*, api_key.*, and billing.* mutations
 * across the rest of the server. This PR adds *only* the read path;
 * the write surface was built incrementally in prior sprints.
 *
 * Authorization: owner | admin. Audit content includes IP addresses,
 * other members' login times, and similar moderately-sensitive
 * org-level operational data — gating to admins matches how Members
 * and Billing pages restrict the same audience.
 *
 * Pagination: cursor over `(timestamp DESC, id DESC)`. Plain `id`
 * isn't safe — cuids are roughly time-ordered but collisions across
 * processes can produce ties or out-of-order ids, so we pin both
 * fields. The cursor is base64(`${ms}.${id}`); invalid cursors are
 * ignored (treated as "no cursor") rather than 400'd, since the SPA
 * stores cursors in URL state and a stale tab shouldn't surface as
 * a hard error.
 *
 * No audit row is written for the act of reading audits — see Usage
 * routes for the same rationale; informational reads would flood
 * the table.
 */

import type { FastifyInstance } from "fastify";
import type { AuthProvider } from "@altium-mcp/auth";
import { makeRequireAuth } from "../auth/middleware.js";
import { makeRequireOrgRole } from "../auth/tenant.js";
import { withTenantTx } from "../db/tenant-tx.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

interface CursorParts {
  ms: number;
  id: string;
}

function encodeCursor(timestamp: Date, id: string): string {
  return Buffer.from(`${timestamp.getTime()}.${id}`, "utf8").toString(
    "base64"
  );
}

function decodeCursor(cursor: string | undefined): CursorParts | null {
  if (!cursor) return null;
  let raw: string;
  try {
    raw = Buffer.from(cursor, "base64").toString("utf8");
  } catch {
    return null;
  }
  const dot = raw.indexOf(".");
  if (dot <= 0) return null;
  const msStr = raw.slice(0, dot);
  const id = raw.slice(dot + 1);
  if (!id) return null;
  const ms = Number(msStr);
  if (!Number.isFinite(ms) || ms < 0) return null;
  return { ms, id };
}

function parseLimit(raw: string | undefined): number {
  if (!raw) return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

function parseMetadata(raw: string | null): unknown {
  // metadata is stored as a JSON string. If parse fails (corrupt row,
  // legacy non-JSON content), fall through to the raw string so the
  // SPA can still render it.
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export async function registerAuditRoutes(
  app: FastifyInstance,
  auth: AuthProvider
): Promise<void> {
  const requireAuth = makeRequireAuth(auth);
  const requireAdmin = makeRequireOrgRole(["owner", "admin"]);

  app.get(
    "/api/orgs/:orgId/audit",
    { preHandler: [requireAuth, requireAdmin] },
    async (req) => {
      const ctx = req.ctx!;
      const query = req.query as {
        cursor?: string;
        limit?: string;
        action?: string;
      };
      const limit = parseLimit(query.limit);
      const cursor = decodeCursor(query.cursor);

      // Build the where clause. The orgId predicate is redundant with
      // RLS (the policy filters by current_setting('app.current_org_id'))
      // but we keep it: defense in depth, plus tests that run as the
      // RLS-bypassed admin role still see the expected behavior without
      // needing a withTenantTx wrapper.
      const where: Record<string, unknown> = { orgId: ctx.org.id };

      if (typeof query.action === "string" && query.action.length > 0) {
        where.action = query.action;
      }

      if (cursor) {
        // Strict less-than on (timestamp, id). Prisma emits a row-tuple
        // compare via OR-of-AND from the OR shape below.
        where.OR = [
          { timestamp: { lt: new Date(cursor.ms) } },
          {
            timestamp: new Date(cursor.ms),
            id: { lt: cursor.id },
          },
        ];
      }

      return await withTenantTx(ctx.org.id, async (tx) => {
        // Fetch limit + 1 so we know whether another page exists
        // without a separate COUNT query.
        const rows = await tx.auditLog.findMany({
          where,
          orderBy: [{ timestamp: "desc" }, { id: "desc" }],
          take: limit + 1,
          include: {
            // User schema today is just { id, email } — no display name.
            // The SPA renders "user@example.com" directly.
            actor: { select: { id: true, email: true } },
          },
        });

        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        const last = page[page.length - 1];

        return {
          rows: page.map((r) => ({
            id: r.id,
            timestamp: r.timestamp.toISOString(),
            action: r.action,
            target: r.target,
            actor: r.actor ? { id: r.actor.id, email: r.actor.email } : null,
            ip: r.ip,
            userAgent: r.userAgent,
            metadata: parseMetadata(r.metadata),
          })),
          nextCursor: hasMore && last ? encodeCursor(last.timestamp, last.id) : null,
        };
      });
    }
  );
}
