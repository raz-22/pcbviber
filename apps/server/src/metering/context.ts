/**
 * Server-side glue between the tenant middleware and @altium-mcp/metering.
 *
 * Routes that meter a tool call do this:
 *
 *     const ctx = await buildMeterContext(req, deps);
 *     return await meter(ctx, { tool, metric, units }, async () => {...}, deps.metering);
 *
 * `buildMeterContext` runs ONE Prisma query (latest non-terminal
 * Subscription with its Plan) and synthesizes the MeterContext from
 * `req.ctx` (already populated by `requireOrgRole`) + that row +
 * `req.id` (for the idempotency key).
 *
 * Routes that throw QuotaExceeded surface it here as 429 + a stable
 * error code. The catch sits inline in the route — no global error
 * handler — so other errors keep their existing routing.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "@altium-mcp/db";
import {
  QuotaExceeded,
  priceMapFromEnv,
  resolveQuotaForOrg,
  type MeterContext,
} from "@altium-mcp/metering";

export interface BuildMeterContextDeps {
  /**
   * Optional now() override for tests. Production omits — defaults
   * to the current wallclock time. Tests pass a fixed Date so the
   * monthly-period anchor is deterministic.
   */
  now?: () => Date;
}

/**
 * Loads the org's billing context from Prisma and returns a
 * `MeterContext` ready for the meter() wrapper. Caller MUST have
 * already chained `requireOrgRole` so `req.ctx` is populated.
 */
export async function buildMeterContext(
  req: FastifyRequest,
  deps: BuildMeterContextDeps = {}
): Promise<MeterContext> {
  if (!req.ctx) {
    throw new Error("buildMeterContext: req.ctx not set (require chain wrong)");
  }
  return buildMeterContextForOrg(
    {
      orgId: req.ctx.org.id,
      userId: req.ctx.user.id,
      requestId: String(req.id),
    },
    deps
  );
}

/**
 * MCP transport variant: builds a MeterContext from an API-key-
 * authenticated request. The API-key middleware populates
 * `req.apiKeyCtx.org.id` but there's no `userId` (API keys
 * authenticate at org level, not user level), so we record null
 * on the UsageEvent. Otherwise identical to buildMeterContext.
 */
export async function buildApiKeyMeterContext(
  req: FastifyRequest,
  deps: BuildMeterContextDeps = {}
): Promise<MeterContext> {
  if (!req.apiKeyCtx) {
    throw new Error(
      "buildApiKeyMeterContext: req.apiKeyCtx not set (require chain wrong)"
    );
  }
  return buildMeterContextForOrg(
    {
      orgId: req.apiKeyCtx.org.id,
      userId: null,
      requestId: String(req.id),
    },
    deps
  );
}

/**
 * Shared core: looks up the org's createdAt/billingStatus and
 * latest non-terminal Subscription, then runs them through the
 * @altium-mcp/metering plan resolver. Both web-session and
 * API-key callers wrap this.
 */
async function buildMeterContextForOrg(
  args: { orgId: string; userId: string | null; requestId: string },
  deps: BuildMeterContextDeps
): Promise<MeterContext> {
  // We need: createdAt + billingStatus from Organization, plus the
  // latest non-terminal Subscription with its Plan. Two queries;
  // the org load is cheap enough that we don't bother JOINing.
  const [org, subscription] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: args.orgId },
      select: { id: true, createdAt: true, billingStatus: true },
    }),
    prisma.subscription.findFirst({
      where: {
        orgId: args.orgId,
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
    // The auth/api-key middleware verified the org against
    // Membership / ApiKey before we got here. Disappearance
    // between that query and now is a race we can't recover from.
    throw new Error("buildMeterContext: organization vanished");
  }

  const now = deps.now?.() ?? new Date();
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

  return {
    orgId: org.id,
    userId: args.userId,
    requestId: args.requestId,
    plan,
    period,
  };
}

/**
 * Maps QuotaExceeded → 429 with the stable `quota_exceeded` error
 * code. Routes call this in their catch block; other errors fall
 * through to the route's existing handling (typically `upstream_error`).
 *
 * Returns true when the error was handled (caller should `return`),
 * false when it was unrecognized (caller rethrows or maps).
 */
export function handleQuotaError(
  err: unknown,
  reply: FastifyReply
): err is QuotaExceeded {
  if (err instanceof QuotaExceeded) {
    reply.code(429);
    reply.send({
      error: "quota_exceeded",
      detail: {
        metric: err.metric,
        limit: err.limit,
        used: err.used,
      },
    });
    return true;
  }
  return false;
}
