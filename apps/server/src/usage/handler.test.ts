/**
 * Usage handler tests — pin the JSON shape the SPA reads + the
 * sums against UsageEvent rows. Live SQLite for prisma queries;
 * `now` is injected so the period anchor is deterministic.
 */

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildUsageReport } from "./handler.js";

let prisma: import("@altium-mcp/db").PrismaClient;
let workdir: string;
let aliceId: string;
let bobId: string;

const NOW = new Date("2026-04-15T00:00:00Z");

before(async () => {
  workdir = mkdtempSync(join(tmpdir(), "altium-mcp-usage-handler-"));
  const dbPath = join(workdir, "test.db").replace(/\\/g, "/");
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  delete process.env.STRIPE_PRICE_STARTER_SEAT;
  delete process.env.STRIPE_PRICE_TEAM_SEAT;

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
  await prisma.plan.deleteMany({});
  await prisma.organization.deleteMany({});
  // Anchor: org createdAt = Mar 15 → with NOW = Apr 15, the
  // monthly period is Apr 15 → May 15.
  const alice = await prisma.organization.create({
    data: {
      name: "Alice",
      slug: "alice-usage",
      createdAt: new Date("2026-03-15T00:00:00Z"),
    },
  });
  aliceId = alice.id;
  const bob = await prisma.organization.create({
    data: {
      name: "Bob",
      slug: "bob-usage",
      createdAt: new Date("2026-03-15T00:00:00Z"),
    },
  });
  bobId = bob.id;
});

test("free org with no rows: zero-filled metrics + period from createdAt", async () => {
  const report = await buildUsageReport(prisma, aliceId, { now: () => NOW });
  // Period is the synthesized monthly window anchored on createdAt.
  assert.equal(report.period.start, "2026-04-15T00:00:00.000Z");
  assert.equal(report.period.end, "2026-05-15T00:00:00.000Z");
  // Free plan default: small limits, no overage.
  assert.equal(report.plan.name, "free");
  assert.equal(report.plan.overageAllowed, false);
  // Every metric appears with used=0; limits come from PLAN_DEFAULTS.free.
  assert.equal(report.metrics.bom_lookup.used, 0);
  assert.equal(report.metrics.bom_lookup.limit, 100);
  assert.equal(report.metrics.cost_analysis.used, 0);
  assert.equal(report.metrics.export.used, 0);
  // Every known metered tool appears, all zero.
  assert.equal(report.byTool.search_parts, 0);
  assert.equal(report.byTool.export_manufacturing_data, 0);
});

test("sums UsageEvent rows by metric and by tool inside the current period", async () => {
  await prisma.usageEvent.createMany({
    data: [
      {
        orgId: aliceId,
        tool: "search_parts",
        metric: "bom_lookup",
        quantity: 1,
        idempotencyKey: "k1",
        timestamp: new Date("2026-04-20T00:00:00Z"),
      },
      {
        orgId: aliceId,
        tool: "search_parts",
        metric: "bom_lookup",
        quantity: 2,
        idempotencyKey: "k2",
        timestamp: new Date("2026-04-21T00:00:00Z"),
      },
      {
        orgId: aliceId,
        tool: "check_part_availability",
        metric: "bom_lookup",
        quantity: 4,
        idempotencyKey: "k3",
        timestamp: new Date("2026-04-22T00:00:00Z"),
      },
      {
        orgId: aliceId,
        tool: "analyze_bom_cost",
        metric: "cost_analysis",
        quantity: 1,
        idempotencyKey: "k4",
        timestamp: new Date("2026-04-23T00:00:00Z"),
      },
    ],
  });

  const report = await buildUsageReport(prisma, aliceId, { now: () => NOW });
  // bom_lookup sums 1 + 2 + 4 = 7.
  assert.equal(report.metrics.bom_lookup.used, 7);
  assert.equal(report.metrics.cost_analysis.used, 1);
  assert.equal(report.metrics.export.used, 0);
  // Per-tool breakdown.
  assert.equal(report.byTool.search_parts, 3);
  assert.equal(report.byTool.check_part_availability, 4);
  assert.equal(report.byTool.analyze_bom_cost, 1);
  assert.equal(report.byTool.find_alternative_parts, 0);
});

test("ignores rows from other orgs (cross-tenant)", async () => {
  await prisma.usageEvent.createMany({
    data: [
      {
        orgId: aliceId,
        tool: "search_parts",
        metric: "bom_lookup",
        quantity: 1,
        idempotencyKey: "alice-row",
        timestamp: new Date("2026-04-20T00:00:00Z"),
      },
      {
        orgId: bobId,
        tool: "search_parts",
        metric: "bom_lookup",
        quantity: 99,
        idempotencyKey: "bob-row",
        timestamp: new Date("2026-04-20T00:00:00Z"),
      },
    ],
  });
  const report = await buildUsageReport(prisma, aliceId, { now: () => NOW });
  // Only Alice's row counts — Bob's 99 must not leak.
  assert.equal(report.metrics.bom_lookup.used, 1);
});

