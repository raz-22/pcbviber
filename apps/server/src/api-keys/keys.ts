/**
 * API key generation + hashing.
 *
 * Plaintext shape: `pcb_<43 url-safe base64 chars>` — 32 bytes of
 * randomness (256 bits) plus a 4-char prefix. The prefix makes leaked
 * keys easy to grep for and lets the SPA preview a key by its first
 * few chars without round-tripping the plaintext.
 *
 * Storage: only sha256 of the plaintext (`hashedKey` column, indexed
 * + unique). The plaintext is shown to the inviter exactly once at
 * creation and never thereafter; the server cannot recover it.
 *
 * Verification (PR 3.4): incoming `Authorization: Bearer <plaintext>`
 * → sha256 → DB lookup by hashedKey. Constant-time compare isn't
 * needed because the lookup is by indexed unique column; the DB
 * returns the row or null without timing-leak on the comparison.
 *
 * Why not bcrypt/scrypt: those are slow ON PURPOSE for low-entropy
 * passwords. API keys are 256 bits of CSPRNG output — there's nothing
 * to brute-force. Fast hash is correct here.
 */

import { createHash, randomBytes } from "node:crypto";

export const API_KEY_PREFIX = "pcb_";
export const API_KEY_BYTES = 32;

export interface GeneratedApiKey {
  /** Plaintext, returned to the caller exactly once. NEVER logged. */
  plaintext: string;
  /** sha256(plaintext). Stored in ApiKey.hashedKey. */
  hash: string;
  /**
   * First 8 chars after the prefix, useful as a UI hint
   * ("pcb_aBc12..."). Not enough to identify a key on its own —
   * still requires the full 32-byte body to authenticate.
   */
  preview: string;
}

export function generateApiKey(): GeneratedApiKey {
  const random = randomBytes(API_KEY_BYTES).toString("base64url");
  const plaintext = `${API_KEY_PREFIX}${random}`;
  const hash = hashApiKey(plaintext);
  const preview = `${API_KEY_PREFIX}${random.slice(0, 8)}`;
  return { plaintext, hash, preview };
}

/**
 * sha256 of the plaintext. Exported so PR 3.4's MCP-transport auth
 * middleware can hash the incoming bearer token before the DB lookup.
 */
export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}
