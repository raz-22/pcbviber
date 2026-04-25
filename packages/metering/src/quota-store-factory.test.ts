/**
 * Factory tests — `selectQuotaStore` returns the right store based
 * on REDIS_URL env presence. Mirrors the pattern from
 * `selectBillingProvider` in @altium-mcp/billing.
 *
 * lazyConnect=true on the ioredis client means we never open a
 * socket during these tests; setting REDIS_URL to a placeholder
 * URL is hermetic-safe.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  __resetQuotaStoreCacheForTests,
  selectQuotaStore,
} from "./quota-store-factory.js";
import { InMemoryQuotaStore } from "./in-memory-store.js";
import { RedisQuotaStore } from "./redis-store.js";

async function withEnv(
  key: string,
  value: string | undefined,
  fn: () => Promise<void> | void
) {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
    await __resetQuotaStoreCacheForTests();
  }
}

test("returns InMemoryQuotaStore when REDIS_URL is unset", async () => {
  await withEnv("REDIS_URL", undefined, async () => {
    await __resetQuotaStoreCacheForTests();
    const s = selectQuotaStore();
    assert.ok(s instanceof InMemoryQuotaStore);
  });
});

test("returns InMemoryQuotaStore when REDIS_URL is empty/whitespace", async () => {
  // A blank `REDIS_URL=` line shouldn't fool us into spinning up
  // ioredis with a bad URL. Same env-blank handling as the other
  // factory selectors in the monorepo.
  for (const v of ["", "   ", "\n"]) {
    await withEnv("REDIS_URL", v, async () => {
      await __resetQuotaStoreCacheForTests();
      const s = selectQuotaStore();
      assert.ok(
        s instanceof InMemoryQuotaStore,
        `expected InMemoryQuotaStore for ${JSON.stringify(v)}`
      );
    });
  }
});

test("returns RedisQuotaStore when REDIS_URL is set", async () => {
  // lazyConnect=true means construction doesn't open a socket. The
  // placeholder URL never gets dialed during the test.
  await withEnv("REDIS_URL", "redis://localhost:6390", async () => {
    await __resetQuotaStoreCacheForTests();
    const s = selectQuotaStore();
    assert.ok(s instanceof RedisQuotaStore);
  });
});

test("memoizes — repeated calls return the same instance", async () => {
  await withEnv("REDIS_URL", undefined, async () => {
    await __resetQuotaStoreCacheForTests();
    const a = selectQuotaStore();
    const b = selectQuotaStore();
    assert.equal(a, b);
  });
});

test("__resetQuotaStoreCacheForTests forces re-read of env", async () => {
  // This test deliberately doesn't use the withEnv helper — its
  // auto-reset in `finally` would clobber the "no explicit reset"
  // assertion this test exists to prove. We manage env + reset
  // hooks by hand instead.
  const prev = process.env.REDIS_URL;
  try {
    delete process.env.REDIS_URL;
    await __resetQuotaStoreCacheForTests();
    const a = selectQuotaStore();
    assert.ok(a instanceof InMemoryQuotaStore);

    // Flip env without resetting — should still return cached
    // InMemoryQuotaStore because the reset wasn't called.
    process.env.REDIS_URL = "redis://localhost:6390";
    const stillInMem = selectQuotaStore();
    assert.ok(stillInMem instanceof InMemoryQuotaStore);

    // Reset, re-read, now we get RedisQuotaStore.
    await __resetQuotaStoreCacheForTests();
    const nowRedis = selectQuotaStore();
    assert.ok(nowRedis instanceof RedisQuotaStore);
  } finally {
    if (prev === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = prev;
    await __resetQuotaStoreCacheForTests();
  }
});
