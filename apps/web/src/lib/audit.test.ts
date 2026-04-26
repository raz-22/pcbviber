/**
 * Pure-function tests for the audit-log helpers + error mapper.
 * Component / hook tests live in integration territory (Vitest +
 * jsdom isn't wired in this repo).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  auditErrorMessage,
  formatActor,
  formatAuditAction,
  formatAuditTimestamp,
} from "./audit";
import { ApiError } from "./api";

// ─── formatAuditAction ──────────────────────────────────────────────

test("formatAuditAction: single-word capitalized", () => {
  assert.equal(formatAuditAction("signup"), "Signup");
  assert.equal(formatAuditAction("login"), "Login");
});

test("formatAuditAction: dotted verb becomes ' · '-joined", () => {
  assert.equal(formatAuditAction("workspace.add"), "Workspace · Add");
  assert.equal(formatAuditAction("workspace.update"), "Workspace · Update");
  assert.equal(formatAuditAction("workspace.delete"), "Workspace · Delete");
});

test("formatAuditAction: underscores become spaces, segment-cased", () => {
  // "role_change" → "Role change" (only the first letter capitalizes,
  // not "Role Change" — matches sentence case used elsewhere in the SPA)
  assert.equal(
    formatAuditAction("member.role_change"),
    "Member · Role change"
  );
  assert.equal(
    formatAuditAction("workspace.test_connection"),
    "Workspace · Test connection"
  );
});

test("formatAuditAction: deeply-nested verbs survive", () => {
  // Real billing actions ship as `billing.checkout_session.create`.
  // The auto-formatter must keep that readable without a code change.
  assert.equal(
    formatAuditAction("billing.checkout_session.create"),
    "Billing · Checkout session · Create"
  );
});

test("formatAuditAction: empty string returns empty", () => {
  // Defensive: a malformed row shouldn't throw.
  assert.equal(formatAuditAction(""), "");
});

// ─── formatActor ────────────────────────────────────────────────────

test("formatActor: null actor renders as 'System'", () => {
  assert.equal(formatActor(null), "System");
});

test("formatActor: returns the actor's email", () => {
  assert.equal(
    formatActor({ id: "user_1", email: "alice@example.test" }),
    "alice@example.test"
  );
});

// ─── formatAuditTimestamp ───────────────────────────────────────────

test("formatAuditTimestamp: parseable ISO returns a non-empty string", () => {
  // We don't pin the exact locale output (varies by host TZ) — just
  // that it's a non-empty rendering, not the raw ISO.
  const out = formatAuditTimestamp("2026-01-15T12:34:56Z");
  assert.ok(out.length > 0);
  // Sanity: the year survives.
  assert.ok(out.includes("2026") || out.includes("26"));
});

test("formatAuditTimestamp: unparseable input falls back to raw", () => {
  // A corrupt row shouldn't break the table rendering.
  assert.equal(formatAuditTimestamp("not-a-date"), "not-a-date");
});

// ─── auditErrorMessage ──────────────────────────────────────────────

test("auditErrorMessage: forbidden → admin-only hint", () => {
  const err = new ApiError(403, "forbidden", null, "f");
  assert.match(auditErrorMessage(err), /admin/i);
});

test("auditErrorMessage: not_authenticated → log-in hint", () => {
  const err = new ApiError(401, "not_authenticated", null, "na");
  assert.match(auditErrorMessage(err), /log in again/i);
});

test("auditErrorMessage: not_found → 'no longer exists'", () => {
  const err = new ApiError(404, "not_found", null, "nf");
  assert.match(auditErrorMessage(err), /no longer exists/i);
});

test("auditErrorMessage: audit_export_too_large → narrow-the-filter hint", () => {
  // PR 7.1: the export route hard-caps inline streams at
  // AUDIT_EXPORT_MAX_ROWS and returns 413 above that. Operators
  // should see actionable guidance, not the raw error code.
  const err = new ApiError(413, "audit_export_too_large", null, "x");
  const msg = auditErrorMessage(err);
  assert.match(msg, /Too many rows/i);
  assert.match(msg, /action filter/i);
});

test("auditErrorMessage: falls through to ApiError.message on unknown codes", () => {
  const err = new ApiError(500, "weird_code", null, "raw");
  assert.equal(auditErrorMessage(err), "raw");
});

test("auditErrorMessage: non-ApiError surfaces network message", () => {
  assert.match(auditErrorMessage(new Error("offline")), /Network error/i);
  assert.match(auditErrorMessage("anything"), /Network error/i);
});
