/**
 * Tests for billing-period resolution. The QuotaStore keys counters
 * by `period.start.toISOString()`, so the boundary math has to be
 * exact — an off-by-a-day here is an off-by-a-month in production.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { monthlyPeriodFor, subscriptionPeriod } from "./period.js";

test("subscriptionPeriod returns Stripe window when both timestamps set", () => {
  const start = new Date("2026-01-01T00:00:00Z");
  const end = new Date("2026-02-01T00:00:00Z");
  const result = subscriptionPeriod({ currentPeriodStart: start, currentPeriodEnd: end });
  assert.deepEqual(result, { start, end });
});

test("subscriptionPeriod returns null when subscription is null/undefined", () => {
  assert.equal(subscriptionPeriod(null), null);
  assert.equal(subscriptionPeriod(undefined), null);
});

test("subscriptionPeriod returns null when either timestamp is missing", () => {
  assert.equal(
    subscriptionPeriod({
      currentPeriodStart: new Date(),
      currentPeriodEnd: null,
    }),
    null
  );
  assert.equal(
    subscriptionPeriod({
      currentPeriodStart: null,
      currentPeriodEnd: new Date(),
    }),
    null
  );
});

test("monthlyPeriodFor returns same-day-of-month windows", () => {
  // org created on the 17th at noon UTC; "now" is the 23rd of the
  // same month → window starts on the 17th, ends on the 17th of next.
  const anchor = new Date("2026-03-17T12:00:00Z");
  const now = new Date("2026-03-23T05:00:00Z");
  const period = monthlyPeriodFor(anchor, now);
  assert.equal(period.start.toISOString(), "2026-03-17T12:00:00.000Z");
  assert.equal(period.end.toISOString(), "2026-04-17T12:00:00.000Z");
});

test("monthlyPeriodFor steps back when anchor day is in the future this month", () => {
  // anchor day = 25; now = 10th of the month → window started on the
  // 25th of LAST month and ends on the 25th of this month.
  const anchor = new Date("2026-03-25T00:00:00Z");
  const now = new Date("2026-04-10T00:00:00Z");
  const period = monthlyPeriodFor(anchor, now);
  assert.equal(period.start.toISOString(), "2026-03-25T00:00:00.000Z");
  assert.equal(period.end.toISOString(), "2026-04-25T00:00:00.000Z");
});

test("monthlyPeriodFor clamps anchor day to month length (Feb non-leap)", () => {
  // anchor on Jan 31 → in Feb (non-leap), the next anchor is clamped
  // to the 28th. This is the visible boundary for a tenant whose
  // monthly quota would otherwise go missing every February.
  const anchor = new Date("2026-01-31T08:00:00Z");
  // 2026 is a non-leap year — Feb 28 is the last day.
  const now = new Date("2026-02-15T00:00:00Z");
  const period = monthlyPeriodFor(anchor, now);
  assert.equal(period.start.toISOString(), "2026-01-31T08:00:00.000Z");
  assert.equal(period.end.toISOString(), "2026-02-28T08:00:00.000Z");
});

test("monthlyPeriodFor clamps anchor day in Feb (leap year)", () => {
  const anchor = new Date("2024-01-31T00:00:00Z"); // 2024 is a leap year
  const now = new Date("2024-02-15T00:00:00Z");
  const period = monthlyPeriodFor(anchor, now);
  assert.equal(period.start.toISOString(), "2024-01-31T00:00:00.000Z");
  assert.equal(period.end.toISOString(), "2024-02-29T00:00:00.000Z");
});

test("monthlyPeriodFor handles year rollover", () => {
  const anchor = new Date("2025-12-15T00:00:00Z");
  const now = new Date("2026-01-05T00:00:00Z"); // before next anchor
  const period = monthlyPeriodFor(anchor, now);
  assert.equal(period.start.toISOString(), "2025-12-15T00:00:00.000Z");
  assert.equal(period.end.toISOString(), "2026-01-15T00:00:00.000Z");
});
