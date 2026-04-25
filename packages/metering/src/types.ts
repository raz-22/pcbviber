/**
 * Public types for the metering layer.
 *
 * Per the internal design spec §4.4, the meter wrapper sits in
 * front of every revenue-relevant tool call:
 *
 *   async function meter(org, tool, fn) {
 *     const quota = await getQuota(org, tool);
 *     if (quota.remaining <= 0 && !org.overageAllowed) throw QuotaExceeded();
 *     const result = await fn();
 *     await recordUsage(org, tool, 1);
 *     return result;
 *   }
 *
 * The interfaces here keep that wrapper provider-agnostic: this
 * package ships an in-memory QuotaStore; a Redis-backed store can
 * slot in behind the same interface, and Stripe meter pushes can
 * drain UsageEvent rows from a separate background job.
 */

/**
 * Stable vocabulary of metric names. The spec (§1, §4.4) bills three
 * meters: cheap reads (`bom_lookup`), the BOM cost analyzer
 * (`cost_analysis`), and the manufacturing export (`export`). Each
 * metered tool counts against exactly one metric.
 *
 * String union (not enum) so audit logs and Stripe meter ids can use
 * the value verbatim.
 */
export type Metric = "bom_lookup" | "cost_analysis" | "export";

export const KNOWN_METRICS: readonly Metric[] = [
  "bom_lookup",
  "cost_analysis",
  "export",
];

/**
 * Per-metric included allowance for a plan. `-1` is the sentinel for
 * "unlimited" (used by Enterprise). Stored as JSON-in-string on the
 * Plan.includedQuotas column so SQLite + Postgres share a wire shape.
 */
export interface PlanQuotas {
  bom_lookup: number;
  cost_analysis: number;
  export: number;
}

/**
 * Snapshot of a plan as the meter wrapper needs to see it. The
 * resolver hydrates this from a Plan row, an env-mapped fallback, or
 * a hardcoded free-tier default — all collapse to the same shape.
 */
export interface PlanSnapshot {
  /** "free" | "trialing" | "starter" | "team" | "enterprise". */
  name: string;
  quotas: PlanQuotas;
  /**
   * When true, requests past quota succeed and bill as overage. False
   * for free / trialing — those get a hard wall at the included cap.
   * Paid plans default to true; the spec's pricing table charges per
   * unit over the bundled allowance.
   */
  overageAllowed: boolean;
}

/**
 * Inclusive start, exclusive end. The QuotaStore keys counters by
 * `period.start.toISOString()` so the period boundary advance resets
 * counters automatically (no scheduled job needed for in-memory).
 */
export interface Period {
  start: Date;
  end: Date;
}

/**
 * Per-call context the meter wrapper needs. Routes assemble this
 * from req.ctx + req.id; tests pass it directly.
 */
export interface MeterContext {
  orgId: string;
  userId?: string | null;
  /**
   * Stable per-request identifier; goes into the UsageEvent
   * idempotency key. Fastify's req.id is the natural source.
   */
  requestId: string;
  plan: PlanSnapshot;
  period: Period;
}

/**
 * Per-call options. `units` defaults to 1; tools that bill per
 * quantity tier (e.g. `analyze_bom_cost`, per spec §4.4) override.
 */
export interface MeterOptions {
  tool: string;
  metric: Metric;
  units?: number;
}

/**
 * Thrown by `meter()` when the org has consumed its full allowance
 * AND overage is not allowed. Routes catch this and return 429 with
 * `error: "quota_exceeded"` — same stable-error-code pattern the
 * rest of the API uses.
 */
export class QuotaExceeded extends Error {
  readonly metric: Metric;
  readonly limit: number;
  readonly used: number;

  constructor(args: { metric: Metric; limit: number; used: number }) {
    super(`quota_exceeded: ${args.metric} limit=${args.limit} used=${args.used}`);
    this.name = "QuotaExceeded";
    this.metric = args.metric;
    this.limit = args.limit;
    this.used = args.used;
  }
}

/**
 * Storage abstraction for "units consumed by orgId|metric in the
 * current period". The in-memory implementation in this package
 * powers tests and dev; a Redis-backed implementation + hourly DB
 * reconciliation can slot in behind the same interface.
 */
export interface QuotaStore {
  /**
   * Returns the current consumption count for orgId|metric in the
   * period containing `period.start`. Returns 0 if no entry exists.
   */
  getUsed(orgId: string, metric: Metric, period: Period): Promise<number>;
  /**
   * Atomically increments orgId|metric by `units` within the given
   * period and returns the post-increment count. Implementations are
   * responsible for keying counters by `period.start` so a period
   * rollover starts fresh without an explicit reset.
   */
  increment(
    orgId: string,
    metric: Metric,
    units: number,
    period: Period
  ): Promise<number>;
  /**
   * Reconciliation-only escape hatch: SET the absolute counter.
   * Route code MUST use `increment` instead — accidentally calling
   * this from a request path would clobber a customer's mid-period
   * count. Reconciliation owns this method (it sums UsageEvent
   * rows hourly and writes the result here).
   */
  setExact(
    orgId: string,
    metric: Metric,
    value: number,
    period: Period
  ): Promise<void>;
  /**
   * Test-only: clear all counters. Production code must never call
   * this — a Redis-backed store would throw here so any production
   * caller fails loudly.
   */
  reset(): void;
}

/**
 * Persistence callback for a successful tool call. Defaults to the
 * Prisma-backed implementation in `usage-event.ts`; tests pass a
 * spy. The implementation MUST be idempotent on `idempotencyKey` so
 * a retry with the same requestId records exactly one row.
 *
 * Returns true when a new row was written, false when the
 * idempotency key was already present (the caller skips the
 * counter increment so retries don't double-decrement quota).
 */
export type RecordUsage = (entry: UsageEntry) => Promise<boolean>;

export interface UsageEntry {
  orgId: string;
  userId?: string | null;
  tool: string;
  metric: Metric;
  quantity: number;
  idempotencyKey: string;
}
