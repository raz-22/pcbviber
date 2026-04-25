/**
 * Session-cookie middleware for Fastify.
 *
 * Reads `session` from the cookie, verifies it through the configured
 * AuthProvider, attaches the resolved AuthUser + the user's org
 * memberships to the request. Two flavors:
 *
 *   requireAuth  — 401 if not signed in
 *   optionalAuth — attach if present, never reject
 *
 * Both are factory functions because the AuthProvider isn't known at
 * import time (env-gated). Callers wire one auth instance per process.
 */

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from "fastify";
import type { AuthProvider, AuthUser } from "@altium-mcp/auth";
import { prisma } from "@altium-mcp/db";

export const SESSION_COOKIE = "session";

/**
 * Membership view we attach to req. Sprint-2 RLS / authz will use the
 * `role` per org; for Sprint 1 we only need orgId so /api/auth/me can
 * surface "your organization."
 */
export interface RequestMembership {
  orgId: string;
  orgSlug: string;
  orgName: string;
  role: string;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Set by optionalAuth/requireAuth when a valid session is present. */
    user?: AuthUser;
    memberships?: RequestMembership[];
  }
}

export function makeOptionalAuth(
  auth: AuthProvider
): preHandlerAsyncHookHandler {
  return async function optionalAuth(req: FastifyRequest) {
    const sealed = req.cookies?.[SESSION_COOKIE];
    if (!sealed) return;
    const user = await auth.verifySession(sealed);
    if (!user) return;
    req.user = user;
    req.memberships = await loadMemberships(user.id);
  };
}

export function makeRequireAuth(
  auth: AuthProvider
): preHandlerAsyncHookHandler {
  return async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
    const sealed = req.cookies?.[SESSION_COOKIE];
    if (!sealed) {
      reply.code(401);
      throw new Error("not authenticated");
    }
    const user = await auth.verifySession(sealed);
    if (!user) {
      // Stale cookie — clear it so the SPA's next request retries clean.
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      reply.code(401);
      throw new Error("session expired");
    }
    req.user = user;
    req.memberships = await loadMemberships(user.id);
  };
}

async function loadMemberships(userId: string): Promise<RequestMembership[]> {
  const rows = await prisma.membership.findMany({
    where: { userId },
    include: { org: { select: { id: true, slug: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((m) => ({
    orgId: m.org.id,
    orgSlug: m.org.slug,
    orgName: m.org.name,
    role: m.role,
  }));
}

/**
 * Set the session cookie. `Secure` only in production — local dev runs
 * over plain http://localhost which would otherwise reject the cookie.
 */
export function setSessionCookie(
  reply: FastifyReply,
  sealed: string,
  expiresAt: Date
): void {
  const maxAge = Math.max(
    1,
    Math.floor((expiresAt.getTime() - Date.now()) / 1000)
  );
  reply.setCookie(SESSION_COOKIE, sealed, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
}

/** Helper for callers that want to ensure cookie support is registered. */
export async function ensureCookiePlugin(app: FastifyInstance): Promise<void> {
  // @fastify/cookie is registered idempotently by the bootstrapper;
  // this helper exists for tests so they can register cookie support
  // independently without coupling to startHttpServer.
  if (typeof app.parseCookie === "function") return;
  const cookie = await import("@fastify/cookie");
  await app.register(cookie.default ?? cookie);
}
