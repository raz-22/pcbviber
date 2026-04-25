/**
 * Pure-function tests for the billing helpers + error mapper. Hooks
 * (useBillingPlans / useCreateCheckoutSession / useCreatePortalSession)
 * exercise via integration; Vitest+jsdom isn't wired so we don't unit-
 * test them directly.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  billingErrorMessage,
  billingSeverity,
  trialDaysLeft,
} from "./billing";
import { ApiError } from "./api";

// ─── trialDaysLeft ───────────────────────────────────────────────────

test("trialDaysLeft returns null on null/empty/garbage input", () => {
  assert.equal(trialDaysLeft(null), null);
  assert.equal(trialDaysLeft(""), null);
  assert.equal(trialDaysLeft("not-a-date"), null);
});

test("trialDaysLeft: 14d in the future returns 14", () => {
  const now = new Date("2026-04-25T12:00:00Z");
  // Exactly 14 days later.
  const trialEnd = "2026-05-09T12:00:00Z";
  assert.equal(trialDaysLeft(trialEnd, now), 14);
});

test("trialDaysLeft rounds UP partial days (12h left → 1 day)", () => {
  // 12 hours remain. The banner's "X days left" reads better as 1 than 0.
  const now = new Date("2026-04-25T12:00:00Z");
  const trialEnd = "2026-04-26T00:00:00Z";
  assert.equal(trialDaysLeft(trialEnd, now), 1);
});

test("trialDaysLeft returns 0 or negative when deadline has passed", () => {
  const now = new Date("2026-04-25T12:00:00Z");
  const trialEnd = "2026-04-24T12:00:00Z"; // 1 day in the past
  const days = trialDaysLeft(trialEnd, now);
  assert.ok(days !== null);
  assert.ok(days <= 0, `expected non-positive, got ${days}`);
});

// ─── billingSeverity ─────────────────────────────────────────────────

test("billingSeverity: active and free are 'none' (no banner)", () => {
  assert.equal(billingSeverity("active"), "none");
  assert.equal(billingSeverity("free"), "none");
});

test("billingSeverity: trialing is 'info' (countdown, not alarming)", () => {
  assert.equal(billingSeverity("trialing"), "info");
});

test("billingSeverity: past_due is 'warning' (action required, not blocking)", () => {
  // Stripe Smart Retries are still trying — the user CAN still use
  // tools (per requireActiveBilling) but should update payment soon.
  assert.equal(billingSeverity("past_due"), "warning");
});

test("billingSeverity: suspended and canceled are 'critical' (tools blocked)", () => {
  assert.equal(billingSeverity("suspended"), "critical");
  assert.equal(billingSeverity("canceled"), "critical");
});

test("billingSeverity defaults unknown statuses to 'info' (forward-compat)", () => {
  // Server might emit a future status ('paused'? 'incomplete'?) the
  // SPA build doesn't know yet. Fail-visible — show info banner —
  // beats fail-silent (no banner, user sees nothing).
  assert.equal(billingSeverity("future_unknown"), "info");
});

// ─── billingErrorMessage ─────────────────────────────────────────────

test("maps billing_not_configured to env-config wording", () => {
  const err = new ApiError(503, "billing_not_configured", null, "bnc");
  assert.match(billingErrorMessage(err), /isn't configured/i);
});

test("maps billing_upstream_error to a 'Stripe temporarily unavailable' hint", () => {
  // Important: the message must NOT echo the underlying Stripe message
  // (server already strips it). The test pins the user-facing string.
  const err = new ApiError(502, "billing_upstream_error", null, "bue");
  assert.match(billingErrorMessage(err), /temporarily unavailable/i);
});

test("maps invalid_price to a 'pick a different plan' hint", () => {
  const err = new ApiError(400, "invalid_price", null, "ip");
  assert.match(billingErrorMessage(err), /different one/i);
});

test("maps not_yet_subscribed to a 'subscribe first' hint", () => {
  const err = new ApiError(409, "not_yet_subscribed", null, "nys");
  assert.match(billingErrorMessage(err), /subscribe first/i);
});

test("maps billing_inactive (402 from tools when suspended) to 'update payment'", () => {
  const err = new ApiError(402, "billing_inactive", null, "bi");
  assert.match(billingErrorMessage(err), /update payment/i);
});

test("maps forbidden to a billing-specific 'only owner' message", () => {
  // Distinct from the generic forbidden in members/workspaces — for
  // billing the actionable next-step is "ask the owner".
  const err = new ApiError(403, "forbidden", null, "f");
  assert.match(billingErrorMessage(err), /only the org owner/i);
});

test("maps not_authenticated to session-expired", () => {
  const err = new ApiError(401, "not_authenticated", null, "na");
  assert.match(billingErrorMessage(err), /session has expired/i);
});

test("maps invalid_input to a check-the-form hint", () => {
  const err = new ApiError(400, "invalid_input", null, "ii");
  assert.match(billingErrorMessage(err), /check the form/i);
});

test("falls through to ApiError.message on unknown codes", () => {
  const err = new ApiError(500, "weird", null, "raw upstream blob");
  assert.match(billingErrorMessage(err), /raw upstream blob/i);
});

test("non-ApiError inputs surface a network message", () => {
  assert.match(billingErrorMessage(new TypeError("offline")), /network/i);
  assert.match(billingErrorMessage("garbled"), /network/i);
  assert.match(billingErrorMessage(null), /network/i);
});
