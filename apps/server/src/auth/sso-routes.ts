/**
 * SAML / OIDC SSO routes (spec §3.1).
 *
 *   GET /api/auth/sso/start?orgSlug=&returnTo=
 *     Look up the org's workosConnectionId, sign a state JWT,
 *     302 to the WorkOS authorization URL.
 *
 *   GET /api/auth/sso/callback?code=&state=
 *     Verify the state, exchange the code with WorkOS, upsert
 *     User + Membership, set the session cookie, 302 to state.returnTo.
 *
 * Both routes are env-gated: when WORKOS_API_KEY is unset (LocalAuth
 * is the active provider), they 503 with `sso_not_configured`. The
 * SPA login button hides the SSO option in that mode by reading the
 * `/api/health` response — which is a follow-up; for now the button
 * surfaces a clean error.
 *
 * Per-org enablement: an org is SSO-eligible iff
 * `Organization.workosConnectionId` is set. Today operators set this
 * via the admin CLI / direct DB write; self-service connection
 * management UI lands in PR 7.3b.
 *
 * Security:
 *   - State is a signed JWT (anti-CSRF + anti-open-redirect).
 *     `returnTo` is sanitized to a relative path twice (sign-time
 *     AND verify-time) to defend against signing-key compromise.
 *   - Callback runs as the admin role for the User upsert + the
 *     subsequent Membership lookup; we do NOT use withTenantTx
 *     here because the user has no req.ctx yet (same shape as
 *     /api/invites/:token/accept).
 *   - SSO-authenticated users are auto-added as `member` of the
 *     org on first login. The IdP is the source of truth for "who
 *     works here"; the WorkOS connection is provisioned per-org by
 *     an admin, so anyone the IdP authenticates IS a member.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type AuthProvider, AuthError } from "@altium-mcp/auth";
import { prisma } from "@altium-mcp/db";
import {
  setSessionCookie,
} from "./middleware.js";
import { writeAuditLog, clientIp } from "./audit.js";
import { signSsoState, verifySsoState, safeReturnTo } from "./sso-state.js";

const StartQuery = z.object({
  orgSlug: z.string().min(1).max(64),
  returnTo: z.string().max(256).optional(),
});

const CallbackQuery = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

export async function registerSsoRoutes(
  app: FastifyInstance,
  auth: AuthProvider
): Promise<void> {
  // Compute the absolute redirect URI once. WorkOS rejects mismatches
  // — the URL configured in the WorkOS dashboard MUST equal what we
  // pass at start-time, byte-for-byte. Reading APP_BASE_URL from env
  // keeps prod / staging / dev flexible.
  function buildRedirectUri(): string {
    const base = process.env.APP_BASE_URL ?? "http://127.0.0.1:3000";
    return `${base.replace(/\/+$/, "")}/api/auth/sso/callback`;
  }

  app.get("/api/auth/sso/start", async (req, reply) => {
    const parsed = StartQuery.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid_input", detail: parsed.error.flatten() };
    }
    if (!auth.startSso) {
      // LocalAuthProvider doesn't support SSO. Same response shape as
      // an unconfigured WorkOS deployment — keeps the SPA error map
      // simple.
      reply.code(503);
      return { error: "sso_not_configured" };
    }

    const org = await prisma.organization.findUnique({
      where: { slug: parsed.data.orgSlug },
      select: { id: true, slug: true, workosConnectionId: true, deletedAt: true },
    });
    if (!org || org.deletedAt) {
      // 404 + a stable code. We do NOT distinguish "no such org" from
      // "org has no SSO" — that would let a probe enumerate orgs by
      // their SSO status.
      reply.code(404);
      return { error: "sso_not_configured" };
    }
    if (!org.workosConnectionId) {
      reply.code(404);
      return { error: "sso_not_configured" };
    }

    const state = await signSsoState({
      orgId: org.id,
      returnTo: safeReturnTo(parsed.data.returnTo),
    });

    const url = auth.startSso({
      connectionId: org.workosConnectionId,
      redirectUri: buildRedirectUri(),
      state,
    });

    // 302 to the IdP. WorkOS handles the rest until the IdP redirects
    // back to our /callback.
    reply.redirect(url, 302);
  });

  app.get("/api/auth/sso/callback", async (req, reply) => {
    const parsed = CallbackQuery.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid_input", detail: parsed.error.flatten() };
    }
    if (!auth.completeSsoCallback) {
      reply.code(503);
      return { error: "sso_not_configured" };
    }

    const verified = await verifySsoState(parsed.data.state);
    if (!verified) {
      // Tampered or expired state. Don't echo back why — that would
      // help an attacker craft a working state.
      reply.code(400);
      return { error: "sso_state_invalid" };
    }

    // Re-confirm the org still exists + still has SSO enabled at
    // callback time. An admin who disabled SSO between start and
    // callback shouldn't accidentally auth a user via the now-stale
    // state.
    const org = await prisma.organization.findUnique({
      where: { id: verified.orgId },
      select: { id: true, slug: true, workosConnectionId: true, deletedAt: true },
    });
    if (!org || org.deletedAt || !org.workosConnectionId) {
      reply.code(400);
      return { error: "sso_not_configured" };
    }

    let result: Awaited<ReturnType<NonNullable<typeof auth.completeSsoCallback>>>;
    try {
      result = await auth.completeSsoCallback({ code: parsed.data.code });
    } catch (err) {
      if (err instanceof AuthError) {
        reply.code(401);
        return { error: "sso_callback_failed", detail: err.message };
      }
      throw err;
    }
    const { user, session, isNewUser } = result;

    // Ensure the SSO-authenticated user has a Membership in the org
    // the IdP authenticated them for. Idempotent — re-login of an
    // existing member is a no-op on this row.
    const existingMembership = await prisma.membership.findUnique({
      where: { orgId_userId: { orgId: org.id, userId: user.id } },
      select: { id: true },
    });
    if (!existingMembership) {
      await prisma.membership.create({
        data: { orgId: org.id, userId: user.id, role: "member" },
      });
    }

    await writeAuditLog({
      orgId: org.id,
      actorUserId: user.id,
      action: isNewUser ? "sso.signup" : "sso.login",
      ip: clientIp(req),
      userAgent: req.headers["user-agent"],
      metadata: {
        connectionId: org.workosConnectionId,
        firstMembership: !existingMembership,
      },
    });

    setSessionCookie(reply, session.sealed, session.expiresAt);
    reply.redirect(verified.returnTo, 302);
  });
}
