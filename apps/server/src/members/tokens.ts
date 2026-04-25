/**
 * Invite-token generation.
 *
 * Tokens are stored verbatim in the DB (Invite.token). That's a deliberate
 * deviation from the API-key model (sha256-hashed) — invite URLs need to
 * round-trip through the inviter so they can paste them into Slack, an
 * email, or wherever real email isn't yet wired up. Hashing would
 * prevent that copy-paste flow, so we lean on cryptographic randomness
 * instead: `crypto.randomBytes(32).toString('base64url')` is 43 url-safe
 * chars and 256 bits of entropy. Single-use, ttl = 7 days.
 *
 * Defense in depth:
 *   - Tokens never appear in audit logs (the `target` column gets the
 *     invite id, never the token).
 *   - Failed-accept responses don't echo the token back.
 *   - The accept handler does a constant-time-ish lookup by indexed
 *     unique column — DB does the work, no manual string compare.
 */

import { randomBytes } from "node:crypto";

export const INVITE_TOKEN_BYTES = 32;
export const INVITE_TTL_DAYS = 7;

/**
 * Returns a cryptographically random url-safe token. base64url is
 * URL-safe without further encoding so an `acceptUrl` like
 * `?token=${token}` doesn't need to call encodeURIComponent.
 */
export function generateInviteToken(): string {
  return randomBytes(INVITE_TOKEN_BYTES).toString("base64url");
}

export function inviteExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
}
