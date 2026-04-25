/**
 * Env-gated QuotaStore selection.
 *
 * Same shape as `selectAuthProvider` (@altium-mcp/auth) and
 * `selectBillingProvider` (@altium-mcp/billing): cache one instance
 * per process, with a test-only reset hook so a `before()` flipping
 * env doesn't get a stale provider.
 *
 *   REDIS_URL set + non-empty → RedisQuotaStore
 *   else                      → InMemoryQuotaStore
 *
 * The Redis client is lazily constructed on first call so dev
 * environments without Redis never spin up a connection.
 */

import IORedis, { type Redis } from "ioredis";
import { InMemoryQuotaStore } from "./in-memory-store.js";
import { RedisQuotaStore } from "./redis-store.js";
import type { QuotaStore } from "./types.js";

let cachedStore: QuotaStore | null = null;
let cachedRedis: Redis | null = null;

/**
 * Returns the process-wide QuotaStore. Memoized — repeated calls
 * return the same instance. Tests must call
 * `__resetQuotaStoreCacheForTests()` before flipping REDIS_URL.
 */
export function selectQuotaStore(): QuotaStore {
  if (cachedStore) return cachedStore;
  const url = process.env.REDIS_URL?.trim();
  if (url && url.length > 0) {
    cachedRedis = new IORedis(url, {
      // ioredis defaults are sensible; we override only the bits
      // that matter for a quota counter:
      //   maxRetriesPerRequest: limit blocking on a flaky network so
      //     the meter wrapper gets a fast error rather than hanging
      //     the request. The meter route falls back to refusing the
      //     call (502 upstream_error) — better than queuing.
      maxRetriesPerRequest: 2,
      // Lazy connect so import-time side effects stay nil; the first
      // command opens the socket.
      lazyConnect: true,
    });
    cachedStore = new RedisQuotaStore(cachedRedis);
  } else {
    cachedStore = new InMemoryQuotaStore();
  }
  return cachedStore;
}

/**
 * Test-only: drop the cached store + close any open Redis client so
 * the next `selectQuotaStore()` re-reads env. Tests that toggle
 * REDIS_URL in their `before()` MUST call this.
 *
 * Uses `disconnect()` (sync force-close) rather than `quit()` so a
 * never-connected lazyConnect client doesn't try to dial out just to
 * send QUIT. Tests with placeholder REDIS_URLs would otherwise
 * stall on a real-network connection attempt during teardown.
 */
export async function __resetQuotaStoreCacheForTests(): Promise<void> {
  cachedStore = null;
  if (cachedRedis) {
    try {
      cachedRedis.disconnect();
    } catch {
      // ignore — best-effort teardown
    }
    cachedRedis = null;
  }
}

