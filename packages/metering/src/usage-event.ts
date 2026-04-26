/**
 * Prisma-backed RecordUsage implementation.
 *
 * Idempotency: UsageEvent.idempotencyKey has a UNIQUE constraint
 * (see packages/db/prisma/schema.prisma). On a duplicate key the
 * Prisma client throws P2002 — we catch it and return false so the
 * caller knows the row already existed. Any other failure rethrows
 * (we want metering bugs to surface, not silently lose usage).
 *
 * Stripe meter pushes will drain UsageEvent rows in a background
 * job and call subscription_items.createUsageRecord; the
 * idempotencyKey doubles as the Stripe-side idempotency key on that
 * push, so retries through both layers stay consistent.
 *
 * Tenant scope: the INSERT is wrapped in a transaction that
 * `set_config('app.current_org_id', orgId)` + `SET LOCAL ROLE
 * altium_app`. Mirrors apps/server's `withTenantTx` helper but
 * inlined here so packages/metering doesn't take a dep on the
 * server. UsageEvent has RLS on `orgId`; the WITH CHECK gate now
 * enforces that an INSERT can only write a row for the org named
 * in the current transaction's tenant context. App-layer
 * `entry.orgId` is still the source of truth — RLS is defense in
 * depth on accidental cross-tenant writes.
 */

import { prisma, Prisma } from "@altium-mcp/db";
import type { RecordUsage } from "./types.js";

export const writeUsageEvent: RecordUsage = async (entry) => {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_org_id', ${entry.orgId}, true)`;
      // SET LOCAL ROLE is not parameterizable; `altium_app` is a
      // fixed identifier we control — no injection surface.
      await tx.$executeRawUnsafe("SET LOCAL ROLE altium_app");
      await tx.usageEvent.create({
        data: {
          orgId: entry.orgId,
          userId: entry.userId ?? null,
          tool: entry.tool,
          metric: entry.metric,
          quantity: entry.quantity,
          idempotencyKey: entry.idempotencyKey,
        },
      });
    });
    return true;
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      // Duplicate idempotency key — already recorded. Caller skips
      // the counter increment so retries don't double-decrement.
      return false;
    }
    throw err;
  }
};
