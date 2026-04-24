/**
 * Password hashing using Node's built-in scrypt. No external deps, no
 * native bindings needed. Parameters are stored with the hash so we can
 * increase them without breaking existing users — on successful login
 * with old params, the server re-hashes before returning.
 *
 * Wire format:
 *   scrypt$v1$N=<N>,r=<r>,p=<p>$<salt_b64url>$<hash_b64url>
 */

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { ScryptOptions } from "node:crypto";

/**
 * Promise wrapper around node's scrypt that actually types the options
 * overload. `util.promisify(scrypt)` only surfaces the 3-arg signature
 * from lib.d.ts.
 */
function scryptAsync(
  password: string,
  salt: Buffer,
  keyLen: number,
  opts: ScryptOptions
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLen, opts, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

const CURRENT_N = 32768; // 2^15 — ~100ms on a modern laptop core
const CURRENT_R = 8;
const CURRENT_P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;
const MAX_N = 1 << 20; // 2^20 — sanity cap so malicious params can't DOS us

/**
 * scrypt memory requirement is 128 * N * r bytes. At our defaults this
 * is exactly 32 MiB — Node's `maxmem` default is also 32 MiB, which
 * leaves no margin for internal state and triggers
 * "memory limit exceeded". Bump the ceiling to 128 MiB so current
 * params work and any sane future bump still fits. MAX_N caps the
 * other direction (malicious input can't blow us out of this).
 */
const SCRYPT_MAXMEM = 128 * 1024 * 1024;

/** Reasonable-but-not-draconian floor on password strength. */
const MIN_PASSWORD_BYTES = 12;

export function validatePasswordStrength(password: string): void {
  if (typeof password !== "string") {
    throw new TypeError("password must be a string");
  }
  // Measured in bytes, not characters, to avoid surprises with unicode.
  if (Buffer.byteLength(password, "utf8") < MIN_PASSWORD_BYTES) {
    throw new PasswordTooWeakError(
      `password must be at least ${MIN_PASSWORD_BYTES} bytes`
    );
  }
}

export class PasswordTooWeakError extends Error {
  readonly code = "password_too_weak";
}

export async function hashPassword(password: string): Promise<string> {
  validatePasswordStrength(password);
  const salt = randomBytes(SALT_LEN);
  const hash = await scryptAsync(password, salt, KEY_LEN, {
    N: CURRENT_N,
    r: CURRENT_R,
    p: CURRENT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return [
    "scrypt",
    "v1",
    `N=${CURRENT_N},r=${CURRENT_R},p=${CURRENT_P}`,
    salt.toString("base64url"),
    hash.toString("base64url"),
  ].join("$");
}

/**
 * Verifies a candidate password against a stored hash. Runs in
 * constant time regardless of whether the hash is valid.
 */
export async function verifyPassword(
  candidate: string,
  stored: string
): Promise<boolean> {
  const parsed = parseStoredHash(stored);
  if (!parsed) return false;
  let computed: Buffer;
  try {
    computed = await scryptAsync(candidate, parsed.salt, parsed.hash.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: SCRYPT_MAXMEM,
    });
  } catch {
    return false;
  }
  if (computed.length !== parsed.hash.length) return false;
  return timingSafeEqual(computed, parsed.hash);
}

/**
 * Returns true when the stored hash uses parameters weaker than the
 * current defaults — callers should re-hash with `hashPassword()` after
 * a successful login.
 */
export function needsRehash(stored: string): boolean {
  const parsed = parseStoredHash(stored);
  if (!parsed) return true;
  return parsed.N < CURRENT_N || parsed.r < CURRENT_R || parsed.p < CURRENT_P;
}

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

function parseStoredHash(stored: string): ParsedHash | null {
  if (typeof stored !== "string") return null;
  const parts = stored.split("$");
  if (parts.length !== 5) return null;
  const [algo, version, params, saltB64, hashB64] = parts;
  if (algo !== "scrypt" || version !== "v1") return null;

  const paramMap: Record<string, number> = {};
  for (const kv of params.split(",")) {
    const [k, v] = kv.split("=");
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    paramMap[k] = n;
  }
  const N = paramMap.N;
  const r = paramMap.r;
  const p = paramMap.p;
  if (!N || !r || !p) return null;
  // Guard against a malicious hash triggering a huge allocation.
  if (N > MAX_N || r > 16 || p > 16) return null;

  try {
    return {
      N,
      r,
      p,
      salt: Buffer.from(saltB64, "base64url"),
      hash: Buffer.from(hashB64, "base64url"),
    };
  } catch {
    return null;
  }
}
