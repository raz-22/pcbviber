/**
 * Meter-push job — drains pending UsageEvent rows to Stripe.
 *
 * Per spec §4.4: "Push to Stripe via subscription_items.createUsageRecord
 * in a background job (BullMQ) — never in the request path. Batch
 * every 60s."
 *
 * Pure-ish function: takes Prisma + a BillingProvider + `now`,
 * returns a per-batch summary. The BullMQ worker layer wraps this
 * in a recurring job; tests call it directly with a stub provider.
 *
 * Algorithm per cycle:
 *   1. Pull every UsageEvent with `pushedToStripeAt = null`.
 *   2. Group by (orgId, metric).
 *   3. For each group:
 *      a. Resolve subscription_item id from
 *         Subscription.meterItemIdsJson[metric]. Missing → skip
 *         + log; rows stay pending for the next cycle.
 *      b. Compute idempotencyKey = sha256(orgId|metric|sortedIds).
 *         Stable across retries on the same row set.
 *      c. Sum quantity, take latest timestamp as the Stripe
 *         usage-record timestamp.
 *      d. Call provider.recordUsage(...).
 *      e. On success: UPDATE pushedToStripeAt = now() on every
 *         row in the batch (atomic per Prisma updateMany).
 *      f. BillingNotConfigured → skip + log; rows stay pending so
 *         re-running once Stripe is wired correctly back-fills.
 *      g. Other errors → throw; BullMQ retries with backoff.
 *
 * Idempotency: Stripe preserves the original response on a
 * duplicate idempotencyKey. If the SQL UPDATE fails after Stripe
 * accepted, the next cycle re-pushes the same rows with the same
 * key and Stripe returns the same record id — no double-billing.
 */

import { createHash } from "node:crypto";
import type { PrismaClient } from "@altium-mcp/db";
import {
  BillingNotConfigured,
  type BillingProvider,
} from "@altium-mcp/billing";

export interface MeterPushDeps {
  /** Override `Date.now()` for hermetic tests. */
  now?: () => Date;
  /**
   * Caller-supplied logger. Defaults to `console`. Production wiring
   * passes Fastify's logger so push events hit the same stream as
   * the rest of the app.
   */
  log?: Pick<Console, "info" | "warn" | "error">;
}

export interface MeterPushResult {
  /** Total UsageEvent rows successfully pushed in this run. */
  rowsPushed: number;
  /** Number of (orgId, metric) batches that hit Stripe. */
  batchesPushed: number;
  /** Batches skipped because no meterItemIdsJson mapping was set. */
  batchesSkippedNoMapping: number;
  /** Batches skipped because the BillingProvider is the Noop. */
  batchesSkippedNoBilling: number;
  /**
   * Per-batch detail. Useful for the CLI / scheduler log so an
   * operator can audit what got pushed without trawling Stripe.
   */
  pushes: Array<{
    orgId: string;
    metric: string;
    rowCount: number;
    quantity: number;
    usageRecordId: string;
  }>;
}

interface PendingRow {
  id: string;
  orgId: string;
  metric: string;
  quantity: number;
  timestamp: Date;
}

/**
 * Walks pending UsageEvent rows, batches by (orgId, metric), and
 * pushes each batch to Stripe. Returns a structured summary; logs
 * the salient skip / error reasons via the injected logger.
 */
