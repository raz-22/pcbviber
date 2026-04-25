/**
 * /api/orgs/:orgId/* — tenant-scoped routes.
 *
 * Sprint 2 starts here with one demo route (`GET /info`). PRs 2.2 + 2.3
 * extend this file with workspace CRUD and Nexar-via-workspace plumbing.
 *
 * Every route in here goes through `makeRequireAuth` then
 * `makeRequireOrgRole(allowed[])`. After both pass, `req.ctx` is
 * populated with `{ user, org, role }` and the handler can trust that
 * tenant scope is enforced.
 *
 * If you add a route here that doesn't need a particular role, use
 * `requireOrgMember` (any role). Use `requireOrgAdmin` for write
 * actions on org settings; `requireOrgOwner` only for irreversible
 * org-level actions (e.g. delete-org once that lands).
 */

import type { FastifyInstance } from "fastify";
import type { AuthProvider } from "@altium-mcp/auth";
import { makeRequireAuth } from "./middleware.js";
import { requireOrgMember } from "./tenant.js";

export async function registerOrgRoutes(
  app: FastifyInstance,
  auth: AuthProvider
): Promise<void> {
  const requireAuth = makeRequireAuth(auth);

  // ── GET /api/orgs/:orgId/info ────────────────────────────────────────
  // Demo + smoke-test endpoint for the tenant-scope middleware. Returns
  // the org's basic info to any of its members. Cross-tenant access
  // attempts are rejected with 403 by `requireOrgMember`.
  app.get(
    "/api/orgs/:orgId/info",
    { preHandler: [requireAuth, requireOrgMember] },
    async (req) => {
      const ctx = req.ctx!;
      return {
        org: ctx.org,
        you: {
          userId: ctx.user.id,
          email: ctx.user.email,
          role: ctx.role,
        },
      };
    }
  );
}
