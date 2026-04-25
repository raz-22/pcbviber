/**
 * Tests for InMemoryQuotaStore — covers the per-period keying that
 * makes "period rollover = automatic reset" actually work.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryQuotaStore } from "./in-memory-store.js";
import type { Period } from "./types.js";

const periodA: Period = {
  start: new Date("2026-01-01T00:00:00Z"),
  end: new Date("2026-02-01T00:00:00Z"),
};

const periodB: Period = {
  start: new Date("2026-02-01T00:00:00Z"),
  end: new Date("2026-03-01T00:00:00Z"),
};

test("getUsed returns 0 for unknown orgId/metric/period", async () => {
  const store = new InMemoryQuotaStore();
  assert.equal(await store.getUsed("o1", "bom_lookup", periodA), 0);
});

test("increment returns the post-increment count", async () => {
  const store = new InMemoryQuotaStore();
  assert.equal(await store.increment("o1", "bom_lookup", 1, periodA), 1);
  assert.equal(await store.increment("o1", "bom_lookup", 4, periodA), 5);
  assert.equal(await store.getUsed("o1", "bom_lookup", periodA), 5);
});

test("counters are isolated per orgId", async () => {
  const store = new InMemoryQuotaStore();
  await store.increment("o1", "bom_lookup", 3, periodA);
  await store.increment("o2", "bom_lookup", 7, periodA);
  assert.equal(await store.getUsed("o1", "bom_lookup", periodA), 3);
  assert.equal(await store.getUsed("o2", "bom_lookup", periodA), 7);
});

test("counters are isolated per metric", async () => {
  const store = new InMemoryQuotaStore();
  await store.increment("o1", "bom_lookup", 3, periodA);
  await store.increment("o1", "cost_analysis", 11, periodA);
  await store.increment("o1", "export", 2, periodA);
  assert.equal(await store.getUsed("o1", "bom_lookup", periodA), 3);
  assert.equal(await store.getUsed("o1", "cost_analysis", periodA), 11);
  assert.equal(await store.getUsed("o1", "export", periodA), 2);
});

test("counters reset implicitly on period rollover", async () => {
  // The whole point of period-keyed counters: once `now` falls into
  // periodB, store.getUsed for periodB starts at 0 — no scheduled
  // reset job needed.
  const store = new InMemoryQuotaStore();
  await store.increment("o1", "bom_lookup", 100, periodA);
  assert.equal(await store.getUsed("o1", "bom_lookup", periodA), 100);
  assert.equal(await store.getUsed("o1", "bom_lookup", periodB), 0);
  await store.increment("o1", "bom_lookup", 5, periodB);
  assert.equal(await store.getUsed("o1", "bom_lookup", periodB), 5);
  // periodA counter is untouched.
  assert.equal(await store.getUsed("o1", "bom_lookup", periodA), 100);
});

test("increment with units=0 does not move the counter", async () => {
  // Defensive: a 0-unit metering call (shouldn't happen in practice
  // but if a future caller passes 0, we must not corrupt the count).
  const store = new InMemoryQuotaStore();
  await store.increment("o1", "bom_lookup", 5, periodA);
  const after = await store.increment("o1", "bom_lookup", 0, periodA);
  assert.equal(after, 5);
  assert.equal(await store.getUsed("o1", "bom_lookup", periodA), 5);
});

test("increment with negative units does not decrement", async () => {
  // We never roll back on retries — same defensive stance as units=0.
  const store = new InMemoryQuotaStore();
  await store.increment("o1", "bom_lookup", 5, periodA);
  const after = await store.increment("o1", "bom_lookup", -3, periodA);
  assert.equal(after, 5);
  assert.equal(await store.getUsed("o1", "bom_lookup", periodA), 5);
});

test("reset() clears all counters", async () => {
  const store = new InMemoryQuotaStore();
  await store.increment("o1", "bom_lookup", 7, periodA);
  await store.increment("o2", "export", 2, periodB);
  store.reset();
  assert.equal(await store.getUsed("o1", "bom_lookup", periodA), 0);
  assert.equal(await store.getUsed("o2", "export", periodB), 0);
});
