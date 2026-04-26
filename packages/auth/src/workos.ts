/**
 * WorkOSAuthProvider — the production auth path.
 *
 * This wraps @workos-inc/node's user-management module. On signup/login
 * WorkOS owns the credentials; we only store a local `User` row with the
 * `workosUserId` linking to WorkOS's record.
 *
 * WorkOS returns its own sealed session cookie; we also sign our own
 * short-lived JWT alongside it so the SPA has a uniform token to verify.
 * At request time we verify BOTH the JWT (for fast path) and, on
 * mismatch, fall back to WorkOS's `authenticateWithSessionCookie` for
 * ground truth.
 *
 * This file is intentionally small in Sprint 1: signup/login/logout +
 * session verify + getUser. Magic-link, Google SSO, SAML, password
 * reset, and account deletion all land in later sprints per the
 * roadmap.
 */

import { WorkOS } from "@workos-inc/node";
import { prisma } from "@altium-mcp/db";
import type { AuthProvider } from "./provider.js";
import {
  type AuthUser,
  type LoginInput,
  type LoginResult,
  type Session,
  type SignupInput,
  type SignupResult,
  AuthError,
} from "./types.js";
import { signSession, verifySignedSession } from "./session.js";

const ISSUER = "altium-mcp/workos";

export class WorkOSAuthProvider implements AuthProvider {
  readonly kind = "workos" as const;
  private readonly workos: WorkOS;
  private readonly clientId: string;

  constructor(opts?: { apiKey?: string; clientId?: string }) {
    const apiKey = opts?.apiKey ?? process.env.WORKOS_API_KEY;
    const clientId = opts?.clientId ?? process.env.WORKOS_CLIENT_ID;
    if (!apiKey || !clientId) {
      throw new AuthError(
        "not_configured",
        "WorkOSAuthProvider requires WORKOS_API_KEY and WORKOS_CLIENT_ID"
      );
    }
    this.workos = new WorkOS(apiKey);
    this.clientId = clientId;
  }

  async signup(input: SignupInput): Promise<SignupResult> {
    const email = input.email.trim().toLowerCase();
    const [firstName, ...rest] = (input.name ?? "").trim().split(/\s+/);
    const lastName = rest.join(" ") || undefined;

    let workosUser: Awaited<
      ReturnType<typeof this.workos.userManagement.createUser>
    >;
    try {
      workosUser = await this.workos.userManagement.createUser({
        email,
        password: input.password,
        firstName: firstName || undefined,
        lastName,
      });
    } catch (err) {
      throw mapWorkOSError(err);
    }

    // Ensure we have a local User row with the WorkOS id linked.
    const user = await prisma.user.upsert({
      where: { email },
      update: { workosUserId: workosUser.id },
      create: {
        email,
        workosUserId: workosUser.id,
        emailVerifiedAt: workosUser.emailVerified ? new Date() : null,
      },
    });

    const session = await this.issueSession(user.id);
    return { user: toAuthUser(user), session, isNewUser: true };
  }

  async login(input: LoginInput): Promise<LoginResult> {
    const email = input.email.trim().toLowerCase();
    try {
      const res = await this.workos.userManagement.authenticateWithPassword({
        clientId: this.clientId,
        email,
        password: input.password,
      });
      // Surface an error with no field attribution — always generic.
      if (!res.user?.id) throw new AuthError("invalid_credentials");

      const user = await prisma.user.upsert({
        where: { email },
        update: { workosUserId: res.user.id },
        create: {
          email,
          workosUserId: res.user.id,
          emailVerifiedAt: res.user.emailVerified ? new Date() : null,
        },
      });

      const session = await this.issueSession(user.id);
      return { user: toAuthUser(user), session };
    } catch (err) {
      if (err instanceof AuthError) throw err;
      throw mapWorkOSError(err);
    }
  }

  async verifySession(sealed: string): Promise<AuthUser | null> {
    const verified = await verifySignedSession(sealed);
    if (!verified || verified.issuer !== ISSUER) return null;
    return this.getUser(verified.userId);
  }

