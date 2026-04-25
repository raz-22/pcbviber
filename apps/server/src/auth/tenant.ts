/**
 * Tenant-scope middleware. Sprint 2 foundation per
 * the internal design spec §3.4 + §5 + §7.
 *
 * Every REST route that operates within an organization mounts under
 * `/api/orgs/:orgId/...` and chains `makeRequireOrgRole(allowed)` after
 * `makeRequireAuth`. The middleware loads the user's Membership in that
 * org, attaches `req.ctx = { user, org, role }`, and rejects with 403
 * if the user isn't a member or doesn't hold one of the allowed roles.
 *
 * Cross-tenant access is impossible: a user forging `:orgId` to one
 * they don't belong to gets a 403 with no information leak about
 * whether the org exists. The error path is the same as "you're not a
 * member" so the response timing doesn't enumerate orgs either.
 *
 * MCP transport tenant binding (API keys → org) is Sprint 3 work; that
 * lands in a separate file alongside `packages/auth`'s api-key module.
 */

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from "fastify";
import { prisma } from "@altium-mcp/db";
import type { AuthUser, Role } from "@altium-mcp/auth";

/**
 * Per-request tenant context. Attached by makeRequireOrgRole after
 * Membership is verified. Routes can rely on `req.ctx` being populated
 * — if the middleware didn't attach it, the request was already
 * rejected with 401/403/404.
 */
export interface RequestContext {
  user: AuthUser;
  org: { id: string; slug: string; name: string };
  role: Role;
}

declare module "fastify" {
  interface FastifyRequest {
    ctx?: RequestContext;
  }
}

/**
 * Factory: returns a Fastify preHandler that requires the calling user
 * to be a member of `:orgId` (URL param) AND hold one of the allowed
 * roles. Pass `[]` to allow any role.
 */
export function makeRequireOrgRole(
  allowedRoles: readonly Role[]
): preHandlerAsyncHookHandler {
  return async function requireOrgRole(req: FastifyRequest, reply: FastifyReply) {
    if (!req.user) {
      reply.code(401);
      throw new Error("not authenticated");
    }
    const params = req.params as { orgId?: string };
    const orgId = params?.orgId;
    if (!orgId || typeof orgId !== "string") {
      reply.code(400);
      throw new Error("missing :orgId in route");
    }

    const membership = await prisma.membership.findUnique({
      where: { orgId_userId: { orgId, userId: req.user.id } },
      include: { org: { select: { id: true, slug: true, name: true } } },
    });

    // Conflate "no such org" and "not a member" into a single 403 so
    // attackers can't enumerate org IDs by probing.
    if (!membership) {
      reply.code(403);
      throw new Error("forbidden");
    }
    if (
      allowedRoles.length > 0 &&
      !allowedRoles.includes(membership.role as Role)
    ) {
      reply.code(403);
      throw new Error("forbidden");
    }

    req.ctx = {
      user: req.user,
      org: {
        id: membership.org.id,
        slug: membership.org.slug,
        name: membership.org.name,
      },
      role: membership.role as Role,
    };
  };
}

/** Shorthand: any member (owner / admin / member / billing_only) is OK. */
export const requireOrgMember = makeRequireOrgRole([]);

/** Shorthand: only owner. */
export const requireOrgOwner = makeRequireOrgRole(["owner"]);

/** Shorthand: owner or admin (write actions on org settings). */
export const requireOrgAdmin = makeRequireOrgRole(["owner", "admin"]);

/**
 * Centralized error handler so every 401/403 from the middleware
 * surfaces as a stable JSON body the SPA can map. Mount once, after
 * `registerAuthRoutes` and before tenant-scoped routes:
 *
 *     installTenantErrorHandler(app);
 */
export function installTenantErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, _req, reply) => {
    const status = reply.statusCode;
    if (status === 401) {
      reply.code(401).send({ error: "not_authenticated" });
      return;
    }
    if (status === 403) {
      reply.code(403).send({ error: "forbidden" });
      return;
    }
    const message = err instanceof Error ? err.message : "";
    if (status === 400 && /missing :orgId/i.test(message)) {
      reply.code(400).send({ error: "missing_org_id" });
      return;
    }
    // Unknown error — keep Fastify's default behavior.
    reply.send(err);
  });
}
