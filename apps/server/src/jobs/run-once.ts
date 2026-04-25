/**
 * CLI entry: `pnpm -F @altium-mcp/server run-job <name>`.
 *
 * Runs a metering job synchronously without going through BullMQ.
 * Useful for ad-hoc operator runs ("did the meter-push pick up
 * those rows yet?"), and as a smoke test before a release.
 *
 * Usage:
 *   pnpm -F @altium-mcp/server run-job meter-push
 *   pnpm -F @altium-mcp/server run-job reconcile-tick
 */

import { prisma } from "@altium-mcp/db";
import { selectBillingProvider } from "@altium-mcp/billing";
import {
  __resetQuotaStoreCacheForTests,
  selectQuotaStore,
} from "@altium-mcp/metering";
import { meterPush } from "./meter-push.js";
import { reconcileTick } from "./reconcile-tick.js";

async function main(): Promise<void> {
  const jobName = process.argv[2];
  if (!jobName) {
    console.error("usage: run-job <meter-push|reconcile-tick>");
    process.exitCode = 2;
    return;
  }
  const billing = selectBillingProvider();
  const store = selectQuotaStore();

  switch (jobName) {
    case "meter-push": {
      const result = await meterPush(prisma, billing);
      console.log(
        `meter-push: pushed ${result.rowsPushed} row(s) in ${result.batchesPushed} batch(es); ` +
          `skipped ${result.batchesSkippedNoMapping} (no mapping), ` +
          `${result.batchesSkippedNoBilling} (no billing)`
      );
      for (const p of result.pushes) {
        console.log(
          `  ${p.orgId} ${p.metric}: ${p.rowCount} row(s), qty=${p.quantity}, ` +
            `record=${p.usageRecordId}`
        );
      }
      return;
    }
    case "reconcile-tick": {
      const result = await reconcileTick(prisma, store);
      console.log(
        `reconcile-tick: visited ${result.orgs} orgs; ${result.writes} drift correction(s)`
      );
      return;
    }
    default:
      console.error(`unknown job: ${jobName}`);
      process.exitCode = 2;
  }
}

main()
  .catch((err) => {
    console.error("run-job failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await __resetQuotaStoreCacheForTests();
  });
