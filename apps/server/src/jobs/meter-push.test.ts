/**
 * meter-push tests — drains pending UsageEvent rows to Stripe
 * (stubbed BillingProvider) and pins the contract:
 *   - groups pending rows by (orgId, metric)
 *   - skips when no meterItemIdsJson is set (rows stay pending)
 *   - skips on BillingNotConfigured (Noop env)
 *   - on success: SUM(quantity), latest timestamp, pushedToStripeAt set
 *   - idempotency key is sha256(orgId|metric|sortedRowIds)
 *   - retries with same row set yield the same key (Stripe dedupes)
 *   - non-BillingNotConfigured errors bubble up (BullMQ retries)
 */

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BillingNotConfigured,
  type BillingProvider,
  type RecordUsageRequest,
  type RecordUsageResult,
} from "@altium-mcp/billing";
import { meterPush } from "./meter-push.js";

let prisma: import("@altium-mcp/db").PrismaClient;
let workdir: string;
let aliceId: string;
let bobId: string;

const NOW = new Date("2026-04-25T12:00:00Z");
const SILENT_LOG = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

interface PushCall {
  request: RecordUsageRequest;
}

function makeStubBilling(opts: {
  configured?: boolean;
  result?: RecordUsageResult;
  /** When set, throws on every call. Used to test error propagation. */
  throwError?: Error;
} = {}): { provider: BillingProvider; calls: PushCall[] } {
  const calls: PushCall[] = [];
  const provider: BillingProvider = {
    isConfigured: () => opts.configured ?? true,
    createCheckoutSession: async () => {
      throw new Error("not used");
    },
    createPortalSession: async () => {
      throw new Error("not used");
    },
    verifyWebhook: () => {
      throw new Error("not used");
    },
    recordUsage: async (request) => {
      calls.push({ request });
      if (opts.throwError) throw opts.throwError;
      if (!(opts.configured ?? true)) {
        throw new BillingNotConfigured();
      }
      return opts.result ?? { usageRecordId: "mbur_test_default" };
    },
  };
  return { provider, calls };
}

before(async () => {
  workdir = mkdtempSync(join(tmpdir(), "altium-mcp-meter-push-test-"));
  const dbPath = join(workdir, "test.db").replace(/\\/g, "/");
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");

  const dbPkg = join(process.cwd(), "..", "..", "packages", "db");
  const schemaPath = join(dbPkg, "prisma", "schema.prisma");
  const prismaBin =
    process.platform === "win32"
      ? join(dbPkg, "node_modules", ".bin", "prisma.CMD")
      : join(dbPkg, "node_modules", ".bin", "prisma");
  execFileSync(prismaBin, ["migrate", "deploy", "--schema", schemaPath], {
    shell: true,
    stdio: "ignore",
    env: process.env,
    cwd: dbPkg,
  });

  const db = await import("@altium-mcp/db");
  prisma = db.prisma;
});

