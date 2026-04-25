/**
 * CLI entry: `pnpm -F @altium-mcp/metering reconcile`.
 *
 * Reads REDIS_URL + DATABASE_URL from env, sums UsageEvent rows for
 * each org's current period, and SETs the QuotaStore counters. Logs
 * a one-line-per-write summary so an operator running it manually
 * (or a future scheduler tailing its output) can spot drift.
 *
 * Idempotent: re-running converges to the same numbers. Safe to
 * invoke ad-hoc whenever you suspect Redis ate a counter.
 */

import { prisma } from "@altium-mcp/db";
import {
  __resetQuotaStoreCacheForTests,
  selectQuotaStore,
} from "./quota-store-factory.js";
import { reconcileQuotas } from "./reconciliation.js";

async function main(): Promise<void> {
  const store = selectQuotaStore();
  const result = await reconcileQuotas(prisma, store);
  console.log(
    `reconcile: visited ${result.orgs} orgs; ${result.writes.length} drift correction${result.writes.length === 1 ? "" : "s"}`
  );
  for (const w of result.writes) {
    console.log(`  ${w.orgId} ${w.metric}: ${w.before} → ${w.after}`);
  }
}

main()
  .catch((err) => {
    console.error("reconcile failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await __resetQuotaStoreCacheForTests();
  });
