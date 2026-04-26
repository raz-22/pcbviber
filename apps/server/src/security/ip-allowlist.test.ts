/**
 * Pure-function tests for the IP allowlist matcher.
 *
 * Pinned behaviors:
 *   - normalizeEntry parses IPv4/IPv6 + CIDR; rejects everything else
 *   - parseAllowlist tolerates corrupt JSON / non-array / non-string items
 *   - isAllowed: null/empty allowlist passes anyone (disabled)
 *   - isAllowed: exact-match v4 + v6 + CIDR for both
 *   - isAllowed: IPv4-mapped IPv6 unwraps to v4 before matching
 *   - isAllowed: malformed clientIp fails closed
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeEntry,
  parseAllowlist,
  isAllowed,
  MAX_ENTRIES,
} from "./ip-allowlist.js";

// ─── normalizeEntry ─────────────────────────────────────────────────

test("normalizeEntry: plain IPv4 round-trips", () => {
  assert.equal(normalizeEntry("203.0.113.5"), "203.0.113.5");
});

test("normalizeEntry: IPv4 CIDR round-trips with /N", () => {
  assert.equal(normalizeEntry("203.0.113.0/24"), "203.0.113.0/24");
});

test("normalizeEntry: IPv6 normalizes to canonical form", () => {
  // 2001:DB8:0:0::1 → 2001:db8:0:0:0:0:0:1
  const out = normalizeEntry("2001:DB8:0:0::1");
  assert.ok(out);
  assert.match(out!, /^2001:db8/);
});

test("normalizeEntry: IPv6 CIDR round-trips", () => {
  const out = normalizeEntry("2001:db8::/32");
  assert.ok(out);
  assert.match(out!, /\/32$/);
});

test("normalizeEntry: surrounding whitespace stripped", () => {
  assert.equal(normalizeEntry("  203.0.113.5  "), "203.0.113.5");
});

test("normalizeEntry: empty / overlong → null", () => {
  assert.equal(normalizeEntry(""), null);
  assert.equal(normalizeEntry("   "), null);
  assert.equal(normalizeEntry("x".repeat(100)), null);
});

test("normalizeEntry: hostnames rejected", () => {
  assert.equal(normalizeEntry("example.com"), null);
  assert.equal(normalizeEntry("localhost"), null);
});

test("normalizeEntry: invalid CIDR prefix rejected", () => {
  assert.equal(normalizeEntry("203.0.113.0/33"), null);
  assert.equal(normalizeEntry("203.0.113.0/-1"), null);
});

test("normalizeEntry: range syntax rejected (only single IP / CIDR allowed)", () => {
  // Range syntax like 1.2.3.4-1.2.3.10 isn't supported. Reject up
  // front so operators get a clean error instead of silent miss.
  assert.equal(normalizeEntry("203.0.113.5-203.0.113.10"), null);
});

// ─── parseAllowlist ─────────────────────────────────────────────────

test("parseAllowlist: null input → null", () => {
  assert.equal(parseAllowlist(null), null);
});

test("parseAllowlist: malformed JSON → null", () => {
  assert.equal(parseAllowlist("{not-json"), null);
});

test("parseAllowlist: non-array JSON → null", () => {
  assert.equal(parseAllowlist('"203.0.113.5"'), null);
  assert.equal(parseAllowlist('{"foo":"bar"}'), null);
});

test("parseAllowlist: empty array → []", () => {
  assert.deepEqual(parseAllowlist("[]"), []);
});

test("parseAllowlist: drops non-string + invalid items, keeps the rest", () => {
  const got = parseAllowlist(
    JSON.stringify([
      "203.0.113.5",
      "not-an-ip",
      42,
      "203.0.113.0/24",
      null,
      "203.0.113.5-203.0.113.10", // range syntax — invalid
    ])
  );
  assert.deepEqual(got, ["203.0.113.5", "203.0.113.0/24"]);
});

// ─── isAllowed ──────────────────────────────────────────────────────

test("isAllowed: null allowlist → true (disabled)", () => {
  assert.equal(isAllowed("203.0.113.5", null), true);
});

test("isAllowed: empty allowlist → true (disabled)", () => {
  assert.equal(isAllowed("203.0.113.5", []), true);
});

test("isAllowed: exact IPv4 match", () => {
  assert.equal(isAllowed("203.0.113.5", ["203.0.113.5"]), true);
  assert.equal(isAllowed("203.0.113.6", ["203.0.113.5"]), false);
});

test("isAllowed: IPv4 CIDR includes addresses inside the range", () => {
  assert.equal(isAllowed("203.0.113.42", ["203.0.113.0/24"]), true);
  assert.equal(isAllowed("203.0.113.255", ["203.0.113.0/24"]), true);
  // Address outside the /24.
  assert.equal(isAllowed("203.0.114.0", ["203.0.113.0/24"]), false);
});

test("isAllowed: exact IPv6 match (different textual forms)", () => {
  // Compressed vs expanded — match should canonicalize.
  assert.equal(isAllowed("2001:db8::1", ["2001:db8:0:0:0:0:0:1"]), true);
  assert.equal(isAllowed("2001:db8::1", ["2001:db8::1"]), true);
});

test("isAllowed: IPv6 CIDR includes addresses inside the range", () => {
  assert.equal(isAllowed("2001:db8::42", ["2001:db8::/32"]), true);
  assert.equal(isAllowed("2001:db9::1", ["2001:db8::/32"]), false);
});

test("isAllowed: IPv4-mapped IPv6 unwraps to v4 for matching", () => {
  // Node sees `::ffff:203.0.113.5` when the client connected via
  // IPv4 to a dual-stack listener. The allowlist is configured in
  // human-readable v4 — the matcher must unwrap before comparing.
  assert.equal(isAllowed("::ffff:203.0.113.5", ["203.0.113.5"]), true);
  assert.equal(isAllowed("::ffff:203.0.113.5", ["203.0.113.0/24"]), true);
  assert.equal(isAllowed("::ffff:203.0.114.0", ["203.0.113.0/24"]), false);
});

test("isAllowed: multiple entries — any match passes", () => {
  const allowlist = ["10.0.0.1", "203.0.113.0/24", "2001:db8::/32"];
  assert.equal(isAllowed("10.0.0.1", allowlist), true);
  assert.equal(isAllowed("203.0.113.50", allowlist), true);
  assert.equal(isAllowed("2001:db8::1", allowlist), true);
  assert.equal(isAllowed("8.8.8.8", allowlist), false);
});

test("isAllowed: malformed client IP fails closed", () => {
  assert.equal(isAllowed("not-an-ip", ["203.0.113.5"]), false);
  assert.equal(isAllowed("", ["203.0.113.5"]), false);
  assert.equal(isAllowed(null, ["203.0.113.5"]), false);
  assert.equal(isAllowed(undefined, ["203.0.113.5"]), false);
});

test("isAllowed: malformed allowlist entry doesn't crash + doesn't match", () => {
  // parseAllowlist filters these, but defense in depth: a hand-
  // injected bad entry should just be skipped.
  assert.equal(isAllowed("203.0.113.5", ["bogus", "203.0.113.5"]), true);
  assert.equal(isAllowed("203.0.113.5", ["bogus"]), false);
});

test("MAX_ENTRIES is exposed for the REST validator + is a sane number", () => {
  assert.ok(MAX_ENTRIES >= 10 && MAX_ENTRIES <= 1000);
});
