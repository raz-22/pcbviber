/**
 * Quota reconciliation: rebuild Redis counters from the source of
 * truth (UsageEvent rows) for the current billing period.
 *
 * Why this exists (per spec §4.4):
 *
 *   "Quota check is Redis-counter first (fast), DB-backed
 *    reconciliation hourly."
 *
 * Without reconciliation, a Redis flush (instance restart, eviction
 * under memory pressure, ops-team OOPS) would silently reset every
 * org's counter to zero — customers would get a free quota refresh.
 * Reconciliation closes that hole by SUMming UsageEvent rows for
 * the current period and writing the result back into the store.
 *
 * Scope of "current period" per org:
 *   - If the org has an active Subscription, use its
 *     currentPeriodStart..currentPeriodEnd.
 *   - Else, synthesize a monthly window anchored on org.createdAt.
 *
 * This is a pure-ish function: takes Prisma + a QuotaStore + `now`,
 * returns a per-org, per-metric summary. Production runs it via the
 * `reconcile` CLI today; a recurring scheduler job can drive it
 * once the worker process lands. Tests pass in-memory stores +
 * fixed clocks.
 *
 * Idempotency: writing SET (not INCRBY) means re-running the same
 * window converges to the same number — no risk of compounding
 * bumps if reconcile runs twice in the same hour.
 */

import type { PrismaClient } from "@altium-mcp/db";
import { monthlyPeriodFor, subscriptionPeriod } from "./period.js";
import type { Metric, QuotaStore, Period } from "./types.js";
import { KNOWN_METRICS } from "./types.js";

export interface ReconcileResult {
  /** Total orgs visited. */
  orgs: number;
  /**
   * Per-(orgId, metric) write decision. `before` is what the store
   * had; `after` is the DB-derived sum we wrote. Useful for
   * surfacing drift in the CLI output / logs.
   */
  writes: Array<{
    orgId: string;
    metric: Metric;
    before: number;
    after: number;
  }>;
}

export interface ReconcileDeps {
  /** Override `Date.now()` for hermetic tests. */
  now?: () => Date;
}

/**
 * Walks every non-deleted org, computes the UsageEvent SUM by
 * metric for its current period, and SETs the QuotaStore key.
 *
 * Costs one query per org (subscription lookup) + one aggregate
 * across UsageEvent. Acceptable hourly. If org count grows past
 * the point where this is comfortable, batch by orgId chunks.
 */
export async function reconcileQuotas(
  prisma: PrismaClient,
  store: QuotaStore,
  deps: ReconcileDeps = {}
): Promise<ReconcileResult> {
  const now = deps.now?.() ?? new Date();
  const result: ReconcileResult = { orgs: 0, writes: [] };

  // Pull all live orgs in one pass. deletedAt-soft-deleted orgs are
  // skipped — their counters can be left to expire naturally.
  const orgs = await prisma.organization.findMany({
    where: { deletedAt: null },
    select: { id: true, createdAt: true },
  });

  for (const org of orgs) {
    result.orgs += 1;
    const period = await pickPeriodForOrg(prisma, org, now);

    // Aggregate UsageEvent quantity for this org, grouped by metric,
    // restricted to the current period. groupBy hits one indexed
    // query (orgId,timestamp) → cheap.
    const grouped = await prisma.usageEvent.groupBy({
      by: ["metric"],
      where: {
        orgId: org.id,
        timestamp: { gte: period.start, lt: period.end },
      },
      _sum: { quantity: true },
    });

    // Every metric we know about gets a write decision — including
    // metrics with zero rows (so a Redis-only counter that drifted
    // upward gets corrected to 0). KNOWN_METRICS is the source of
    // truth for "what to reconcile".
    const sumByMetric = new Map<Metric, number>();
    for (const row of grouped) {
      const m = row.metric as Metric;
      sumByMetric.set(m, row._sum.quantity ?? 0);
    }
    for (const metric of KNOWN_METRICS) {
      const after = sumByMetric.get(metric) ?? 0;
      const before = await store.getUsed(org.id, metric, period);
      if (before !== after) {
        await store.setExact(org.id, metric, after, period);
        result.writes.push({ orgId: org.id, metric, before, after });
      }
    }
  }

  return result;
}

async function pickPeriodForOrg(
  prisma: PrismaClient,
  org: { id: string; createdAt: Date },
  now: Date
): Promise<Period> {
  const sub = await prisma.subscription.findFirst({
    where: {
      orgId: org.id,
      status: { in: ["trialing", "active", "past_due"] },
    },
    orderBy: { currentPeriodStart: "desc" },
    select: { currentPeriodStart: true, currentPeriodEnd: true },
  });
  return subscriptionPeriod(sub) ?? monthlyPeriodFor(org.createdAt, now);
}

