/**
 * Usage handler — computes the per-period consumption snapshot the
 * Settings → Usage page renders.
 *
 * Pure-ish: takes Prisma + orgId + a `now` clock, returns a plain
 * JSON-shaped object. No Fastify, no auth — the route layer wraps
 * this with `requireOrgRole` + `can(usage.read)` and shapes errors.
 *
 * Algorithm:
 *   1. Resolve the org's plan + current billing period via the
 *      same `resolveQuotaForOrg` the meter wrapper uses, so the
 *      dashboard can never disagree with the gate.
 *   2. groupBy UsageEvent for the period:
 *        - by metric → drives the headline progress bars
 *        - by tool   → drives the per-tool breakdown table
 *   3. Convert PlanQuotas to JSON: `-1` (UNLIMITED) becomes
 *      `null` so the SPA renders "∞" without leaking the sentinel.
 *
 * The byTool map is restricted to KNOWN_METERED_TOOLS so a corrupt
 * UsageEvent row with a typo'd tool name doesn't show up as a
 * mystery line item. (UsageEvent.tool isn't a foreign key, so
 * defense in depth.)
 */

import type { PrismaClient } from "@altium-mcp/db";
import {
  KNOWN_METRICS,
  priceMapFromEnv,
  resolveQuotaForOrg,
  UNLIMITED,
  type Metric,
} from "@altium-mcp/metering";
import { METERED_TOOLS } from "../jobs/metered-tools.js";

export interface UsageReportMetric {
  used: number;
  /** `null` means unlimited (Enterprise). */
  limit: number | null;
}

export interface UsageReport {
  period: { start: string; end: string };
  plan: { name: string; overageAllowed: boolean };
  metrics: Record<Metric, UsageReportMetric>;
  /** Per-tool counts. Only spec §4.4 metered tools appear. */
  byTool: Record<string, number>;
}

export interface BuildUsageReportDeps {
  /** Override clock for hermetic tests. */
  now?: () => Date;
}

export async function buildUsageReport(
  prisma: PrismaClient,
  orgId: string,
  deps: BuildUsageReportDeps = {}
): Promise<UsageReport> {
  const now = deps.now?.() ?? new Date();

  // Org + latest non-terminal Subscription, in parallel. Same shape
  // the meter context builder uses; keeping the lookups identical
  // is what guarantees the dashboard and the gate see the same plan.
  const [org, subscription] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: orgId },
      select: { id: true, createdAt: true, billingStatus: true },
    }),
    prisma.subscription.findFirst({
      where: {
        orgId,
        status: { in: ["trialing", "active", "past_due"] },
      },
      orderBy: { currentPeriodStart: "desc" },
      select: {
        planId: true,
        stripePriceId: true,
        status: true,
        currentPeriodStart: true,
        currentPeriodEnd: true,
        plan: { select: { name: true, includedQuotas: true } },
      },
    }),
  ]);

  if (!org) {
    // requireOrgRole already verified Membership against this org;
    // disappearance between that query and now is an unrecoverable
    // race. Caller maps to 404.
    throw new Error(`usage: organization ${orgId} vanished`);
  }

  const { plan, period } = await resolveQuotaForOrg({
    org: {
      id: org.id,
      createdAt: org.createdAt,
      billingStatus: org.billingStatus,
    },
    subscription: subscription
      ? {
          planId: subscription.planId,
          stripePriceId: subscription.stripePriceId,
          status: subscription.status,
          currentPeriodStart: subscription.currentPeriodStart,
          currentPeriodEnd: subscription.currentPeriodEnd,
          plan: subscription.plan,
        }
      : null,
    findPlanByName: async (name) =>
      prisma.plan.findUnique({
        where: { name },
        select: { name: true, includedQuotas: true },
      }),
    priceMap: priceMapFromEnv(process.env),
    now,
  });

  // Two grouped queries hit the same (orgId, timestamp) index. The
  // tool-level groupBy is just for display; the metric-level one is
  // what gates billing-related decisions.
  const [byMetric, byTool] = await Promise.all([
    prisma.usageEvent.groupBy({
      by: ["metric"],
      where: {
        orgId,
        timestamp: { gte: period.start, lt: period.end },
      },
      _sum: { quantity: true },
    }),
    prisma.usageEvent.groupBy({
      by: ["tool"],
      where: {
        orgId,
        timestamp: { gte: period.start, lt: period.end },
      },
      _sum: { quantity: true },
    }),
  ]);

  // Build the metrics map covering every known metric (zero-filled
  // for ones with no rows). Limit -1 → null in JSON.
  const usedByMetric = new Map<Metric, number>();
  for (const row of byMetric) {
    usedByMetric.set(row.metric as Metric, row._sum.quantity ?? 0);
  }
  const metrics = {} as Record<Metric, UsageReportMetric>;
  for (const m of KNOWN_METRICS) {
    const limit = plan.quotas[m];
    metrics[m] = {
      used: usedByMetric.get(m) ?? 0,
      limit: limit === UNLIMITED ? null : limit,
    };
  }

  // Per-tool: zero-fill known metered tools, drop unknown rows.
  const usedByTool = new Map<string, number>();
  for (const row of byTool) {
    if (row.tool in METERED_TOOLS) {
      usedByTool.set(row.tool, row._sum.quantity ?? 0);
    }
  }
  const byToolMap: Record<string, number> = {};
  for (const tool of Object.keys(METERED_TOOLS)) {
    byToolMap[tool] = usedByTool.get(tool) ?? 0;
  }

  return {
    period: {
      start: period.start.toISOString(),
      end: period.end.toISOString(),
    },
    plan: { name: plan.name, overageAllowed: plan.overageAllowed },
    metrics,
    byTool: byToolMap,
  };
}
