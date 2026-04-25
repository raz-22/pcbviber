import { test } from "node:test";
import assert from "node:assert/strict";
import {
  API_KEY_BYTES,
  API_KEY_PREFIX,
  generateApiKey,
  hashApiKey,
} from "./keys.js";

test("generated key has the pcb_ prefix and url-safe body", () => {
  const k = generateApiKey();
  assert.ok(k.plaintext.startsWith(API_KEY_PREFIX));
  const body = k.plaintext.slice(API_KEY_PREFIX.length);
  // base64url alphabet only — no `+`, `/`, or `=` that would corrupt
  // an `Authorization: Bearer ...` header or a query param.
  assert.match(body, /^[A-Za-z0-9_-]+$/);
  // 32 bytes → ceil(32 * 4/3) = 43 base64url chars (no padding).
  assert.equal(body.length, Math.ceil((API_KEY_BYTES * 4) / 3));
});

test("hash is deterministic: same plaintext → same hash", () => {
  const a = hashApiKey("pcb_test1234");
  const b = hashApiKey("pcb_test1234");
  assert.equal(a, b);
});

test("hash differs for different plaintexts (collision smoke)", () => {
  const a = hashApiKey("pcb_aaa");
  const b = hashApiKey("pcb_aab");
  assert.notEqual(a, b);
});

test("hash output is 64 hex chars (sha256)", () => {
  const h = hashApiKey("any string");
  assert.match(h, /^[a-f0-9]{64}$/);
});

test("generated key's hash equals hashApiKey(plaintext) — round-trip contract", () => {
  // PR 3.4's verification path will receive a plaintext and call
  // hashApiKey(); the DB lookup compares to ApiKey.hashedKey. This
  // test pins that the create-time and verify-time hashes match.
  const k = generateApiKey();
  assert.equal(k.hash, hashApiKey(k.plaintext));
});

test("preview is the prefix + first 8 chars of the random body", () => {
  const k = generateApiKey();
  assert.ok(k.preview.startsWith(API_KEY_PREFIX));
  // 4 chars prefix + 8 chars body = 12.
  assert.equal(k.preview.length, API_KEY_PREFIX.length + 8);
  assert.ok(k.plaintext.startsWith(k.preview));
});

test("generated keys are distinct across many calls (entropy smoke)", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 1024; i++) seen.add(generateApiKey().plaintext);
  assert.equal(seen.size, 1024);
});
