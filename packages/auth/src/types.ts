/**
 * Shared auth types. Kept deliberately narrow — Sprint 1 only.
 * Roles, actions, and API-key shapes will land in Sprint 3.
 */

export type Role = "owner" | "admin" | "member" | "billing_only";

/**
 * Canonical user shape returned by any provider. Contains only the
 * fields the server + SPA need to render the logged-in state; never
 * includes password/secret material.
 */
export interface AuthUser {
  id: string;
  email: string;
  emailVerifiedAt: Date | null;
  /** Provider-specific id: WorkOS user id, or null for Local. */
  workosUserId: string | null;
  createdAt: Date;
}

/**
 * Opaque session handle. `sealed` is what the server puts in an
 * httpOnly cookie; `expiresAt` is the derived timestamp so the server
 * can set the cookie's Max-Age.
 */
export interface Session {
  sealed: string;
  userId: string;
  expiresAt: Date;
}

export interface SignupInput {
  email: string;
  password: string;
  /** Optional display name; providers may split into first/last. */
  name?: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface SignupResult {
  user: AuthUser;
  session: Session;
  /**
   * True when the provider created a new identity (Local always
   * returns true; WorkOS returns false if the email already existed
   * and matched the password).
   */
  isNewUser: boolean;
}

export interface LoginResult {
  user: AuthUser;
  session: Session;
}

/** Thrown by providers for auth failures. Never leak which field failed. */
export class AuthError extends Error {
  readonly code: AuthErrorCode;
  constructor(code: AuthErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = "AuthError";
  }
}

export type AuthErrorCode =
  | "invalid_credentials"
  | "email_taken"
  | "password_too_weak"
  | "session_expired"
  | "session_invalid"
  | "not_configured"
  | "provider_error";
