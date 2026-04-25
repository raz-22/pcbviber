/**
 * Billing-period resolution.
 *
 * Two sources, in order of preference:
 *   1. The org's active Subscription has currentPeriodStart /
 *      currentPeriodEnd set by Stripe — use that window verbatim.
 *      Aligns the meter with what Stripe will invoice.
 *   2. No subscription yet (free / trialing pre-checkout): synthesize
 *      a monthly window anchored to org.createdAt's day-of-month.
 *      Picks the most recent anchor ≤ now and the next anchor > now.
 *
 * No persistence — these are pure clock math. The QuotaStore keys
 * its counters by `period.start.toISOString()`, so a period rollover
 * is just a key change; counters auto-reset when the new period
 * starts asking for its own counter.
 */

import type { Period } from "./types.js";

/**
 * Returns the Stripe-aligned period if both timestamps are set,
 * otherwise null (caller falls back to monthlyPeriodFor).
 */
export function subscriptionPeriod(sub: {
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
} | null | undefined): Period | null {
  if (!sub || !sub.currentPeriodStart || !sub.currentPeriodEnd) return null;
  return { start: sub.currentPeriodStart, end: sub.currentPeriodEnd };
}

/**
 * Monthly window anchored to `anchor`'s UTC day-of-month. For an org
 * created on the 17th, the windows are 17→17, 17→17, ... — same day
 * each month, regardless of varying month lengths.
 *
 * For days-of-month that don't exist in every month (29, 30, 31),
 * clamps to the last valid day. So an anchor on Jan 31 yields a
 * window that ends Feb 28/29 in non-leap / leap years respectively.
 */
export function monthlyPeriodFor(anchor: Date, now: Date): Period {
  const anchorDay = anchor.getUTCDate();
  const anchorHour = anchor.getUTCHours();
  const anchorMin = anchor.getUTCMinutes();
  const anchorSec = anchor.getUTCSeconds();

  // Candidate start = "this month, on anchor day". If that's in the
  // future, step back a month. (Loop covers the edge case where
  // anchorDay clamping crossed a month boundary.)
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth();

  let start = clampedMonthStart(year, month, anchorDay, anchorHour, anchorMin, anchorSec);
  if (start.getTime() > now.getTime()) {
    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
    start = clampedMonthStart(year, month, anchorDay, anchorHour, anchorMin, anchorSec);
  }

  let endYear = year;
  let endMonth = month + 1;
  if (endMonth > 11) {
    endMonth = 0;
    endYear += 1;
  }
  const end = clampedMonthStart(endYear, endMonth, anchorDay, anchorHour, anchorMin, anchorSec);

  return { start, end };
}

function clampedMonthStart(
  year: number,
  month: number,
  day: number,
  hour: number,
  min: number,
  sec: number
): Date {
  // Days-in-month: ask the Date constructor for "day 0 of next month".
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const d = Math.min(day, lastDay);
  return new Date(Date.UTC(year, month, d, hour, min, sec, 0));
}