export async function meterPush(
  prisma: PrismaClient,
  billing: BillingProvider,
  deps: MeterPushDeps = {}
): Promise<MeterPushResult> {
  const now = deps.now?.() ?? new Date();
  const log = deps.log ?? console;
  const result: MeterPushResult = {
    rowsPushed: 0,
    batchesPushed: 0,
    batchesSkippedNoMapping: 0,
    batchesSkippedNoBilling: 0,
    pushes: [],
  };

  // Pull every pending row in one query. For very large backlogs this
  // would need pagination, but in steady state the cycle ships every
  // 60s so the working set stays bounded by RPS × 60. Sort by id so
  // the idempotencyKey hash is deterministic across runs.
  const pending = await prisma.usageEvent.findMany({
    where: { pushedToStripeAt: null },
    select: {
      id: true,
      orgId: true,
      metric: true,
      quantity: true,
      timestamp: true,
    },
    orderBy: { id: "asc" },
  });
  if (pending.length === 0) return result;

  // Group by (orgId, metric). Map keys are "orgId|metric" so we can
  // hand the array to the per-batch push without re-grouping.
  const groups = new Map<string, PendingRow[]>();
  for (const row of pending) {
    const key = `${row.orgId}|${row.metric}`;
    let arr = groups.get(key);
    if (!arr) {
      arr = [];
      groups.set(key, arr);
    }
    arr.push(row);
  }

  // Cache subscription lookups: a single cycle may have many batches
  // for the same org. One query per org, not per batch.
  const meterItemsByOrg = new Map<string, Record<string, string> | null>();

  for (const [, batch] of groups) {
    const orgId = batch[0]!.orgId;
    const metric = batch[0]!.metric;
    const itemMap = await loadMeterItemsForOrg(
      prisma,
      orgId,
      meterItemsByOrg,
      log
    );
    const subscriptionItemId = itemMap?.[metric];
    if (!subscriptionItemId) {
      result.batchesSkippedNoMapping += 1;
      log.warn(
        `meter-push: skipping ${batch.length} ${metric} row(s) for org ${orgId} ` +
          "— no subscription_item id in meterItemIdsJson"
      );
      continue;
    }

    const idempotencyKey = computeIdempotencyKey(orgId, metric, batch);
    const quantity = batch.reduce((acc, r) => acc + r.quantity, 0);
    // Stripe expects Unix seconds. Use the latest timestamp in the
    // batch — keeps the usage record landing in the same period as
    // the most recent activity.
    const timestamp = Math.floor(
      Math.max(...batch.map((r) => r.timestamp.getTime())) / 1000
    );

    try {
      const pushed = await billing.recordUsage({
        subscriptionItemId,
        quantity,
        timestamp,
        idempotencyKey,
      });
      // Mark every row in the batch as pushed. updateMany is atomic
      // in Prisma; partial failure here would surface as a thrown
      // error and BullMQ retries the whole batch (Stripe's
      // idempotencyKey then guards against double-billing).
      await prisma.usageEvent.updateMany({
        where: { id: { in: batch.map((r) => r.id) } },
        data: { pushedToStripeAt: now },
      });
      result.rowsPushed += batch.length;
      result.batchesPushed += 1;
      result.pushes.push({
        orgId,
        metric,
        rowCount: batch.length,
        quantity,
        usageRecordId: pushed.usageRecordId,
      });
    } catch (err) {
      if (err instanceof BillingNotConfigured) {
        result.batchesSkippedNoBilling += 1;
        log.warn(
          `meter-push: skipping ${batch.length} ${metric} row(s) for org ${orgId} ` +
            "— BillingProvider not configured"
        );
        continue;
      }
      // Unknown error — let it propagate so BullMQ retries with
      // backoff. Logging here so the cause shows up in the stream
      // even if the worker swallows the throw on retry exhaustion.
      log.error(
        `meter-push: Stripe push failed for org ${orgId} metric ${metric}: ` +
          (err instanceof Error ? err.message : String(err))
      );
      throw err;
    }
  }

  return result;
}

async function loadMeterItemsForOrg(
  prisma: PrismaClient,
  orgId: string,
  cache: Map<string, Record<string, string> | null>,
  log: Pick<Console, "info" | "warn" | "error">
): Promise<Record<string, string> | null> {
  if (cache.has(orgId)) return cache.get(orgId)!;
  // Most recent non-terminal subscription. Same query the meter
  // wrapper / reconciliation use for "pick a subscription".
  const sub = await prisma.subscription.findFirst({
    where: {
      orgId,
      status: { in: ["trialing", "active", "past_due"] },
    },
    orderBy: { currentPeriodStart: "desc" },
    select: { meterItemIdsJson: true },
  });
  if (!sub?.meterItemIdsJson) {
    cache.set(orgId, null);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(sub.meterItemIdsJson);
  } catch {
    log.error(
      `meter-push: org ${orgId} has malformed meterItemIdsJson; skipping`
    );
    cache.set(orgId, null);
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    cache.set(orgId, null);
    return null;
  }
  // Validate shape: every value must be a string.
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === "string" && v.length > 0) out[k] = v;
  }
  cache.set(orgId, out);
  return out;
}

function computeIdempotencyKey(
  orgId: string,
  metric: string,
  rows: ReadonlyArray<{ id: string }>
): string {
  // Sort row ids so the same set yields the same hash regardless of
  // insertion order. cuid() ids are time-sortable but we don't rely
  // on that here — explicit sort keeps the contract obvious.
  const ids = [...rows].map((r) => r.id).sort();
  return createHash("sha256")
    .update(`${orgId}|${metric}|${ids.join(",")}`)
    .digest("hex");
}
