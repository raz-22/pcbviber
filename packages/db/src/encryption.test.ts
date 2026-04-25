/**
 * Smoke tests for the credential encryption helpers.
 *
 * Uses Node's built-in test runner — no Jest, no test framework deps.
 * Runs purely in-process; no database required.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  encryptCredential,
  decryptCredential,
  safeCompare,
  __resetEncryptionCacheForTests,
} from "./encryption.js";

function setKey() {
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  __resetEncryptionCacheForTests();
}

test("round-trips a simple secret", () => {
  setKey();
  const plaintext = "nexar-client-secret-value-123";
  const encoded = encryptCredential(plaintext);
  assert.notEqual(encoded, plaintext);
  assert.match(encoded, /^v1\./, "wire format must be versioned");
  assert.equal(decryptCredential(encoded), plaintext);
});

test("round-trips multi-byte unicode", () => {
  setKey();
  const plaintext = "שלום · 日本語 · ✓ emoji 🔐";
  const encoded = encryptCredential(plaintext);
  assert.equal(decryptCredential(encoded), plaintext);
});

test("round-trips an empty string", () => {
  setKey();
  const encoded = encryptCredential("");
  assert.equal(decryptCredential(encoded), "");
});

test("two encryptions of the same plaintext produce different ciphertexts", () => {
  setKey();
  const a = encryptCredential("same");
  const b = encryptCredential("same");
  assert.notEqual(a, b, "IV reuse would be a correctness/security bug");
});

test("tampered ciphertext fails the auth check", () => {
  setKey();
  const encoded = encryptCredential("secret");
  const parts = encoded.split(".");
  // Flip one byte in the ciphertext segment.
  const bad = Buffer.from(parts[2], "base64url");
  bad[0] = bad[0] ^ 0xff;
  parts[2] = bad.toString("base64url");
  const tampered = parts.join(".");
  assert.throws(() => decryptCredential(tampered));
});

test("rejects malformed payloads", () => {
  setKey();
  assert.throws(() => decryptCredential("not-a-valid-payload"));
  assert.throws(() => decryptCredential("v1.only.three"));
  assert.throws(() => decryptCredential("v2.aaa.bbb.ccc")); // unknown version
});

test("decryption with a different key fails", () => {
  setKey();
  const encoded = encryptCredential("secret");
  // Rotate master key between encrypt and decrypt.
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  __resetEncryptionCacheForTests();
  assert.throws(() => decryptCredential(encoded));
});

test("missing master key yields a helpful error", () => {
  delete process.env.CREDENTIAL_ENCRYPTION_KEY;
  __resetEncryptionCacheForTests();
  assert.throws(
    () => encryptCredential("secret"),
    /CREDENTIAL_ENCRYPTION_KEY is not set/
  );
});

test("wrong-size master key yields a helpful error", () => {
  process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.from("too-short").toString("base64");
  __resetEncryptionCacheForTests();
  assert.throws(() => encryptCredential("secret"), /must decode to exactly 32 bytes/);
});

test("safeCompare returns true for equal strings and false otherwise", () => {
  assert.equal(safeCompare("abcdef", "abcdef"), true);
  assert.equal(safeCompare("abcdef", "abcdeg"), false);
  assert.equal(safeCompare("abc", "abcdef"), false); // length mismatch
});
