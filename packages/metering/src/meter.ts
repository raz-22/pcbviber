/**
 * The meter() wrapper. Sits in front of every revenue-relevant tool
 * call per spec §4.4:
 *
 *   1. Look up the org's current consumption for the metric.
 *   2. If used + units > limit AND !overageAllowed → throw QuotaExceeded.
 *   3. Run fn().
 *   4. Idempotently record a UsageEvent row (sha256(orgId|tool|requestId)).
 *   5. Increment the in-memory / Redis counter.
 *
 * Quota is checked BEFORE running fn() — we don't want to burn a
 * Nexar API call only to refuse to bill for it. Recording happens
 * AFTER fn() succeeds — failed tool calls are not billed (matches
 * the spec's "result of fn(); recordUsage" ordering).
 *
 * The idempotency key uses orgId|tool|requestId — Fastify's req.id
 * is unique per request. A retried request with the same req.id
 * (e.g. SPA retry on transient 502) hits the UNIQUE on UsageEvent,
 * `recordUsage` returns false, and we skip the counter increment
 * so retries don't double-decrement quota.
 */

import { createHash } from "node:crypto";
import {
  QuotaExceeded,
  type MeterContext,
  type MeterOptions,
  type Metric,
  type QuotaStore,
  type RecordUsage,
} from "./types.js";
import { UNLIMITED } from "./plan-resolver.js";

export interface MeterDeps {
  store: QuotaStore;
  recordUsage: RecordUsage;
}

/**
 * Wraps `fn` with quota enforcement + usage recording. Returns
 * fn()'s result on success. Throws QuotaExceeded when the org has
 * already consumed its allowance and no overage is permitted; lets
 * any error from fn() propagate untouched (callers map upstream
 * errors to their own response codes).
 */
export async function meter<T>(
  ctx: MeterContext,
  opts: MeterOptions,
  fn: () => Promise<T>,
  deps: MeterDeps
): Promise<T> {
  const units = opts.units ?? 1;
  if (units < 1) {
    throw new Error(`meter: units must be >= 1, got ${units}`);
  }

  const limit = limitFor(ctx.plan.quotas, opts.metric);
  const unlimited = limit === UNLIMITED;

  if (!unlimited && !ctx.plan.overageAllowed) {
    const used = await deps.store.getUsed(ctx.orgId, opts.metric, ctx.period);
    if (used + units > limit) {
      throw new QuotaExceeded({ metric: opts.metric, limit, used });
    }
  }

  const result = await fn();

  const idempotencyKey = idempotencyKeyFor({
    orgId: ctx.orgId,
    tool: opts.tool,
    requestId: ctx.requestId,
  });
  const recorded = await deps.recordUsage({
    orgId: ctx.orgId,
    userId: ctx.userId ?? null,
    tool: opts.tool,
    metric: opts.metric,
    quantity: units,
    idempotencyKey,
  });

  // Skip the counter increment when the row was already present —
  // a retried request must not double-decrement. The store's
  // increment is the only quota-side effect; dropping it on a
  // duplicate keeps quota accounting consistent with the DB.
  if (recorded) {
    await deps.store.increment(ctx.orgId, opts.metric, units, ctx.period);
  }

  return result;
}

export function idempotencyKeyFor(args: {
  orgId: string;
  tool: string;
  requestId: string;
}): string {
  return createHash("sha256")
    .update(`${args.orgId}|${args.tool}|${args.requestId}`)
    .digest("hex");
}

function limitFor(quotas: { [K in Metric]: number }, metric: Metric): number {
  return quotas[metric];
}