test("ignores rows from prior periods", async () => {
  await prisma.usageEvent.createMany({
    data: [
      // In window: Apr 20.
      {
        orgId: aliceId,
        tool: "search_parts",
        metric: "bom_lookup",
        quantity: 1,
        idempotencyKey: "k-current",
        timestamp: new Date("2026-04-20T00:00:00Z"),
      },
      // Out of window: Mar 20 (prior period).
      {
        orgId: aliceId,
        tool: "search_parts",
        metric: "bom_lookup",
        quantity: 100,
        idempotencyKey: "k-prior",
        timestamp: new Date("2026-03-20T00:00:00Z"),
      },
    ],
  });
  const report = await buildUsageReport(prisma, aliceId, { now: () => NOW });
  assert.equal(report.metrics.bom_lookup.used, 1);
});

test("uses Subscription.currentPeriodStart/End when present", async () => {
  // Stripe-aligned period (Apr 1 → May 1) overrides the
  // monthly-anchored window (Apr 15 → May 15).
  await prisma.subscription.create({
    data: {
      orgId: aliceId,
      status: "active",
      currentPeriodStart: new Date("2026-04-01T00:00:00Z"),
      currentPeriodEnd: new Date("2026-05-01T00:00:00Z"),
      seats: 1,
    },
  });
  // Apr 5 falls in the Stripe window but NOT in the monthly window.
  await prisma.usageEvent.create({
    data: {
      orgId: aliceId,
      tool: "search_parts",
      metric: "bom_lookup",
      quantity: 7,
      idempotencyKey: "k-stripe",
      timestamp: new Date("2026-04-05T00:00:00Z"),
    },
  });

  const report = await buildUsageReport(prisma, aliceId, { now: () => NOW });
  assert.equal(report.period.start, "2026-04-01T00:00:00.000Z");
  assert.equal(report.period.end, "2026-05-01T00:00:00.000Z");
  assert.equal(report.metrics.bom_lookup.used, 7);
});

test("Enterprise unlimited: limit serializes as null", async () => {
  // Seed an enterprise plan + link it via Subscription so the
  // resolver returns its quotas verbatim.
  const plan = await prisma.plan.create({
    data: {
      name: "enterprise",
      includedQuotas: JSON.stringify({
        bom_lookup: -1,
        cost_analysis: -1,
        export: -1,
      }),
      seatLimit: 0,
    },
  });
  await prisma.subscription.create({
    data: {
      orgId: aliceId,
      planId: plan.id,
      status: "active",
      seats: 1,
      currentPeriodStart: new Date("2026-04-01T00:00:00Z"),
      currentPeriodEnd: new Date("2026-05-01T00:00:00Z"),
    },
  });
  const report = await buildUsageReport(prisma, aliceId, { now: () => NOW });
  // -1 internal sentinel should NOT leak to the SPA.
  assert.equal(report.metrics.bom_lookup.limit, null);
  assert.equal(report.metrics.cost_analysis.limit, null);
  assert.equal(report.metrics.export.limit, null);
});

test("rows with unknown tool names are dropped from byTool", async () => {
  // Defense in depth: a corrupt UsageEvent row (typo'd tool name)
  // shouldn't show up as a mystery line item. Only spec §4.4
  // metered tools appear in byTool; the metric SUM still reflects
  // it (we trust the metric column more than the tool string).
  await prisma.usageEvent.create({
    data: {
      orgId: aliceId,
      tool: "search_partz", // typo
      metric: "bom_lookup",
      quantity: 5,
      idempotencyKey: "k-typo",
      timestamp: new Date("2026-04-20T00:00:00Z"),
    },
  });
  const report = await buildUsageReport(prisma, aliceId, { now: () => NOW });
  // Metric SUM reflects the row (5).
  assert.equal(report.metrics.bom_lookup.used, 5);
  // byTool does NOT include the typo'd name.
  assert.equal((report.byTool as Record<string, number>).search_partz, undefined);
  // Real tools are still zero-filled.
  assert.equal(report.byTool.search_parts, 0);
});

test("throws when the org has been deleted between auth and query", async () => {
  // Caller (route layer) maps this to 404 not_found. Test pins the
  // shape of the throw so the route's regex match keeps working.
  await prisma.organization.delete({ where: { id: aliceId } });
  await assert.rejects(
    () => buildUsageReport(prisma, aliceId, { now: () => NOW }),
    /vanished/
  );
});
