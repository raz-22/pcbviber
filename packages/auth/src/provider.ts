/**
 * The single seam that separates "how we authenticate" from "how we
 * respond to an authenticated request." Everything on the server codes
 * against this interface. Swapping WorkOS for Local (or vice versa)
 * must require zero changes in routes or middleware.
 */

import type {
  AuthUser,
  LoginInput,
  LoginResult,
  Session,
  SignupInput,
  SignupResult,
} from "./types.js";

export interface AuthProvider {
  /** Short identifier for logs + startup banners. */
  readonly kind: "workos" | "local";

  /**
   * Create a new user account and return a fresh session.
   * Throws AuthError("email_taken") if the email is already registered.
   * Throws AuthError("password_too_weak") if password fails validation.
   */
  signup(input: SignupInput): Promise<SignupResult>;

  /**
   * Authenticate an existing user.
   * Throws AuthError("invalid_credentials") on any auth failure —
   * never discriminate "no such email" from "wrong password" in the
   * error. That's enumeration defense.
   */
  login(input: LoginInput): Promise<LoginResult>;

  /**
   * Verify a sealed session token and return the underlying user.
   * Returns null on any failure (expired, tampered, revoked). The
   * server interprets null as "log out and redirect to /login" — it
   * should not show a stack trace to users.
   */
  verifySession(sealed: string): Promise<AuthUser | null>;

  /**
   * Invalidate a session so it can no longer be used.
   * For stateless JWTs, this is best-effort (until revocation-list
   * support lands in Sprint 6). Local provider tracks invalidated
   * session ids in-memory; WorkOS calls its logout endpoint.
   */
  logout(sealed: string): Promise<void>;

  /**
   * Fetch a user by id. Used by middleware after verifying a session.
   * Returns null if the user no longer exists (deleted account).
   */
  getUser(userId: string): Promise<AuthUser | null>;

  /**
   * Issue a fresh session for an already-verified user. Used after
   * signup and after a refresh. Does NOT re-check credentials.
   */
  issueSession(userId: string): Promise<Session>;

  /**
   * Build the IdP authorization URL for an SSO redirect (SAML / OIDC
   * via WorkOS). Optional on providers that don't support SSO —
   * `LocalAuthProvider` returns null. Routes guard on the return
   * value before initiating an SSO flow.
   */
  startSso?(opts: {
    connectionId: string;
    redirectUri: string;
    state: string;
  }): string;

  /**
   * Complete an SSO callback by exchanging the IdP `code` for a
   * profile and creating a local session. Optional, paired with
   * `startSso`.
   */
  completeSsoCallback?(opts: { code: string }): Promise<{
    user: AuthUser;
    session: Session;
    isNewUser: boolean;
  }>;
}
