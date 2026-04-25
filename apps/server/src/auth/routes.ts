/**
 * /api/auth/* — signup, login, logout, me.
 *
 * Per the internal design spec §3.1, §3.2, §3.5:
 *   - signup auto-creates an Organization with the user as owner
 *   - logout clears the cookie + revokes the session
 *   - audit log written for: signup, login, logout
 *
 * The route handlers stay thin — auth provider work lives in
 * @altium-mcp/auth, org bootstrap lives in ./org.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type AuthProvider, AuthError } from "@altium-mcp/auth";
import { prisma } from "@altium-mcp/db";
import {
  SESSION_COOKIE,
  setSessionCookie,
  clearSessionCookie,
  makeRequireAuth,
} from "./middleware.js";
import { createOrgForOwner } from "./org.js";
import { writeAuditLog, clientIp } from "./audit.js";

const SignupBody = z.object({
  email: z.string().email(),
  password: z.string().min(1), // strength check is provider-side
  name: z.string().max(120).optional(),
  orgName: z.string().max(120).optional(),
});

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function registerAuthRoutes(
  app: FastifyInstance,
  auth: AuthProvider
): Promise<void> {
  const requireAuth = makeRequireAuth(auth);

  // ── Signup ──────────────────────────────────────────────────────────
  app.post("/api/auth/signup", async (req, reply) => {
    const parsed = SignupBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid_input", detail: parsed.error.flatten() };
    }
    try {
      const { user, session } = await auth.signup(parsed.data);
      // If org-create fails after a successful provider.signup we'd
      // otherwise leave a User row with no Membership — every future
      // signup attempt with that email would 409. Roll back the User
      // so the email becomes available again. Memberships cascade
      // from User, so this is a single clean delete.
      let org: Awaited<ReturnType<typeof createOrgForOwner>>;
      try {
        org = await createOrgForOwner({
          userId: user.id,
          orgName: parsed.data.orgName,
          email: user.email,
        });
      } catch (orgErr) {
        try {
          await prisma.user.delete({ where: { id: user.id } });
        } catch {
          // Best-effort. If even the rollback fails, the user is in a
          // wedged state but at least we surface the original error.
        }
        throw orgErr;
      }

      await writeAuditLog({
        orgId: org.orgId,
        actorUserId: user.id,
        action: "signup",
        target: org.orgSlug,
        ip: clientIp(req),
        userAgent: req.headers["user-agent"],
      });

      setSessionCookie(reply, session.sealed, session.expiresAt);
      return {
        user: serializeUser(user),
        org: {
          id: org.orgId,
          slug: org.orgSlug,
          name: org.orgName,
          billingStatus: org.billingStatus,
          trialEndsAt: org.trialEndsAt,
        },
      };
    } catch (err) {
      return mapAuthError(reply, err);
    }
  });

  // ── Login ───────────────────────────────────────────────────────────
  app.post("/api/auth/login", async (req, reply) => {
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid_input", detail: parsed.error.flatten() };
    }
    try {
      const { user, session } = await auth.login(parsed.data);
      const memberships = await prisma.membership.findMany({
        where: { userId: user.id },
        include: { org: { select: { id: true, slug: true, name: true } } },
        orderBy: { createdAt: "asc" },
      });

      // Anchor login to the user's first org for the audit row. Most
      // users have exactly one (auto-created at signup); this works the
      // same for them and for invited members.
      const anchorOrgId = memberships[0]?.org.id;
      if (anchorOrgId) {
        await writeAuditLog({
          orgId: anchorOrgId,
          actorUserId: user.id,
          action: "login",
          ip: clientIp(req),
          userAgent: req.headers["user-agent"],
        });
      }

      setSessionCookie(reply, session.sealed, session.expiresAt);
      return {
        user: serializeUser(user),
        orgs: memberships.map((m) => ({
          id: m.org.id,
          slug: m.org.slug,
          name: m.org.name,
          role: m.role,
        })),
      };
    } catch (err) {
      return mapAuthError(reply, err);
    }
  });

  // ── Logout ──────────────────────────────────────────────────────────
  app.post("/api/auth/logout", async (req, reply) => {
    const sealed = req.cookies?.[SESSION_COOKIE];
    if (sealed) {
      // Best-effort; never block the logout response.
      try {
        const user = await auth.verifySession(sealed);
        if (user) {
          const m = await prisma.membership.findFirst({ where: { userId: user.id } });
          if (m) {
            await writeAuditLog({
              orgId: m.orgId,
              actorUserId: user.id,
              action: "logout",
              ip: clientIp(req),
              userAgent: req.headers["user-agent"],
            });
          }
        }
        await auth.logout(sealed);
      } catch {
        // logout should never 500
      }
    }
    clearSessionCookie(reply);
    return { ok: true };
  });

  // ── Me ──────────────────────────────────────────────────────────────
  app.get(
    "/api/auth/me",
    { preHandler: requireAuth },
    async (req) => {
      const user = req.user!;
      return {
        user: serializeUser(user),
        orgs: (req.memberships ?? []).map((m) => ({
          id: m.orgId,
          slug: m.orgSlug,
          name: m.orgName,
          role: m.role,
          billingStatus: m.billingStatus,
          trialEndsAt: m.trialEndsAt,
        })),
      };
    }
  );
}

// ─── helpers ──────────────────────────────────────────────────────────

function serializeUser(user: { id: string; email: string; emailVerifiedAt: Date | null; createdAt: Date }) {
  return {
    id: user.id,
    email: user.email,
    emailVerifiedAt: user.emailVerifiedAt ? user.emailVerifiedAt.toISOString() : null,
    createdAt: user.createdAt.toISOString(),
  };
}

// `writeAuditLog` and `clientIp` were extracted to ./audit.ts in
// Sprint 2 PR 2.2 so workspace + future routes share the same audit
// vocabulary and bounded-input handling.

function mapAuthError(reply: import("fastify").FastifyReply, err: unknown) {
  if (err instanceof AuthError) {
    switch (err.code) {
      case "email_taken":
        reply.code(409);
        return { error: "email_taken" };
      case "password_too_weak":
        reply.code(400);
        return { error: "password_too_weak", detail: err.message };
      case "invalid_credentials":
      case "session_invalid":
      case "session_expired":
        reply.code(401);
        return { error: "invalid_credentials" };
      case "not_configured":
        reply.code(503);
        return { error: "auth_not_configured" };
      default:
        reply.code(500);
        return { error: "provider_error" };
    }
  }
  reply.code(500);
  return { error: "internal_error" };
}
