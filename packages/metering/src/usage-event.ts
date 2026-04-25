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
 */

import { prisma, Prisma } from "@altium-mcp/db";
import type { RecordUsage } from "./types.js";

export const writeUsageEvent: RecordUsage = async (entry) => {
  try {
    await prisma.usageEvent.create({
      data: {
        orgId: entry.orgId,
        userId: entry.userId ?? null,
        tool: entry.tool,
        metric: entry.metric,
        quantity: entry.quantity,
        idempotencyKey: entry.idempotencyKey,
      },
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
