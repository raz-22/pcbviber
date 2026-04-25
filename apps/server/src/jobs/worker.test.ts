/**
 * Worker scaffolding tests — pin the public API constants.
 *
 * We deliberately don't run a live BullMQ worker here. BullMQ uses
 * BLPOP-style blocking commands that ioredis-mock implements
 * incompletely (workers hang waiting for jobs that never arrive).
 * The job logic is covered by meter-push.test.ts and
 * reconcile-tick.test.ts; the BullMQ scheduler / queue plumbing is
 * BullMQ's responsibility, not ours to retest.
 *
 * What we DO pin here: the names + cadences are stable. Operators
 * grep for these strings in worker logs / failed-job dashboards;
 * a rename without a deliberate decision would break those.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  JOB_METER_PUSH,
  JOB_RECONCILE_TICK,
  METER_PUSH_INTERVAL_MS,
  RECONCILE_TICK_INTERVAL_MS,
  METERING_QUEUE_NAME,
} from "./worker.js";

test("job names export the expected strings", () => {
  // Stable for log scraping. Future renames are deliberate code
  // changes that will trip this test.
  assert.equal(JOB_METER_PUSH, "meter-push");
  assert.equal(JOB_RECONCILE_TICK, "reconcile-tick");
});

test("queue name is BullMQ-safe (no `:`) and prefixed with altium-mcp", () => {
  // BullMQ rejects queue names containing `:` (used as an internal
  // key separator). Verify both the prefix convention and the
  // BullMQ-safe form are preserved.
  assert.equal(METERING_QUEUE_NAME, "altium-mcp-metering");
  assert.ok(!METERING_QUEUE_NAME.includes(":"));
  assert.ok(METERING_QUEUE_NAME.startsWith("altium-mcp"));
});

test("cadences match the spec (60s push, 1h reconcile)", () => {
  // Per spec §4.4: "Push to Stripe ... batch every 60s." Reconcile
  // is the hourly safety net.
  assert.equal(METER_PUSH_INTERVAL_MS, 60_000);
  assert.equal(RECONCILE_TICK_INTERVAL_MS, 3_600_000);
});
