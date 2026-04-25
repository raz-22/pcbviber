import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateInviteToken,
  inviteExpiry,
  INVITE_TOKEN_BYTES,
  INVITE_TTL_DAYS,
} from "./tokens.js";

test("generateInviteToken is url-safe base64 of the configured byte length", () => {
  const t = generateInviteToken();
  // base64url: A-Z a-z 0-9 - _ , no padding. encoding 32 bytes → 43 chars.
  assert.match(t, /^[A-Za-z0-9_-]+$/);
  assert.equal(t.length, Math.ceil((INVITE_TOKEN_BYTES * 4) / 3));
  // Negative: must NOT contain `+`, `/`, or `=` from regular base64 — those
  // would break a query string the inviter pastes raw into Slack/email.
  assert.doesNotMatch(t, /[+/=]/);
});

test("generateInviteToken yields distinct tokens across many calls", () => {
  // Cheap entropy smoke test — collision in a sample of 1024 random
  // 256-bit tokens is astronomically unlikely; if it ever fires, our
  // RNG is broken.
  const seen = new Set<string>();
  for (let i = 0; i < 1024; i++) seen.add(generateInviteToken());
  assert.equal(seen.size, 1024);
});

test("inviteExpiry is INVITE_TTL_DAYS in the future from the given now", () => {
  const now = new Date("2026-04-25T12:00:00Z");
  const exp = inviteExpiry(now);
  const expectedMs = now.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000;
  assert.equal(exp.getTime(), expectedMs);
  // Sanity: 7 days, not 7 hours or 7000 days.
  assert.equal(exp.toISOString(), "2026-05-02T12:00:00.000Z");
});

test("inviteExpiry defaults to the current wall clock when called bare", () => {
  const before = Date.now();
  const exp = inviteExpiry();
  const after = Date.now();
  // Loose-but-tight: the expiry should be ~7 days ahead of *now*, not
  // a static value. Allow a 1-second tolerance for the call window.
  const ttlMs = INVITE_TTL_DAYS * 24 * 60 * 60 * 1000;
  assert.ok(exp.getTime() >= before + ttlMs);
  assert.ok(exp.getTime() <= after + ttlMs + 1000);
});
