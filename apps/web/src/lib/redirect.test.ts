import { test } from "node:test";
import assert from "node:assert/strict";
import { validateRedirectUrl } from "./redirect";

// ─── Happy path ──────────────────────────────────────────────────────

test("accepts simple relative paths", () => {
  assert.equal(validateRedirectUrl("/"), "/");
  assert.equal(validateRedirectUrl("/parts"), "/parts");
  assert.equal(validateRedirectUrl("/settings/organization"), "/settings/organization");
});

test("preserves query strings and fragments", () => {
  assert.equal(validateRedirectUrl("/parts?q=stm32"), "/parts?q=stm32");
  assert.equal(validateRedirectUrl("/parts#section"), "/parts#section");
});

// ─── Open-redirect defenses ─────────────────────────────────────────

test("rejects protocol-relative URLs", () => {
  assert.equal(validateRedirectUrl("//evil.com"), "/");
  assert.equal(validateRedirectUrl("//evil.com/path"), "/");
});

test("rejects URLs with backslash variants", () => {
  // Some routers normalize / and \, so /\evil.com could leak.
  assert.equal(validateRedirectUrl("/\\evil.com"), "/");
});

test("rejects fully-qualified URLs", () => {
  assert.equal(validateRedirectUrl("https://evil.com"), "/");
  assert.equal(validateRedirectUrl("http://evil.com"), "/");
});

test("rejects javascript: and data: schemes", () => {
  assert.equal(validateRedirectUrl("javascript:alert(1)"), "/");
  assert.equal(validateRedirectUrl("data:text/html,..."), "/");
});

test("rejects bare scheme-like prefixes", () => {
  assert.equal(validateRedirectUrl("evil.com"), "/");
  assert.equal(validateRedirectUrl("about:blank"), "/");
});

// ─── Fallback inputs ────────────────────────────────────────────────

test("falls back on empty / wrong type", () => {
  assert.equal(validateRedirectUrl(""), "/");
  assert.equal(validateRedirectUrl(undefined), "/");
  assert.equal(validateRedirectUrl(null), "/");
  assert.equal(validateRedirectUrl(123), "/");
  assert.equal(validateRedirectUrl({}), "/");
});
