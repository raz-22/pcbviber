/**
 * Credential-at-rest encryption for Altium-MCP.
 *
 * Per the internal design spec §2.4:
 *   - AES-256-GCM
 *   - Master key from CREDENTIAL_ENCRYPTION_KEY env var (32 bytes base64)
 *   - Never log decrypted values
 *   - Never return decrypted values from any API handler
 *
 * The wire format for a stored credential is a single opaque string:
 *
 *   v1.<base64url(iv)>.<base64url(ciphertext)>.<base64url(authTag)>
 *
 * The `v1` prefix is the key-rotation marker: when we rotate the master
 * key we'll accept both `v1` and `v2` for a grace period, then sunset
 * `v1`. Never change v1's wire format without a migration.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const ALGO = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

const CURRENT_VERSION = "v1" as const;

/** Cached master key so we only base64-decode once per process. */
let cachedKey: Buffer | null = null;

function loadMasterKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "CREDENTIAL_ENCRYPTION_KEY is not set. Generate one with " +
        "`node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"` " +
        "and add it to .env (see packages/db/README.md)."
    );
  }
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `CREDENTIAL_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes ` +
        `(got ${buf.length}). Regenerate with a 32-byte source.`
    );
  }
  cachedKey = buf;
  return buf;
}

/**
 * Encrypt a secret (e.g. a Nexar client secret) for storage.
 * Returns a single opaque string safe for a VARCHAR column.
 */
export function encryptCredential(plaintext: string): string {
  if (typeof plaintext !== "string") {
    throw new TypeError("encryptCredential expects a string");
  }
  const key = loadMasterKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    CURRENT_VERSION,
    iv.toString("base64url"),
    ct.toString("base64url"),
    tag.toString("base64url"),
  ].join(".");
}

/**
 * Decrypt a credential previously produced by `encryptCredential`.
 * Throws on malformed input or tamper (GCM auth-tag mismatch).
 */
export function decryptCredential(encoded: string): string {
  if (typeof encoded !== "string" || !encoded) {
    throw new TypeError("decryptCredential expects a non-empty string");
  }
  const parts = encoded.split(".");
  if (parts.length !== 4) {
    throw new Error("decryptCredential: malformed payload (expected 4 parts)");
  }
  const [version, ivB64, ctB64, tagB64] = parts;
  if (version !== CURRENT_VERSION) {
    throw new Error(`decryptCredential: unsupported version '${version}'`);
  }
  const iv = Buffer.from(ivB64, "base64url");
  const ct = Buffer.from(ctB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");
  if (iv.length !== IV_BYTES) {
    throw new Error(`decryptCredential: wrong IV length (${iv.length})`);
  }
  if (tag.length !== TAG_BYTES) {
    throw new Error(`decryptCredential: wrong tag length (${tag.length})`);
  }

  const key = loadMasterKey();
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

/**
 * Constant-time comparison for hashed API keys. Exposed here so every
 * caller uses the same primitive.
 */
export function safeCompare(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Resets the cached master key. Only used by tests. */
export function __resetEncryptionCacheForTests(): void {
  cachedKey = null;
}
