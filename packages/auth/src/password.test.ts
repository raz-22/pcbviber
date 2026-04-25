/**
 * Password hashing tests. All in-process, no DB.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hashPassword,
  verifyPassword,
  needsRehash,
  validatePasswordStrength,
  PasswordTooWeakError,
} from "./password.js";

const GOOD = "correct-horse-battery-staple-123";

test("hashPassword produces the versioned scrypt wire format", async () => {
  const hash = await hashPassword(GOOD);
  assert.match(hash, /^scrypt\$v1\$N=\d+,r=\d+,p=\d+\$[^$]+\$[^$]+$/);
});

test("verifyPassword accepts the correct password", async () => {
  const hash = await hashPassword(GOOD);
  assert.equal(await verifyPassword(GOOD, hash), true);
});

test("verifyPassword rejects the wrong password", async () => {
  const hash = await hashPassword(GOOD);
  assert.equal(await verifyPassword(GOOD + "x", hash), false);
});

test("two hashes of the same password differ (random salt)", async () => {
  const a = await hashPassword(GOOD);
  const b = await hashPassword(GOOD);
  assert.notEqual(a, b);
});

test("verifyPassword returns false for malformed hashes", async () => {
  assert.equal(await verifyPassword(GOOD, "not-a-hash"), false);
  assert.equal(await verifyPassword(GOOD, "scrypt$v9$N=1,r=1,p=1$aa$bb"), false);
  assert.equal(await verifyPassword(GOOD, ""), false);
});

test("short passwords are rejected with a typed error", async () => {
  await assert.rejects(() => hashPassword("short"), PasswordTooWeakError);
});

test("unicode passwords are accepted and round-trip", async () => {
  const pw = "סיסמה-🔐-with-ים"; // > 12 bytes UTF-8
  const hash = await hashPassword(pw);
  assert.equal(await verifyPassword(pw, hash), true);
});

test("needsRehash is false for current-param hashes", async () => {
  const hash = await hashPassword(GOOD);
  assert.equal(needsRehash(hash), false);
});

test("needsRehash is true for lower-param hashes", () => {
  // A hand-crafted weak-params hash — scrypt ran successfully but with old N.
  const weak =
    "scrypt$v1$N=1024,r=8,p=1$" +
    "A".repeat(22) +
    "$" +
    "A".repeat(43);
  assert.equal(needsRehash(weak), true);
});

test("needsRehash is true for malformed input (fail closed)", () => {
  assert.equal(needsRehash("not-a-hash"), true);
});

test("validatePasswordStrength throws TypeError on non-string", () => {
  assert.throws(
    // @ts-expect-error — intentional
    () => validatePasswordStrength(123),
    TypeError
  );
});

test("rejects malicious scrypt params (N too large)", async () => {
  // N=2^21 would be a RAM bomb; we cap at 2^20. Wire format is valid
  // otherwise, so the parser-level rejection matters.
  const evil =
    "scrypt$v1$N=2097152,r=8,p=1$" +
    "A".repeat(22) +
    "$" +
    "A".repeat(43);
  assert.equal(await verifyPassword(GOOD, evil), false);
});
