/**
 * Pure-function tests for the usage helpers + error mapper.
 * Component / hook tests live in integration territory (Vitest +
 * jsdom isn't wired in this repo).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  usagePercent,
  usageRemaining,
  usageSeverity,
  usageErrorMessage,
} from "./usage";
import { ApiError } from "./api";

// ─── usagePercent ────────────────────────────────────────────────────

test("usagePercent: 0/N is 0", () => {
  assert.equal(usagePercent(0, 100), 0);
});

test("usagePercent: at-cap is 1", () => {
  assert.equal(usagePercent(100, 100), 1);
});

test("usagePercent: over-cap is > 1 (overage-allowed plans)", () => {
  // Team / Starter let you go past included quota. UI shows a red
  // bar but doesn't clamp the number — operator should see "120/100"
  // explicitly so they know they're billing as overage.
  assert.equal(usagePercent(120, 100), 1.2);
});

test("usagePercent: unlimited (null limit) returns null — UI renders ∞", () => {
  assert.equal(usagePercent(0, null), null);
  assert.equal(usagePercent(50_000, null), null);
});

test("usagePercent: limit=0 with usage>0 maps to 1 (over)", () => {
  // A 0-allotment metric (theoretical) with usage shows as fully
  // consumed. Avoids a divide-by-zero NaN that would crash the bar.
  assert.equal(usagePercent(3, 0), 1);
});

test("usagePercent: limit=0 with usage=0 is 0", () => {
  assert.equal(usagePercent(0, 0), 0);
});

// ─── usageRemaining ──────────────────────────────────────────────────

test("usageRemaining: subtracts used from limit", () => {
  assert.equal(usageRemaining(30, 100), 70);
});

test("usageRemaining: never returns negative (clamped to 0)", () => {
  // On overage-allowed plans, used can exceed limit. Showing
  // "-20 remaining" is confusing UI; clamp to 0 + show overage
  // separately.
  assert.equal(usageRemaining(120, 100), 0);
});

test("usageRemaining: unlimited returns null", () => {
  assert.equal(usageRemaining(50, null), null);
});

// ─── usageSeverity ───────────────────────────────────────────────────

test("usageSeverity: under 75% is 'ok'", () => {
  assert.equal(usageSeverity(0, 100), "ok");
  assert.equal(usageSeverity(74, 100), "ok");
});

test("usageSeverity: 75% to 99% is 'warn'", () => {
  assert.equal(usageSeverity(75, 100), "warn");
  assert.equal(usageSeverity(99, 100), "warn");
});

test("usageSeverity: at or over the cap is 'over'", () => {
  assert.equal(usageSeverity(100, 100), "over");
  assert.equal(usageSeverity(150, 100), "over");
});

test("usageSeverity: unlimited is always 'ok'", () => {
  // Enterprise users never see warn/over coloring; their bar is
  // either replaced with "∞" or stays neutral.
  assert.equal(usageSeverity(1_000_000, null), "ok");
});

// ─── usageErrorMessage ───────────────────────────────────────────────

test("maps forbidden to a permissions hint", () => {
  const err = new ApiError(403, "forbidden", null, "f");
  assert.match(usageErrorMessage(err), /permission/i);
});

test("maps not_found to an 'org no longer exists' hint", () => {
  const err = new ApiError(404, "not_found", null, "nf");
  assert.match(usageErrorMessage(err), /no longer exists/i);
});

test("maps not_authenticated to a 'log in again' hint", () => {
  const err = new ApiError(401, "not_authenticated", null, "na");
  assert.match(usageErrorMessage(err), /log in again/i);
});

test("falls through to ApiError.message on unknown codes", () => {
  const err = new ApiError(500, "weird_code", null, "raw message");
  assert.equal(usageErrorMessage(err), "raw message");
});

test("non-ApiError inputs surface a network message", () => {
  assert.match(usageErrorMessage(new Error("offline")), /Network error/i);
  assert.match(usageErrorMessage("anything else"), /Network error/i);
});
