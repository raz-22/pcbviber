/**
 * Resolves the active plan + billing period for an org.
 *
 * The chain (per the Sprint 5 PR 5.1 design):
 *   1. Latest non-terminal Subscription row → load its Plan.
 *   2. If Plan link missing but Subscription.stripePriceId is set,
 *      map via env (STRIPE_PRICE_STARTER_SEAT / STRIPE_PRICE_TEAM_SEAT)
 *      to a known Plan name; load that row.
 *   3. No subscription at all → fall back to a hardcoded snapshot:
 *      "trialing" orgs get team-equivalent quotas (matches the
 *      14-day Team-plan trial in spec §3.1); "free" gets a tiny
 *      bucket; everything else (active without subscription — a
 *      data-integrity bug) gets the same conservative free default.
 *
 * Period: subscription window if present, else a monthly window
 * anchored on org.createdAt's day-of-month.
 *
 * Pure-ish: takes a `findPlanByName` callback so tests don't need
 * a live DB. Production callers wire it to Prisma in one line.
 */

import type { PlanQuotas, PlanSnapshot, Period } from "./types.js";
import { monthlyPeriodFor, subscriptionPeriod } from "./period.js";

/** Sentinel: -1 in a quota field means "no cap" (Enterprise). */
export const UNLIMITED = -1;

/**
 * Hardcoded baseline used as both the seed for Plan rows and the
 * fallback when no Plan row exists. Numbers come from spec §1.
 *
 * Each value is monthly. Stripe meter pushes (PR 5.3) bill the same
 * unit count to the metered Stripe price — these are kept in sync.
 */
export const PLAN_DEFAULTS: Record<string, PlanSnapshot> = {
  free: {
    name: "free",
    quotas: { bom_lookup: 100, cost_analysis: 5, export: 1 },
    overageAllowed: false,
  },
  trialing: {
    // Equivalent to the Team plan during the 14-day trial.
    name: "trialing",
    quotas: { bom_lookup: 5_000, cost_analysis: 500, export: 100 },
    overageAllowed: false,
  },
  starter: {
    name: "starter",
    quotas: { bom_lookup: 500, cost_analysis: 50, export: 10 },
    overageAllowed: true,
  },
  team: {
    name: "team",
    quotas: { bom_lookup: 5_000, cost_analysis: 500, export: 100 },
    overageAllowed: true,
  },
  enterprise: {
    name: "enterprise",
    quotas: { bom_lookup: UNLIMITED, cost_analysis: UNLIMITED, export: UNLIMITED },
    overageAllowed: true,
  },
};

export interface OrgSnapshot {
  id: string;
  createdAt: Date;
  /** "free" | "trialing" | "active" | "past_due" | "suspended" | "canceled". */
  billingStatus: string;
}

export interface SubscriptionSnapshot {
  planId: string | null;
  stripePriceId: string | null;
  status: string;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  /** Loaded from Plan relation when planId is set. */
  plan?: PlanRow | null;
}

export interface PlanRow {
  name: string;
  /** JSON-encoded PlanQuotas. */
  includedQuotas: string;
}

export interface ResolveQuotaInput {
  org: OrgSnapshot;
  /**
   * The latest non-terminal subscription (status ∈ {trialing, active,
   * past_due}). Caller does the SELECT; resolver doesn't run queries.
   * Null when no subscription has been created yet.
   */
  subscription: SubscriptionSnapshot | null;
  /**
   * Looks up a Plan row by name when the subscription has only a
   * stripePriceId (no planId link yet). Tests pass a stub that
   * returns null; callers wire to prisma.plan.findUnique.
   */
  findPlanByName: (name: string) => Promise<PlanRow | null>;
  /**
   * Stripe Price ID → plan name mapping. Caller pulls from env.
   * Empty entries are skipped; missing entries fall through to the
   * billingStatus-based default.
   */
  priceMap: Partial<Record<string, string>>;
  now: Date;
}

export interface ResolveQuotaResult {
  plan: PlanSnapshot;
  period: Period;
}

export async function resolveQuotaForOrg(
  input: ResolveQuotaInput
): Promise<ResolveQuotaResult> {
  const { org, subscription, findPlanByName, priceMap, now } = input;

  const period =
    subscriptionPeriod(subscription) ?? monthlyPeriodFor(org.createdAt, now);

  // 1. Subscription with linked Plan row.
  if (subscription?.plan) {
    const snapshot = planRowToSnapshot(subscription.plan);
    if (snapshot) return { plan: snapshot, period };
  }

  // 2. Subscription with stripePriceId → env-mapped plan name.
  if (subscription?.stripePriceId) {
    const mappedName = priceMap[subscription.stripePriceId];
    if (mappedName) {
      const row = await findPlanByName(mappedName);
      if (row) {
        const snapshot = planRowToSnapshot(row);
        if (snapshot) return { plan: snapshot, period };
      }
      // No seeded row but we know the plan name — use the hardcoded
      // default. Production seeds these on deploy; this is the
      // defensive path for an unseeded staging env.
      const fallback = PLAN_DEFAULTS[mappedName];
      if (fallback) return { plan: fallback, period };
    }
  }

  // 3. No subscription / no match → billingStatus-based default.
  const status = org.billingStatus;
  const defaultName =
    status === "trialing"
      ? "trialing"
      : status === "active" || status === "past_due"
        ? "free" // no plan link is a bug; treat as free until reconciled
        : "free";
  const snapshot = PLAN_DEFAULTS[defaultName] ?? PLAN_DEFAULTS["free"]!;
  return { plan: snapshot, period };
}

/**
 * Parses Plan.includedQuotas (JSON-in-string per the SQLite-portable
 * schema) into a PlanSnapshot. Returns null if the JSON is malformed
 * or missing required keys; callers fall back to PLAN_DEFAULTS.
 */
function planRowToSnapshot(row: PlanRow): PlanSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.includedQuotas);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const q = parsed as Record<string, unknown>;
  const isValid =
    typeof q.bom_lookup === "number" &&
    typeof q.cost_analysis === "number" &&
    typeof q.export === "number";
  if (!isValid) return null;
  const quotas: PlanQuotas = {
    bom_lookup: q.bom_lookup as number,
    cost_analysis: q.cost_analysis as number,
    export: q.export as number,
  };
  // Free + trialing are hard-walled; everything else allows overage.
  // Stored as a per-row column would be nicer but the SQLite schema
  // currently doesn't have one, so the rule lives here. Migrating
  // to Postgres in Sprint 6 is the natural moment to add it.
  const overageAllowed = !(row.name === "free" || row.name === "trialing");
  return { name: row.name, quotas, overageAllowed };
}

/**
 * Reads STRIPE_PRICE_STARTER_SEAT and STRIPE_PRICE_TEAM_SEAT from env
 * and returns a `{priceId: planName}` map. Empty / unset values are
 * skipped. Convenience wrapper around `process.env` so route code
 * never reaches into the env directly.
 */
export function priceMapFromEnv(env: NodeJS.ProcessEnv): Partial<Record<string, string>> {
  const map: Record<string, string> = {};
  const starter = env.STRIPE_PRICE_STARTER_SEAT?.trim();
  const team = env.STRIPE_PRICE_TEAM_SEAT?.trim();
  if (starter) map[starter] = "starter";
  if (team) map[team] = "team";
  return map;
}
