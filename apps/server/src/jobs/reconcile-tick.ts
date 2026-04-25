/**
 * Reconciliation tick — thin wrapper over @altium-mcp/metering's
 * `reconcileQuotas`. Adds a logger pass-through so worker / CLI
 * runs surface drift corrections in the same stream as the rest
 * of the app.
 *
 * The actual sum-by-metric logic lives in
 * packages/metering/src/reconciliation.ts (already covered there).
 * This wrapper exists so the worker has a single function to wire
 * as a recurring job, and the CLI has a stable entry point.
 */

import type { PrismaClient } from "@altium-mcp/db";
import { reconcileQuotas, type QuotaStore } from "@altium-mcp/metering";

export interface ReconcileTickDeps {
  now?: () => Date;
  log?: Pick<Console, "info" | "warn" | "error">;
}

export interface ReconcileTickResult {
  orgs: number;
  writes: number;
}

export async function reconcileTick(
  prisma: PrismaClient,
  store: QuotaStore,
  deps: ReconcileTickDeps = {}
): Promise<ReconcileTickResult> {
  const log = deps.log ?? console;
  const result = await reconcileQuotas(prisma, store, { now: deps.now });
  if (result.writes.length > 0) {
    log.info(
      `reconcile-tick: visited ${result.orgs} orgs; ${result.writes.length} drift correction(s)`
    );
    for (const w of result.writes) {
      log.info(
        `  ${w.orgId} ${w.metric}: ${w.before} → ${w.after}`
      );
    }
  } else {
    log.info(`reconcile-tick: visited ${result.orgs} orgs; no drift`);
  }
  return { orgs: result.orgs, writes: result.writes.length };
}