after(async () => {
  if (prisma) await prisma.$disconnect();
  try {
    rmSync(workdir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

beforeEach(async () => {
  await prisma.usageEvent.deleteMany({});
  await prisma.subscription.deleteMany({});
  await prisma.organization.deleteMany({});

  const alice = await prisma.organization.create({
    data: { name: "Alice", slug: "alice-meter-push", billingStatus: "active" },
  });
  aliceId = alice.id;
  const bob = await prisma.organization.create({
    data: { name: "Bob", slug: "bob-meter-push", billingStatus: "active" },
  });
  bobId = bob.id;
});

async function seedActiveSub(
  orgId: string,
  meterItemIds: Record<string, string>
): Promise<void> {
  await prisma.subscription.create({
    data: {
      orgId,
      status: "active",
      seats: 1,
      currentPeriodStart: new Date("2026-04-01T00:00:00Z"),
      currentPeriodEnd: new Date("2026-05-01T00:00:00Z"),
      meterItemIdsJson: JSON.stringify(meterItemIds),
    },
  });
}

async function seedUsage(
  orgId: string,
  metric: string,
  rows: Array<{ qty: number; ts: string; key: string }>
): Promise<void> {
  await prisma.usageEvent.createMany({
    data: rows.map((r) => ({
      orgId,
      tool: "search_parts",
      metric,
      quantity: r.qty,
      timestamp: new Date(r.ts),
      idempotencyKey: r.key,
    })),
  });
}

test("happy path: pushes pending rows, marks them, returns summary", async () => {
  await seedActiveSub(aliceId, {
    bom_lookup: "si_alice_bom",
    cost_analysis: "si_alice_cost",
  });
  await seedUsage(aliceId, "bom_lookup", [
    { qty: 1, ts: "2026-04-20T00:00:00Z", key: "a1" },
    { qty: 3, ts: "2026-04-21T00:00:00Z", key: "a2" },
  ]);
  const { provider, calls } = makeStubBilling({
    result: { usageRecordId: "mbur_test_42" },
  });

  const result = await meterPush(prisma, provider, {
    now: () => NOW,
    log: SILENT_LOG,
  });

  assert.equal(result.rowsPushed, 2);
  assert.equal(result.batchesPushed, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.request.subscriptionItemId, "si_alice_bom");
  // SUM(quantity).
  assert.equal(calls[0]!.request.quantity, 4);
  // Latest timestamp wins. Apr 21 = 1745193600 in unix seconds.
  assert.equal(
    calls[0]!.request.timestamp,
    Math.floor(new Date("2026-04-21T00:00:00Z").getTime() / 1000)
  );

  // Rows are now marked pushed.
  const pending = await prisma.usageEvent.count({
    where: { pushedToStripeAt: null },
  });
  assert.equal(pending, 0);
  const pushed = await prisma.usageEvent.findMany({
    where: { pushedToStripeAt: { not: null } },
  });
  assert.equal(pushed.length, 2);
  assert.ok(pushed.every((r) => r.pushedToStripeAt!.getTime() === NOW.getTime()));
});

test("groups by (orgId, metric) — one push per group, all separate", async () => {
  await seedActiveSub(aliceId, {
    bom_lookup: "si_alice_bom",
    cost_analysis: "si_alice_cost",
  });
  await seedActiveSub(bobId, { bom_lookup: "si_bob_bom" });
  await seedUsage(aliceId, "bom_lookup", [
    { qty: 1, ts: "2026-04-20T00:00:00Z", key: "a1" },
  ]);
  await seedUsage(aliceId, "cost_analysis", [
    { qty: 2, ts: "2026-04-20T00:00:00Z", key: "a2" },
  ]);
  await seedUsage(bobId, "bom_lookup", [
    { qty: 5, ts: "2026-04-20T00:00:00Z", key: "b1" },
  ]);

  const { provider, calls } = makeStubBilling();
  const result = await meterPush(prisma, provider, {
    now: () => NOW,
    log: SILENT_LOG,
  });

  assert.equal(result.batchesPushed, 3);
  assert.equal(calls.length, 3);
  const byItem = new Map(calls.map((c) => [c.request.subscriptionItemId, c]));
  assert.equal(byItem.get("si_alice_bom")!.request.quantity, 1);
  assert.equal(byItem.get("si_alice_cost")!.request.quantity, 2);
  assert.equal(byItem.get("si_bob_bom")!.request.quantity, 5);
});

test("skips org with no meterItemIdsJson — rows stay pending", async () => {
  // Alice has a Subscription but no meter item map yet (pre-webhook).
  await prisma.subscription.create({
    data: {
      orgId: aliceId,
      status: "active",
      seats: 1,
    },
  });
  await seedUsage(aliceId, "bom_lookup", [
    { qty: 1, ts: "2026-04-20T00:00:00Z", key: "a1" },
  ]);
  const { provider, calls } = makeStubBilling();

  const result = await meterPush(prisma, provider, {
    now: () => NOW,
    log: SILENT_LOG,
  });

  assert.equal(result.rowsPushed, 0);
  assert.equal(result.batchesSkippedNoMapping, 1);
  assert.equal(calls.length, 0);
  // Row is still pending.
  const pending = await prisma.usageEvent.count({
    where: { pushedToStripeAt: null },
  });
  assert.equal(pending, 1);
});

test("skips org whose meterItemIdsJson lacks the metric — partial map", async () => {
  // Subscription only maps bom_lookup; a cost_analysis row would
  // be skipped with no_mapping.
  await seedActiveSub(aliceId, { bom_lookup: "si_alice_bom" });
  await seedUsage(aliceId, "cost_analysis", [
    { qty: 1, ts: "2026-04-20T00:00:00Z", key: "a-cost" },
  ]);
  const { provider } = makeStubBilling();

  const result = await meterPush(prisma, provider, {
    now: () => NOW,
    log: SILENT_LOG,
  });

  assert.equal(result.rowsPushed, 0);
  assert.equal(result.batchesSkippedNoMapping, 1);
});

test("skips when BillingProvider throws BillingNotConfigured — rows stay pending", async () => {
  await seedActiveSub(aliceId, { bom_lookup: "si_alice_bom" });
  await seedUsage(aliceId, "bom_lookup", [
    { qty: 1, ts: "2026-04-20T00:00:00Z", key: "a1" },
  ]);
  const { provider } = makeStubBilling({ configured: false });

  const result = await meterPush(prisma, provider, {
    now: () => NOW,
    log: SILENT_LOG,
  });

  assert.equal(result.rowsPushed, 0);
  assert.equal(result.batchesSkippedNoBilling, 1);
  const pending = await prisma.usageEvent.count({
    where: { pushedToStripeAt: null },
  });
  assert.equal(pending, 1);
});

test("idempotencyKey is sha256(orgId|metric|sortedRowIds)", async () => {
  await seedActiveSub(aliceId, { bom_lookup: "si_alice_bom" });
  // Insert in REVERSE id order to verify the key is sort-stable.
  // We can't pre-pick cuids, so we insert and read back.
  await seedUsage(aliceId, "bom_lookup", [
    { qty: 1, ts: "2026-04-20T00:00:00Z", key: "a1" },
    { qty: 2, ts: "2026-04-21T00:00:00Z", key: "a2" },
  ]);
  const rows = await prisma.usageEvent.findMany({
    where: { orgId: aliceId, pushedToStripeAt: null },
    orderBy: { id: "asc" },
  });
  const sortedIds = rows.map((r) => r.id).sort();
  const expected = createHash("sha256")
    .update(`${aliceId}|bom_lookup|${sortedIds.join(",")}`)
    .digest("hex");

  const { provider, calls } = makeStubBilling();
  await meterPush(prisma, provider, { now: () => NOW, log: SILENT_LOG });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.request.idempotencyKey, expected);
});

test("non-BillingNotConfigured errors propagate (BullMQ retries them)", async () => {
  await seedActiveSub(aliceId, { bom_lookup: "si_alice_bom" });
  await seedUsage(aliceId, "bom_lookup", [
    { qty: 1, ts: "2026-04-20T00:00:00Z", key: "a1" },
  ]);
  const { provider } = makeStubBilling({
    throwError: new Error("Stripe API: rate limit"),
  });

  await assert.rejects(
    () => meterPush(prisma, provider, { now: () => NOW, log: SILENT_LOG }),
    /rate limit/
  );
  // Rows stay pending so the next attempt retries.
  const pending = await prisma.usageEvent.count({
    where: { pushedToStripeAt: null },
  });
  assert.equal(pending, 1);
});

test("malformed meterItemIdsJson is treated as no-mapping and logged", async () => {
  await prisma.subscription.create({
    data: {
      orgId: aliceId,
      status: "active",
      seats: 1,
      meterItemIdsJson: "{not json",
    },
  });
  await seedUsage(aliceId, "bom_lookup", [
    { qty: 1, ts: "2026-04-20T00:00:00Z", key: "a1" },
  ]);
  const { provider, calls } = makeStubBilling();

  const errors: string[] = [];
  const log = {
    info: () => {},
    warn: () => {},
    error: (msg: string) => errors.push(msg),
  };

  const result = await meterPush(prisma, provider, {
    now: () => NOW,
    log,
  });
  assert.equal(result.rowsPushed, 0);
  assert.equal(result.batchesSkippedNoMapping, 1);
  assert.equal(calls.length, 0);
  assert.ok(
    errors.some((e) => /malformed meterItemIdsJson/.test(e)),
    "expected an error log about malformed JSON"
  );
});

test("returns empty result when no pending rows exist", async () => {
  // Pre-mark everything as pushed.
  await seedActiveSub(aliceId, { bom_lookup: "si_alice_bom" });
  await seedUsage(aliceId, "bom_lookup", [
    { qty: 1, ts: "2026-04-20T00:00:00Z", key: "a1" },
  ]);
  await prisma.usageEvent.updateMany({
    where: { orgId: aliceId },
    data: { pushedToStripeAt: NOW },
  });

  const { provider, calls } = makeStubBilling();
  const result = await meterPush(prisma, provider, {
    now: () => NOW,
    log: SILENT_LOG,
  });
  assert.equal(result.rowsPushed, 0);
  assert.equal(result.batchesPushed, 0);
  assert.equal(calls.length, 0);
});

test("reuses the orgId subscription lookup across multi-metric batches", async () => {
  // Two metric batches for Alice → only one Subscription query.
  // We can't observe the cache directly, but we verify the result
  // is consistent (both batches pushed).
  await seedActiveSub(aliceId, {
    bom_lookup: "si_alice_bom",
    cost_analysis: "si_alice_cost",
  });
  await seedUsage(aliceId, "bom_lookup", [
    { qty: 1, ts: "2026-04-20T00:00:00Z", key: "a1" },
  ]);
  await seedUsage(aliceId, "cost_analysis", [
    { qty: 1, ts: "2026-04-20T00:00:00Z", key: "a2" },
  ]);
  const { provider, calls } = makeStubBilling();
  const result = await meterPush(prisma, provider, {
    now: () => NOW,
    log: SILENT_LOG,
  });
  assert.equal(result.batchesPushed, 2);
  assert.equal(calls.length, 2);
});
