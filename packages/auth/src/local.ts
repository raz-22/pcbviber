/**
 * LocalAuthProvider — the real, DB-backed auth implementation that
 * doesn't require a WorkOS account. Good enough for integration tests,
 * early dev, and the "no external services" fresh-clone path.
 *
 * Trade-offs vs. WorkOS:
 *   + No network, no signup-flow delay, no API keys to rotate.
 *   + Lets us build and exercise the server routes before anyone on
 *     the team has to touch workos.com.
 *   − No breached-password check, no Google SSO, no magic link (yet),
 *     no SAML. Single process for session revocation. Not production.
 */

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
import {
  hashPassword,
  verifyPassword,
  needsRehash,
  PasswordTooWeakError,
} from "./password.js";
import { signSession, verifySignedSession } from "./session.js";

/**
 * In-memory revocation set. Sprint-6 work moves this to Redis; until
 * then, logout only works for the process that handled the login.
 * Kept module-scoped (not on the instance) so the set is shared across
 * any number of LocalAuthProvider() constructions in-process.
 */
const revokedSessionIds = new Set<string>();

export class LocalAuthProvider implements AuthProvider {
  readonly kind = "local" as const;

  async signup(input: SignupInput): Promise<SignupResult> {
    const email = normalizeEmail(input.email);
    let passwordHash: string;
    try {
      passwordHash = await hashPassword(input.password);
    } catch (err) {
      if (err instanceof PasswordTooWeakError) {
        throw new AuthError("password_too_weak", err.message);
      }
      throw err;
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new AuthError("email_taken");
    }

    const user = await prisma.user.create({
      data: {
        email,
        passwordHashLocal: passwordHash,
        // Local provider treats the email as unverified until a flow
        // lands in Sprint 3; WorkOS handles verification for us.
        emailVerifiedAt: null,
      },
    });

    const session = await this.issueSession(user.id);
    return { user: toAuthUser(user), session, isNewUser: true };
  }

  async login(input: LoginInput): Promise<LoginResult> {
    const email = normalizeEmail(input.email);
    const user = await prisma.user.findUnique({ where: { email } });

    // Deliberate: do a scrypt run against a dummy hash even if the
    // email doesn't exist, so response timing doesn't leak user
    // existence. This costs one extra hash per failed login.
    const storedHash =
      user?.passwordHashLocal ??
      // Constant-looking valid hash. Decrypts to nothing useful.
      "scrypt$v1$N=32768,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const ok = await verifyPassword(input.password, storedHash);

    if (!user || !user.passwordHashLocal || !ok) {
      throw new AuthError("invalid_credentials");
    }

    // Opportunistic rehash if parameters have advanced.
    if (needsRehash(user.passwordHashLocal)) {
      const fresh = await hashPassword(input.password);
      await prisma.user.update({
        where: { id: user.id },
        data: { passwordHashLocal: fresh },
      });
    }

    const session = await this.issueSession(user.id);
    return { user: toAuthUser(user), session };
  }

  async verifySession(sealed: string): Promise<AuthUser | null> {
    const verified = await verifySignedSession(sealed, { revokedSessionIds });
    if (!verified) return null;
    if (verified.issuer !== "altium-mcp/local") return null;
    return this.getUser(verified.userId);
  }

  async logout(sealed: string): Promise<void> {
    const verified = await verifySignedSession(sealed, { revokedSessionIds });
    if (verified) revokedSessionIds.add(verified.sessionId);
  }

  async getUser(userId: string): Promise<AuthUser | null> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    return user ? toAuthUser(user) : null;
  }

  async issueSession(userId: string): Promise<Session> {
    const signed = await signSession(userId, { issuer: "altium-mcp/local" });
    return {
      sealed: signed.sealed,
      userId,
      expiresAt: signed.expiresAt,
    };
  }
}

// ─── helpers ──────────────────────────────────────────────────────────

function normalizeEmail(email: string): string {
  if (typeof email !== "string" || !email.includes("@")) {
    throw new AuthError("invalid_credentials", "email is required");
  }
  return email.trim().toLowerCase();
}

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

/** Test-only helper — clears the module-scoped revocation set. */
export function __resetLocalAuthRevocationForTests(): void {
  revokedSessionIds.clear();
}
