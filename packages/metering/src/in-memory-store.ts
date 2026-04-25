/**
 * In-memory QuotaStore. Powers tests + dev environments without Redis.
 *
 * PR 5.2 will add a RedisQuotaStore behind the same interface; this
 * implementation deliberately does not pretend to be process-shared
 * — a single Node process is the only correctness boundary. Routes
 * select between stores via env (REDIS_URL set → Redis; unset →
 * in-memory).
 *
 * Counters are keyed by `${orgId}|${metric}|${period.start.toISOString()}`
 * so a period rollover yields a fresh key (and an effective reset)
 * without any scheduled cleanup. We do NOT actively prune old keys
 * here — the Map grows unbounded over a long-running process. That's
 * acceptable for dev / tests; production runs the Redis store with
 * EXPIREAT set to period.end.
 */

import type { Metric, Period, QuotaStore } from "./types.js";

export class InMemoryQuotaStore implements QuotaStore {
  private readonly counters = new Map<string, number>();

  async getUsed(orgId: string, metric: Metric, period: Period): Promise<number> {
    return this.counters.get(keyFor(orgId, metric, period)) ?? 0;
  }

  async increment(
    orgId: string,
    metric: Metric,
    units: number,
    period: Period
  ): Promise<number> {
    if (units <= 0) {
      // Defensive: a 0-unit call would still record a UsageEvent but
      // shouldn't move the counter. Negative units are nonsense; we
      // don't decrement. Either way, return current value.
      return this.counters.get(keyFor(orgId, metric, period)) ?? 0;
    }
    const k = keyFor(orgId, metric, period);
    const next = (this.counters.get(k) ?? 0) + units;
    this.counters.set(k, next);
    return next;
  }

  reset(): void {
    this.counters.clear();
  }
}

function keyFor(orgId: string, metric: Metric, period: Period): string {
  return `${orgId}|${metric}|${period.start.toISOString()}`;
}
