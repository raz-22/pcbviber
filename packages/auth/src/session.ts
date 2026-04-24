/**
 * Session sealing via HS256 JWT. Same signing key is reused across
 * providers (via WORKOS_COOKIE_PASSWORD) so a Local-mode dev session
 * and a Workos-mode prod session are indistinguishable from the
 * server's perspective — only the `issuer` claim differs.
 */

import { randomUUID } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";

const ACCESS_TTL_SECONDS = 15 * 60; // 15 min per §3.2 of the roadmap
const ISSUER_LOCAL = "altium-mcp/local";

let cachedKey: Uint8Array | null = null;

function loadSigningKey(): Uint8Array {
  if (cachedKey) return cachedKey;
  const raw = process.env.WORKOS_COOKIE_PASSWORD;
  if (!raw) {
    throw new Error(
      "WORKOS_COOKIE_PASSWORD is not set. This is the session signing key. " +
        "Generate with `node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"` " +
        "and add it to .env."
    );
  }
  const buf = Buffer.from(raw, "utf8");
  if (buf.length < 32) {
    throw new Error(
      `WORKOS_COOKIE_PASSWORD must be at least 32 bytes (got ${buf.length}). ` +
        "Regenerate with a longer source."
    );
  }
  cachedKey = new Uint8Array(buf);
  return cachedKey;
}

export interface SignedSession {
  sealed: string;
  sessionId: string;
  expiresAt: Date;
}

export interface VerifiedSession {
  userId: string;
  sessionId: string;
  issuedAt: Date;
  expiresAt: Date;
  issuer: string;
}

/**
 * Sign an access token for a user. Returns the sealed JWT plus the
 * sessionId (the server persists this in its revocation list when
 * one lands in Sprint 6).
 */
export async function signSession(
  userId: string,
  opts: { ttlSeconds?: number; issuer?: string } = {}
): Promise<SignedSession> {
  const ttl = opts.ttlSeconds ?? ACCESS_TTL_SECONDS;
  const issuer = opts.issuer ?? ISSUER_LOCAL;
  const sessionId = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const expSeconds = now + ttl;

  const jwt = await new SignJWT({ sid: sessionId })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(userId)
    .setIssuedAt(now)
    .setIssuer(issuer)
    .setExpirationTime(expSeconds)
    .sign(loadSigningKey());

  return { sealed: jwt, sessionId, expiresAt: new Date(expSeconds * 1000) };
}

/**
 * Verify a sealed session. Returns null on any failure — callers should
 * NOT distinguish expired from tampered in their 401 responses.
 */
export async function verifySignedSession(
  sealed: string,
  opts: { revokedSessionIds?: ReadonlySet<string> } = {}
): Promise<VerifiedSession | null> {
  if (typeof sealed !== "string" || !sealed) return null;
  try {
    const { payload } = await jwtVerify(sealed, loadSigningKey(), {
      algorithms: ["HS256"],
    });
    const sub = payload.sub;
    const sid = payload.sid;
    const iat = payload.iat;
    const exp = payload.exp;
    const iss = payload.iss;
    if (typeof sub !== "string" || typeof sid !== "string") return null;
    if (typeof iat !== "number" || typeof exp !== "number") return null;
    if (typeof iss !== "string") return null;
    if (opts.revokedSessionIds && opts.revokedSessionIds.has(sid)) return null;
    return {
      userId: sub,
      sessionId: sid,
      issuedAt: new Date(iat * 1000),
      expiresAt: new Date(exp * 1000),
      issuer: iss,
    };
  } catch {
    return null;
  }
}

/** Test-only: forget the cached signing key. */
export function __resetSessionCacheForTests(): void {
  cachedKey = null;
}
