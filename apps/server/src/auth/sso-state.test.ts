/**
 * Pure-function tests for the SSO state JWT helper. No DB, no
 * Fastify; sets WORKOS_COOKIE_PASSWORD inline so the helper has a
 * signing key.
 */

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

let signSsoState: typeof import("./sso-state.js").signSsoState;
let verifySsoState: typeof import("./sso-state.js").verifySsoState;
let safeReturnTo: typeof import("./sso-state.js").safeReturnTo;
let __reset: typeof import("./sso-state.js").__resetSsoStateCacheForTests;

before(async () => {
  process.env.WORKOS_COOKIE_PASSWORD = randomBytes(48).toString("base64");
  ({ signSsoState, verifySsoState, safeReturnTo, __resetSsoStateCacheForTests: __reset } =
    await import("./sso-state.js"));
});

beforeEach(() => {
  __reset();
});

// ─── safeReturnTo ───────────────────────────────────────────────────

test("safeReturnTo: empty / null / undefined → '/'", () => {
  assert.equal(safeReturnTo(undefined), "/");
  assert.equal(safeReturnTo(null), "/");
  assert.equal(safeReturnTo(""), "/");
});

test("safeReturnTo: relative path passes through", () => {
  assert.equal(safeReturnTo("/settings/audit"), "/settings/audit");
  assert.equal(safeReturnTo("/"), "/");
});

test("safeReturnTo: protocol-relative attempts collapse to '/'", () => {
  // `//evil.com/path` is a classic open-redirect — the browser would
  // follow it as an absolute URL.
  assert.equal(safeReturnTo("//evil.com/foo"), "/");
  // Backslash variants caught by some servers but not all.
  assert.equal(safeReturnTo("/\\evil.com"), "/");
});

test("safeReturnTo: absolute URLs collapse to '/'", () => {
  assert.equal(safeReturnTo("https://evil.com"), "/");
  assert.equal(safeReturnTo("http://malicious.test/path"), "/");
  assert.equal(safeReturnTo("javascript:alert(1)"), "/");
});

test("safeReturnTo: response-splitting (CR/LF) collapses to '/'", () => {
  assert.equal(safeReturnTo("/foo\r\nLocation: evil"), "/");
  assert.equal(safeReturnTo("/foo\nbar"), "/");
});

test("safeReturnTo: paths longer than 256 chars collapse to '/'", () => {
  assert.equal(safeReturnTo("/" + "x".repeat(300)), "/");
});

// ─── sign / verify round-trip ───────────────────────────────────────

test("signSsoState then verifySsoState round-trips orgId + returnTo", async () => {
  const state = await signSsoState({
    orgId: "org_abc",
    returnTo: "/settings/audit",
  });
  const verified = await verifySsoState(state);
  assert.ok(verified);
  assert.equal(verified!.orgId, "org_abc");
  assert.equal(verified!.returnTo, "/settings/audit");
});

test("verifySsoState: tampered state returns null", async () => {
  const state = await signSsoState({ orgId: "org_abc", returnTo: "/" });
  // Flip a character in the signature segment.
  const dot = state.lastIndexOf(".");
  const tampered = state.slice(0, dot + 1) + "Aaa" + state.slice(dot + 4);
  assert.equal(await verifySsoState(tampered), null);
});

test("verifySsoState: empty / non-string input returns null", async () => {
  assert.equal(await verifySsoState(""), null);
  // @ts-expect-error — defensive: API takes string but real-world
  // callers passing query params can yield other types pre-validation.
  assert.equal(await verifySsoState(undefined), null);
});

test("verifySsoState: state signed with a different key returns null", async () => {
  // Sign with the current key, then rotate the key and verify.
  const state = await signSsoState({ orgId: "org_abc", returnTo: "/" });
  process.env.WORKOS_COOKIE_PASSWORD = randomBytes(48).toString("base64");
  __reset();
  assert.equal(await verifySsoState(state), null);
});

test("verifySsoState: a valid-signature state with bad returnTo collapses on the way out", async () => {
  // Defense in depth: even if a future attacker found the signing key
  // and crafted a state with a malicious returnTo, verify-time
  // sanitization catches it.
  const { SignJWT } = await import("jose");
  const key = new Uint8Array(
    Buffer.from(process.env.WORKOS_COOKIE_PASSWORD!, "utf8")
  );
  const malicious = await new SignJWT({
    orgId: "org_abc",
    returnTo: "//evil.com",
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setIssuer("altium-mcp/sso-state")
    .setExpirationTime("10m")
    .sign(key);
  const verified = await verifySsoState(malicious);
  assert.ok(verified, "malicious-but-validly-signed state still parses");
  assert.equal(
    verified!.returnTo,
    "/",
    "but the open-redirect target is collapsed"
  );
});

test("verifySsoState: state with wrong issuer returns null", async () => {
  // A state signed for a different purpose (e.g. session JWT signed
  // with the same key but issuer 'altium-mcp/local') must not be
  // accepted as an SSO state. jose enforces issuer when we set it
  // in the verify call.
  const { SignJWT } = await import("jose");
  const key = new Uint8Array(
    Buffer.from(process.env.WORKOS_COOKIE_PASSWORD!, "utf8")
  );
  const wrongIssuer = await new SignJWT({
    orgId: "org_abc",
    returnTo: "/",
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setIssuer("altium-mcp/local") // session issuer, not sso-state
    .setExpirationTime("10m")
    .sign(key);
  assert.equal(await verifySsoState(wrongIssuer), null);
});
