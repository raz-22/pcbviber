/**
 * Pure-function tests for slug derivation. The DB-touching parts of
 * createOrgForOwner are covered by routes.test.ts (signup creates an
 * org, slug-collision retry exercised when alice@example.com signs up
 * twice with different orgNames in the suite).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveSlug, slugFromEmail } from "./org.js";

test("deriveSlug lowercases + ASCII-folds + collapses non-alnum", () => {
  assert.equal(deriveSlug("Acme Hardware Co."), "acme-hardware-co");
  assert.equal(deriveSlug("My  Org!!!"), "my-org");
  assert.equal(deriveSlug("UPPERCASE"), "uppercase");
});

test("deriveSlug strips diacritics", () => {
  assert.equal(deriveSlug("Café Équipe"), "cafe-equipe");
  assert.equal(deriveSlug("Résumé Co"), "resume-co");
});

test("deriveSlug handles unicode that isn't safely ASCII-foldable", () => {
  // Hebrew / CJK characters disappear; we get an empty-ish result that
  // the caller is expected to fall back from (slugFromEmail or default).
  assert.equal(deriveSlug("סיסמה"), "");
  assert.equal(deriveSlug("日本語"), "");
});

test("deriveSlug strips leading/trailing dashes", () => {
  assert.equal(deriveSlug("-foo-"), "foo");
  assert.equal(deriveSlug("---foo---"), "foo");
});

test("deriveSlug truncates to 48 chars", () => {
  const long = "a".repeat(100);
  assert.equal(deriveSlug(long).length, 48);
});

test("slugFromEmail picks the local-part", () => {
  assert.equal(slugFromEmail("alice@example.com"), "alice");
  assert.equal(slugFromEmail("Mixed.Case+tag@acme.test"), "mixed-case-tag");
});

test("slugFromEmail falls back to 'org' when local-part is unprintable", () => {
  assert.equal(slugFromEmail("שלום@acme.test"), "org");
});
