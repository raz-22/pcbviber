/**
 * Usage routes.
 *
 *   GET /api/orgs/:orgId/usage  — current-period consumption snapshot
 *
 * Authorization: any role with the `usage.read` capability — that's
 * owner / admin / member / billing_only. Finance (billing_only)
 * needs visibility into consumption to budget; the SPA gates the
 * Usage nav entry on this same `can()` check.
 *
 * Stable error codes:
 *   not_authenticated  forbidden  not_found
 *
 * No audit log — usage reads are purely informational and would
 * flood the table on a busy dashboard. The data being read is
 * already the customer's own UsageEvent rows.
 */

import type { FastifyInstance } from "fastify";
import { prisma } from "@altium-mcp/db";
import type { AuthProvider } from "@altium-mcp/auth";
import { makeRequireAuth } from "../auth/middleware.js";
import { makeRequireOrgRole } from "../auth/tenant.js";
import { can } from "../auth/can.js";
import { buildUsageReport } from "./handler.js";

export async function registerUsageRoutes(
  app: FastifyInstance,
  auth: AuthProvider
): Promise<void> {
  const requireAuth = makeRequireAuth(auth);
  const requireMember = makeRequireOrgRole([]);

  app.get(
    "/api/orgs/:orgId/usage",
    { preHandler: [requireAuth, requireMember] },
    async (req, reply) => {
      const ctx = req.ctx!;
      if (!can({ userId: ctx.user.id, role: ctx.role }, "usage.read")) {
        reply.code(403);
        return { error: "forbidden" };
      }
      try {
        return await buildUsageReport(prisma, ctx.org.id);
      } catch (err) {
        // The handler throws when the org disappeared mid-request
        // (membership was verified, then the org was deleted before
        // the handler queried). Map to 404 — same shape the SPA's
        // mapper handles for "org gone".
        if (err instanceof Error && /vanished/.test(err.message)) {
          reply.code(404);
          return { error: "not_found" };
        }
        throw err;
      }
    }
  );
}
