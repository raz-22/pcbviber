/**
 * BullMQ worker scaffolding for the metering background jobs.
 *
 * Two recurring jobs share one queue + worker:
 *   - `meter-push`     every 60s  (drains UsageEvent → Stripe)
 *   - `reconcile-tick` every 1h   (rebuilds counters from DB)
 *
 * BullMQ's repeat scheduler is Redis-coordinated: every server
 * replica boots `startWorker()`, but the recurring trigger fires
 * once per cycle across all replicas (lock + ZSET). No leader-
 * election scaffolding needed. If we ever extract a separate
 * worker process (Fly machine split), the same code runs there
 * with the HTTP boot omitted.
 *
 * Failure handling: BullMQ retries with exponential backoff. We
 * configure 5 attempts; after exhaustion the job hits the failed
 * set and a future operator alert (Sentry, hardening sprint)
 * picks it up. For "expected" skips (no Stripe configured, no
 * subscription mapping yet) the job functions log + return
 * normally so retries don't fire.
 */

import { Queue, Worker, type ConnectionOptions } from "bullmq";
import type { PrismaClient } from "@altium-mcp/db";
import type { BillingProvider } from "@altium-mcp/billing";
import type { QuotaStore } from "@altium-mcp/metering";
import { meterPush } from "./meter-push.js";
import { reconcileTick } from "./reconcile-tick.js";

/**
 * Queue name namespacing keeps jobs collision-free in shared Redis.
 * BullMQ disallows `:` in queue names (it uses the colon as an
 * internal key separator), so we use a hyphenated form here while
 * the QuotaStore — which we control end-to-end — keeps the
 * `altium-mcp:quota:` prefix on its own keys.
 */
export const METERING_QUEUE_NAME = "altium-mcp-metering";

/** Job names as registered in the queue. Stable for log scraping. */
export const JOB_METER_PUSH = "meter-push";
export const JOB_RECONCILE_TICK = "reconcile-tick";

/**
 * Tuned for the metering use case. Push is the hot path:
 *   60_000 ms → run every minute
 * Reconcile is the safety net:
 *   3_600_000 ms → run every hour
 */
export const METER_PUSH_INTERVAL_MS = 60_000;
export const RECONCILE_TICK_INTERVAL_MS = 3_600_000;

export interface StartWorkerDeps {
  prisma: PrismaClient;
  billing: BillingProvider;
  store: QuotaStore;
  /**
   * BullMQ connection. Production passes the same ioredis client
   * the QuotaStore uses; tests pass an ioredis-mock. BullMQ holds
   * its own internal connection pool but accepts a base options
   * object — we forward whatever gets us a working Redis.
   */
  connection: ConnectionOptions;
  log?: Pick<Console, "info" | "warn" | "error">;
}

export interface MeteringWorker {
  queue: Queue;
  worker: Worker;
  /** Graceful shutdown — close worker + queue, drain in-flight jobs. */
  close: () => Promise<void>;
}

/**
 * Creates the queue, registers the two recurring jobs, starts a
 * worker. Returns handles + a `close()` for SIGTERM. Idempotent on
 * the recurring registrations: BullMQ deduplicates by repeat key,
 * so calling `startWorker` twice in a row (e.g. boot + reload)
 * does not enqueue duplicate cycles.
 */
export async function startWorker(deps: StartWorkerDeps): Promise<MeteringWorker> {
  const log = deps.log ?? console;
  const queue = new Queue(METERING_QUEUE_NAME, { connection: deps.connection });

  // Register the two recurring jobs. `add` with `repeat.every`
  // creates a repeatable job key; subsequent boots find the same
  // key and don't double-schedule.
  await queue.add(
    JOB_METER_PUSH,
    {},
    {
      repeat: { every: METER_PUSH_INTERVAL_MS },
      // Keep failed jobs around for a day so we can inspect them;
      // succeeded jobs roll off after 1000 entries (cheap) so the
      // queue doesn't grow unbounded.
      removeOnComplete: { count: 1000 },
      removeOnFail: { age: 86_400 },
      attempts: 5,
      backoff: { type: "exponential", delay: 5000 },
    }
  );
  await queue.add(
    JOB_RECONCILE_TICK,
    {},
    {
      repeat: { every: RECONCILE_TICK_INTERVAL_MS },
      removeOnComplete: { count: 100 },
      removeOnFail: { age: 86_400 * 7 },
      attempts: 3,
      backoff: { type: "exponential", delay: 30_000 },
    }
  );

  const worker = new Worker(
    METERING_QUEUE_NAME,
    async (job) => {
      switch (job.name) {
        case JOB_METER_PUSH:
          return await meterPush(deps.prisma, deps.billing, { log });
        case JOB_RECONCILE_TICK:
          return await reconcileTick(deps.prisma, deps.store, { log });
        default:
          // Unknown job in the metering queue. BullMQ throws → job
          // hits the failed set; alert via Sentry once wired.
          throw new Error(`unknown metering job: ${job.name}`);
      }
    },
    { connection: deps.connection }
  );

  worker.on("failed", (job, err) => {
    log.error(
      `metering worker: job ${job?.name ?? "<unknown>"} failed (attempt ` +
        `${job?.attemptsMade ?? "?"}): ${err.message}`
    );
  });

  log.info(
    `metering worker started — push every ${METER_PUSH_INTERVAL_MS / 1000}s, ` +
      `reconcile every ${RECONCILE_TICK_INTERVAL_MS / 1000}s`
  );

  return {
    queue,
    worker,
    async close() {
      // Worker first so in-flight jobs finish; then queue (which
      // holds the scheduler). BullMQ's `close` resolves once the
      // current job (if any) returns.
      await worker.close();
      await queue.close();
    },
  };
}
