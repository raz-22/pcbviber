/**
 * Redis-backed QuotaStore. Production wiring for high-RPS quota
 * checks: INCRBY is atomic at the server level, so concurrent
 * meter() calls can't double-count the way an in-memory Map+Map
 * read-modify-write would.
 *
 * Key format mirrors the in-memory store:
 *
 *     altium-mcp:quota:{orgId}|{metric}|{period.start ISO}
 *
 * The `altium-mcp:quota:` prefix is so a single Redis instance can
 * be shared with rate-limiting / sessions / BullMQ later without
 * key collisions. ISO timestamp on `period.start` makes a period
 * rollover an automatic key change — no scheduled reset needed.
 *
 * TTL: every increment sets `PEXPIREAT period.end.getTime()`. The
 * PEXPIREAT is idempotent for the same period (Redis stores absolute
 * ms; re-setting to the same value is a no-op-ish), so we avoid the
 * "set EXPIRE only on first INCR" race. After period.end the key
 * auto-evicts; nothing to clean up.
 *
 * Atomicity: INCRBY then PEXPIREAT in a `MULTI`/`EXEC` pipeline so
 * a connection drop between the two never leaves a key without TTL.
 *
 * Cluster note: keys aren't hash-tagged, so a Redis Cluster would
 * shard freely (each org+metric+period is independent). If we move
 * to Cluster later and ever add cross-key Lua scripts, we'd revisit.
 */

import type { Redis } from "ioredis";
import type { Metric, Period, QuotaStore } from "./types.js";

const KEY_PREFIX = "altium-mcp:quota:";

export class RedisQuotaStore implements QuotaStore {
  constructor(private readonly redis: Redis) {}

  async getUsed(orgId: string, metric: Metric, period: Period): Promise<number> {
    const value = await this.redis.get(keyFor(orgId, metric, period));
    if (value === null) return 0;
    const n = Number(value);
    // Defensive: a corrupt non-numeric value (someone wrote a string
    // by hand, or a different key namespace collision) shouldn't
    // crash the request. Treat as 0 — the next increment will
    // overwrite with a clean integer.
    return Number.isFinite(n) ? n : 0;
  }

  async increment(
    orgId: string,
    metric: Metric,
    units: number,
    period: Period
  ): Promise<number> {
    if (units <= 0) {
      // Same defensive stance as InMemoryQuotaStore — never decrement,
      // never write 0-deltas. Returns the current value so callers
      // race-detecting against the post-increment count still work.
      const current = await this.getUsed(orgId, metric, period);
      return current;
    }
    const key = keyFor(orgId, metric, period);
    const expireAtMs = period.end.getTime();
    // MULTI/EXEC: INCRBY + PEXPIREAT execute atomically as far as
    // the client cares — a server failure between the two would
    // be retried by ioredis, but a partial pipeline never lands
    // because Redis discards the queued commands on EXEC failure.
    const results = await this.redis
      .multi()
      .incrby(key, units)
      .pexpireat(key, expireAtMs)
      .exec();
    if (!results) {
      // EXEC returned null: connection problem or watch-conflict.
      // We don't WATCH anything, so this is a transport failure;
      // surface to the meter wrapper which will let it propagate.
      throw new Error("RedisQuotaStore.increment: EXEC returned null");
    }
    // Result shape: [[err, value], [err, value]] — INCRBY value at [0].
    const [incrErr, incrValue] = results[0] ?? [];
    if (incrErr) throw incrErr;
    if (typeof incrValue !== "number") {
      throw new Error(
        `RedisQuotaStore.increment: unexpected INCRBY result type ${typeof incrValue}`
      );
    }
    return incrValue;
  }

  /**
   * Reconciliation-only escape hatch for setting an absolute value.
   * Not part of the public `QuotaStore` interface — route code uses
   * `increment` exclusively. See reconciliation.ts for the contract.
   *
   * Uses SET + PEXPIREAT so the TTL is preserved (we don't want a
   * reconciliation write to leave a key without expiry).
   */
  async setExact(
    orgId: string,
    metric: Metric,
    value: number,
    period: Period
  ): Promise<void> {
    if (value < 0) {
      throw new Error(`RedisQuotaStore.setExact: value must be >= 0, got ${value}`);
    }
    const key = keyFor(orgId, metric, period);
    const expireAtMs = period.end.getTime();
    const results = await this.redis
      .multi()
      .set(key, String(value))
      .pexpireat(key, expireAtMs)
      .exec();
    if (!results) {
      throw new Error("RedisQuotaStore.setExact: EXEC returned null");
    }
    const [setErr] = results[0] ?? [];
    if (setErr) throw setErr;
  }

  /**
   * Production sentinel: throws to make accidental calls in a hot
   * path impossible. Tests against ioredis-mock can use the mock's
   * own `flushall` directly if they need a clean slate.
   */
  reset(): void {
    throw new Error(
      "RedisQuotaStore.reset() is test-only and not implemented for Redis; " +
        "flush the test Redis instance directly if needed."
    );
  }
}

function keyFor(orgId: string, metric: Metric, period: Period): string {
  return `${KEY_PREFIX}${orgId}|${metric}|${period.start.toISOString()}`;
}

export const REDIS_QUOTA_KEY_PREFIX = KEY_PREFIX;
