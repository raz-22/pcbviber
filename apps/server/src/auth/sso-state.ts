/**
 * Signed `state` parameter for the WorkOS SSO redirect.
 *
 * The state is what we send to WorkOS as opaque, then they bounce
 * back to /api/auth/sso/callback. We use it to:
 *
 *   1. Carry `orgId` so the callback knows which org's connection
 *      the inbound user belongs to.
 *   2. Carry an optional `returnTo` path so the callback can
 *      redirect the user where they intended after auth — without
 *      that being controlled by the SSO IdP, which is the
 *      open-redirect attack surface.
 *   3. Anti-replay / anti-CSRF: the JWT signature ties the state to
 *      OUR secret. An attacker can't construct a state for an
 *      arbitrary org without our signing key.
 *
 * TTL is short (10 minutes) — long enough for a normal IdP redirect
 * round-trip, short enough that a leaked state isn't usable.
 *
 * `returnTo` is constrained to relative paths starting with `/`
 * (and not `//` or `/\`). That blocks open-redirect via state
 * tampering even if our signing key were ever to leak.
 */

import { jwtVerify, SignJWT } from "jose";

const ISSUER = "altium-mcp/sso-state";
const TTL_SECONDS = 10 * 60;

let cachedKey: Uint8Array | null = null;

function loadKey(): Uint8Array {
  if (cachedKey) return cachedKey;
  const raw = process.env.WORKOS_COOKIE_PASSWORD;
  if (!raw) {
    throw new Error(
      "WORKOS_COOKIE_PASSWORD is not set. SSO state signing reuses the " +
        "session signing key; configure it in .env."
    );
  }
  const buf = Buffer.from(raw, "utf8");
  if (buf.length < 32) {
    throw new Error(
      `WORKOS_COOKIE_PASSWORD must be at least 32 bytes (got ${buf.length}).`
    );
  }
  cachedKey = new Uint8Array(buf);
  return cachedKey;
}

export interface SsoStatePayload {
  orgId: string;
  /** Absolute path within the SPA (must start with `/` and NOT `/[/\\]`). */
  returnTo: string;
}

/**
 * Sanitize a returnTo. Anything that doesn't pass returns `/`.
 * Defense in depth — we check at sign time AND verify time so a
 * caller-provided value can't smuggle through.
 */
export function safeReturnTo(raw: string | null | undefined): string {
  if (typeof raw !== "string" || raw.length === 0) return "/";
  // Must start with `/` and not `//` or `/\` (protocol-relative
  // attempts) and not contain `\r\n` (response-splitting).
  if (!raw.startsWith("/")) return "/";
  if (raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  if (raw.includes("\r") || raw.includes("\n")) return "/";
  // Keep length sane.
  if (raw.length > 256) return "/";
  return raw;
}

export async function signSsoState(payload: SsoStatePayload): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({
    orgId: payload.orgId,
    returnTo: safeReturnTo(payload.returnTo),
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(now)
    .setIssuer(ISSUER)
    .setExpirationTime(now + TTL_SECONDS)
    .sign(loadKey());
}

/**
 * Verify a state JWT. Returns the parsed payload or null on any
 * failure (expired, tampered, missing fields, invalid returnTo).
 * Callers MUST treat null as "drop the request" — never fall back
 * to a default org or returnTo.
 */
export async function verifySsoState(
  state: string
): Promise<SsoStatePayload | null> {
  if (typeof state !== "string" || state.length === 0) return null;
  try {
    const { payload } = await jwtVerify(state, loadKey(), {
      algorithms: ["HS256"],
      issuer: ISSUER,
    });
    const orgId = payload.orgId;
    const returnTo = payload.returnTo;
    if (typeof orgId !== "string" || orgId.length === 0) return null;
    if (typeof returnTo !== "string") return null;
    // Re-sanitize: a state signed with a misbehaving caller-set
    // returnTo shouldn't be trusted just because the signature is
    // valid. safeReturnTo collapses anything dodgy to `/`.
    return { orgId, returnTo: safeReturnTo(returnTo) };
  } catch {
    return null;
  }
}

/** Test-only: forget the cached signing key. */
export function __resetSsoStateCacheForTests(): void {
  cachedKey = null;
}
