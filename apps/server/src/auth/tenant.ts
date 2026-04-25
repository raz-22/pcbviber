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
    workspace?: WorkspaceContext;
  }
}

/**
 * Per-request workspace context. Attached by makeRequireWorkspace
 * after the workspace has been verified to belong to the current
 * org (req.ctx must already be populated; route chains:
 *   [requireAuth, requireOrgMember, makeRequireWorkspace()]
 * ).
 */
export interface WorkspaceContext {
  id: string;
  orgId: string;
  altiumWorkspaceUrl: string | null;
  hasNexarCredentials: boolean;
}

/**
 * Canonical list of role strings we honor. The Membership.role column
 * is `String` at the schema level (chosen for SQLite portability —
 * Postgres switch to a CHECK constraint or enum is Sprint 6 work), so
 * defense-in-depth against a corrupt row lives here in the middleware.
 */
const KNOWN_ROLES: readonly Role[] = [
  "owner",
  "admin",
  "member",
  "billing_only",
];

function asKnownRole(role: string): Role | null {
  return (KNOWN_ROLES as readonly string[]).includes(role)
    ? (role as Role)
    : null;
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

    const role = asKnownRole(membership.role);
    if (!role) {
      // Defense in depth: a corrupt role string in the DB ("admIn",
      // "superadmin", "") must not silently bypass the role check.
      // Fail closed — same 403 the user would see if they weren't a
      // member at all.
      reply.code(403);
      throw new Error("forbidden");
    }
    if (allowedRoles.length > 0 && !allowedRoles.includes(role)) {
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
      role,
    };
  };
}

/** Shorthand: any member (owner / admin / member / billing_only) is OK. */
export const requireOrgMember = makeRequireOrgRole([]);

/**
 * Factory: returns a Fastify preHandler that loads the `:workspaceId`
 * URL param and asserts it belongs to the current `req.ctx.org`.
 *
 * Must run AFTER makeRequireOrgRole — it relies on `req.ctx`. Order
 * inside the route's preHandler array:
 *   [requireAuth, requireOrgMember, makeRequireWorkspace()]
 *
 * On success: attaches `req.workspace` (id, orgId, public metadata).
 * On failure: 404 — never 403 — so the response shape is identical
 * between "doesn't exist" and "exists but belongs to another org",
 * preventing workspace-id enumeration just like the cross-org check
 * in makeRequireOrgRole.
 */
export function makeRequireWorkspace(): preHandlerAsyncHookHandler {
  // We import prisma at call time so we don't pay the cost on every
  // module load and so factory tests can swap globals.
  return async function requireWorkspace(req: FastifyRequest, reply: FastifyReply) {
    if (!req.ctx) {
      // Programmer error: the chain is wrong. Fail loudly.
      reply.code(500);
      throw new Error("makeRequireWorkspace called without req.ctx");
    }
    const params = req.params as { workspaceId?: string };
    const workspaceId = params?.workspaceId;
    if (!workspaceId || typeof workspaceId !== "string") {
      reply.code(400);
      throw new Error("missing :workspaceId in route");
    }

    const ws = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        id: true,
        orgId: true,
        altiumWorkspaceUrl: true,
        nexarClientIdEnc: true,
        nexarClientSecretEnc: true,
      },
    });
    if (!ws || ws.orgId !== req.ctx.org.id) {
      reply.code(404);
      throw new Error("workspace not found");
    }

    req.workspace = {
      id: ws.id,
      orgId: ws.orgId,
      altiumWorkspaceUrl: ws.altiumWorkspaceUrl,
      hasNexarCredentials: !!(ws.nexarClientIdEnc && ws.nexarClientSecretEnc),
    };
  };
}

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
    if (status === 400 && /missing :workspaceId/i.test(message)) {
      reply.code(400).send({ error: "missing_workspace_id" });
      return;
    }
    if (status === 404 && /workspace not found/i.test(message)) {
      reply.code(404).send({ error: "not_found" });
      return;
    }
    // Unknown error — keep Fastify's default behavior.
    reply.send(err);
  });
}