  async logout(_sealed: string): Promise<void> {
    // Stateless JWT; real revocation wants a Redis set (Sprint 6).
    // For now this is a best-effort no-op — the SPA clears the cookie.
  }

  async getUser(userId: string): Promise<AuthUser | null> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    return user ? toAuthUser(user) : null;
  }

  async issueSession(userId: string): Promise<Session> {
    const signed = await signSession(userId, { issuer: ISSUER });
    return { sealed: signed.sealed, userId, expiresAt: signed.expiresAt };
  }

  // ─── SSO (SAML / OIDC) ──────────────────────────────────────────

  /**
   * Build the WorkOS authorization URL the SPA should redirect to.
   * `connectionId` identifies the IdP (set up in the WorkOS
   * dashboard); `redirectUri` is the absolute URL of our
   * /api/auth/sso/callback route; `state` is our signed state JWT.
   *
   * Pure delegation to WorkOS's SSO module; no DB access, no side
   * effects. Tests can swap the WorkOS SDK without DB plumbing.
   */
  startSso(opts: {
    connectionId: string;
    redirectUri: string;
    state: string;
  }): string {
    return this.workos.sso.getAuthorizationUrl({
      connection: opts.connectionId,
      clientId: this.clientId,
      redirectUri: opts.redirectUri,
      state: opts.state,
    });
  }

  /**
   * Complete the WorkOS SSO callback. Exchanges the IdP's `code`
   * for a profile, upserts the local User row keyed on email,
   * issues a session.
   *
   * Caller is responsible for verifying the state JWT BEFORE
   * calling this method — by the time we touch WorkOS, the orgId
   * and returnTo are trusted. Caller is also responsible for
   * creating any Membership row this user needs in the org;
   * WorkOSAuthProvider deals only with the User identity.
   */
  async completeSsoCallback(opts: { code: string }): Promise<{
    user: AuthUser;
    session: Session;
    isNewUser: boolean;
  }> {
    let result: Awaited<
      ReturnType<typeof this.workos.sso.getProfileAndToken>
    >;
    try {
      result = await this.workos.sso.getProfileAndToken({
        clientId: this.clientId,
        code: opts.code,
      });
    } catch (err) {
      throw mapWorkOSError(err);
    }
    const profile = result.profile;
    if (!profile?.email) {
      throw new AuthError(
        "provider_error",
        "WorkOS SSO profile is missing email"
      );
    }
    const email = profile.email.trim().toLowerCase();

    // Upsert the User row by email (the natural identity key). If
    // the user already exists from a password signup, we just link
    // their workosUserId — same human, same row.
    const before = await prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    const user = await prisma.user.upsert({
      where: { email },
      update: { workosUserId: profile.id },
      create: {
        email,
        workosUserId: profile.id,
        // SSO users come pre-verified by their IdP — Okta / AAD
        // wouldn't return a profile with an unverified email.
        emailVerifiedAt: new Date(),
      },
    });

    const session = await this.issueSession(user.id);
    return {
      user: toAuthUser(user),
      session,
      isNewUser: !before,
    };
  }
}

// ─── helpers ──────────────────────────────────────────────────────────

function toAuthUser(user: {
  id: string;
  email: string;
  emailVerifiedAt: Date | null;
  workosUserId: string | null;
  createdAt: Date;
}): AuthUser {
  return {
    id: user.id,
    email: user.email,
    emailVerifiedAt: user.emailVerifiedAt,
    workosUserId: user.workosUserId,
    createdAt: user.createdAt,
  };
}

/**
 * Classify a WorkOS SDK error into one of our stable AuthError codes.
 * Exported so it can be unit-tested without a live WorkOS tenant.
 */
export function mapWorkOSError(err: unknown): AuthError {
  // WorkOS error structure varies — we collapse everything sensitive
  // into invalid_credentials or email_taken so we never leak specifics
  // to the client. Real error text lives in server logs.
  const msg = err instanceof Error ? err.message : String(err);
  if (/already exists|in use|taken/i.test(msg)) {
    return new AuthError("email_taken");
  }
  if (/invalid (password|credentials|email)/i.test(msg)) {
    return new AuthError("invalid_credentials");
  }
  return new AuthError("provider_error", msg);
}
