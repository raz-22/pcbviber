/**
 * Session signing/verification tests.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  signSession,
  verifySignedSession,
  __resetSessionCacheForTests,
} from "./session.js";

before(() => {
  process.env.WORKOS_COOKIE_PASSWORD = randomBytes(48).toString("base64");
  __resetSessionCacheForTests();
});

test("round-trip: sign then verify returns the user id", async () => {
  const { sealed, sessionId } = await signSession("user_abc");
  const v = await verifySignedSession(sealed);
  assert.ok(v);
  assert.equal(v.userId, "user_abc");
  assert.equal(v.sessionId, sessionId);
  assert.equal(v.issuer, "altium-mcp/local");
});

test("verify with a custom issuer claim", async () => {
  const { sealed } = await signSession("u", { issuer: "altium-mcp/workos" });
  const v = await verifySignedSession(sealed);
  assert.ok(v);
  assert.equal(v.issuer, "altium-mcp/workos");
});

test("two tokens have different session ids", async () => {
  const a = await signSession("u");
  const b = await signSession("u");
  assert.notEqual(a.sessionId, b.sessionId);
});

test("expired token verifies as null", async () => {
  const { sealed } = await signSession("u", { ttlSeconds: 1 });
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(await verifySignedSession(sealed), null);
});

test("tampered token verifies as null", async () => {
  const { sealed } = await signSession("u");
  // Flip one char in the signature segment.
  const parts = sealed.split(".");
  parts[2] = parts[2].replace(/^./, (c) => (c === "A" ? "B" : "A"));
  const bad = parts.join(".");
  assert.equal(await verifySignedSession(bad), null);
});

test("revoked session id returns null", async () => {
  const { sealed, sessionId } = await signSession("u");
  const set = new Set([sessionId]);
  assert.equal(await verifySignedSession(sealed, { revokedSessionIds: set }), null);
});

test("missing cookie password throws a helpful error", async () => {
  delete process.env.WORKOS_COOKIE_PASSWORD;
  __resetSessionCacheForTests();
  await assert.rejects(
    () => signSession("u"),
    /WORKOS_COOKIE_PASSWORD is not set/
  );
  // Restore for subsequent tests.
  process.env.WORKOS_COOKIE_PASSWORD = randomBytes(48).toString("base64");
  __resetSessionCacheForTests();
});

test("short cookie password throws a helpful error", async () => {
  process.env.WORKOS_COOKIE_PASSWORD = "too-short";
  __resetSessionCacheForTests();
  await assert.rejects(
    () => signSession("u"),
    /must be at least 32 bytes/
  );
  process.env.WORKOS_COOKIE_PASSWORD = randomBytes(48).toString("base64");
  __resetSessionCacheForTests();
});

test("verifySignedSession on empty / non-string returns null", async () => {
  assert.equal(await verifySignedSession(""), null);
  // @ts-expect-error — intentional bad input
  assert.equal(await verifySignedSession(undefined), null);
});
