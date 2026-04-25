/**
 * RedisQuotaStore tests against ioredis-mock — an in-memory ioredis
 * client with the same wire-protocol behavior. Lets us assert
 * INCRBY semantics, the PEXPIREAT TTL, and the per-period keying
 * without spinning up a real Redis.
 */

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import { RedisQuotaStore, REDIS_QUOTA_KEY_PREFIX } from "./redis-store.js";
import type { Period } from "./types.js";

// Both period.end values must be in the future relative to "now"
// or Redis' PEXPIREAT will evict the key immediately. We pick
// distant-future dates so this test stays correct regardless of
// when it runs (re-runs in 2030 are still OK).
const periodA: Period = {
  start: new Date("2099-01-01T00:00:00Z"),
  end: new Date("2099-02-01T00:00:00Z"),
};

const periodB: Period = {
  start: new Date("2099-02-01T00:00:00Z"),
  end: new Date("2099-03-01T00:00:00Z"),
};

let redis: Redis;
let store: RedisQuotaStore;

before(() => {
  // ioredis-mock is wire-compatible with ioredis — same constructor
  // shape, same MULTI/EXEC return shape. Casting to Redis is safe.
  redis = new RedisMock() as unknown as Redis;
  store = new RedisQuotaStore(redis);
});

beforeEach(async () => {
  // Each test starts from a clean Redis. flushall is the test-level
  // analog of InMemoryQuotaStore.reset().
  await redis.flushall();
});

test("getUsed returns 0 for an unknown key", async () => {
  assert.equal(await store.getUsed("o1", "bom_lookup", periodA), 0);
});

test("increment returns the post-increment count", async () => {
  assert.equal(await store.increment("o1", "bom_lookup", 1, periodA), 1);
  assert.equal(await store.increment("o1", "bom_lookup", 4, periodA), 5);
  assert.equal(await store.getUsed("o1", "bom_lookup", periodA), 5);
});

test("counters are isolated per orgId / metric / period", async () => {
  await store.increment("o1", "bom_lookup", 3, periodA);
  await store.increment("o2", "bom_lookup", 7, periodA);
  await store.increment("o1", "cost_analysis", 11, periodA);
  await store.increment("o1", "bom_lookup", 2, periodB);

  assert.equal(await store.getUsed("o1", "bom_lookup", periodA), 3);
  assert.equal(await store.getUsed("o2", "bom_lookup", periodA), 7);
  assert.equal(await store.getUsed("o1", "cost_analysis", periodA), 11);
  assert.equal(await store.getUsed("o1", "bom_lookup", periodB), 2);
});

test("keys are namespaced under altium-mcp:quota:", async () => {
  await store.increment("o1", "bom_lookup", 1, periodA);
  // The mock's keys() reflects what RedisQuotaStore wrote — pin the
  // prefix so a future rename gets caught (other Redis users in the
  // same instance, e.g. BullMQ, must not collide).
  const keys = await redis.keys("*");
  assert.equal(keys.length, 1);
  assert.ok(
    keys[0]!.startsWith(REDIS_QUOTA_KEY_PREFIX),
    `expected key to start with ${REDIS_QUOTA_KEY_PREFIX}, got ${keys[0]}`
  );
});

test("PEXPIREAT is set to period.end on every increment", async () => {
  // ioredis-mock supports PTTL — returns ms-to-expiry. We pin a
  // sentinel: after the second increment, the TTL still aligns to
  // period.end (i.e. PEXPIREAT is idempotent across increments).
  await store.increment("o1", "bom_lookup", 1, periodA);
  const keys = await redis.keys("*");
  const pttl1 = await redis.pttl(keys[0]!);
  assert.ok(pttl1 > 0, "first increment should set a positive TTL");

  await store.increment("o1", "bom_lookup", 1, periodA);
  const pttl2 = await redis.pttl(keys[0]!);
  // pttl2 should be very close to pttl1 — they expire at the same
  // wall-clock instant. Within a few ms is fine; in practice the
  // mock returns the same number.
  assert.ok(
    Math.abs(pttl2 - pttl1) < 100,
    `second increment changed TTL: ${pttl1} → ${pttl2}`
  );
});

test("increment with units=0 returns current value, no Redis write", async () => {
  await store.increment("o1", "bom_lookup", 5, periodA);
  const result = await store.increment("o1", "bom_lookup", 0, periodA);
  assert.equal(result, 5);
  assert.equal(await store.getUsed("o1", "bom_lookup", periodA), 5);
});

test("increment with negative units does not decrement", async () => {
  await store.increment("o1", "bom_lookup", 5, periodA);
  const result = await store.increment("o1", "bom_lookup", -2, periodA);
  assert.equal(result, 5);
  assert.equal(await store.getUsed("o1", "bom_lookup", periodA), 5);
});

test("getUsed returns 0 for a corrupt non-numeric value", async () => {
  // Defense in depth: a hand-edited key or namespace collision should
  // not crash the meter wrapper. We treat unparseable values as 0;
  // the next increment overwrites with a clean integer.
  const corruptKey = `${REDIS_QUOTA_KEY_PREFIX}o1|bom_lookup|${periodA.start.toISOString()}`;
  await redis.set(corruptKey, "not-a-number");
  assert.equal(await store.getUsed("o1", "bom_lookup", periodA), 0);
});

test("setExact writes an absolute value with TTL", async () => {
  await store.increment("o1", "bom_lookup", 99, periodA);
  await store.setExact("o1", "bom_lookup", 5, periodA);
  assert.equal(await store.getUsed("o1", "bom_lookup", periodA), 5);
  // TTL still set after SET — we want the key to expire at period.end
  // even after a reconciliation overwrite.
  const keys = await redis.keys("*");
  const pttl = await redis.pttl(keys[0]!);
  assert.ok(pttl > 0, "setExact should preserve a positive TTL");
});

test("setExact rejects negative values", async () => {
  await assert.rejects(
    () => store.setExact("o1", "bom_lookup", -1, periodA),
    /value must be >= 0/
  );
});

test("reset() throws — production sentinel", () => {
  // We never want a route handler accidentally calling reset() and
  // wiping every customer's counter. The throw is the failsafe.
  assert.throws(() => store.reset(), /test-only/);
});
