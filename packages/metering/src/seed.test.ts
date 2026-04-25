/**
 * Seed test — verifies seedPlans upserts the right rows with the
 * spec quotas, picks up Stripe Price IDs from env, and is idempotent
 * (re-running it doesn't error or duplicate rows).
 *
 * Hermetic: brings up a fresh SQLite DB and runs the committed
 * migrations, same pattern as packages/auth/src/local.test.ts.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let prisma: import("@altium-mcp/db").PrismaClient;
let seedPlans: typeof import("./seed.js").seedPlans;
let workdir: string;

before(async () => {
  workdir = mkdtempSync(join(tmpdir(), "altium-mcp-metering-seed-test-"));
  const dbPath = join(workdir, "test.db").replace(/\\/g, "/");
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");

  const dbPkg = join(process.cwd(), "..", "db");
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
  ({ seedPlans } = await import("./seed.js"));
});

after(async () => {
  if (prisma) await prisma.$disconnect();
  try {
    rmSync(workdir, { recursive: true, force: true });
  } catch {
    // best-effort teardown
  }
});

test("seedPlans upserts starter, team, and enterprise rows", async () => {
  await seedPlans(prisma, {});
  const plans = await prisma.plan.findMany({ orderBy: { name: "asc" } });
  const names = plans.map((p) => p.name);
  assert.deepEqual(names, ["enterprise", "starter", "team"]);
});

test("seeded quotas match spec §1 numbers", async () => {
  await seedPlans(prisma, {});
  const starter = await prisma.plan.findUnique({ where: { name: "starter" } });
  const team = await prisma.plan.findUnique({ where: { name: "team" } });
  const enterprise = await prisma.plan.findUnique({ where: { name: "enterprise" } });

  assert.deepEqual(JSON.parse(starter!.includedQuotas), {
    bom_lookup: 500,
    cost_analysis: 50,
    export: 10,
  });
  assert.deepEqual(JSON.parse(team!.includedQuotas), {
    bom_lookup: 5_000,
    cost_analysis: 500,
    export: 100,
  });
  // -1 sentinel = unlimited.
  assert.deepEqual(JSON.parse(enterprise!.includedQuotas), {
    bom_lookup: -1,
    cost_analysis: -1,
    export: -1,
  });
});

test("seedPlans picks up Stripe Price IDs from env", async () => {
  await seedPlans(prisma, {
    STRIPE_PRICE_STARTER_SEAT: "price_starter_x",
    STRIPE_PRICE_TEAM_SEAT: "price_team_y",
    STRIPE_PRICE_METER_BOM: "price_meter_bom",
    STRIPE_PRICE_METER_COST: "price_meter_cost",
    STRIPE_PRICE_METER_EXPORT: "price_meter_export",
  });
  const starter = await prisma.plan.findUnique({ where: { name: "starter" } });
  const team = await prisma.plan.findUnique({ where: { name: "team" } });
  const enterprise = await prisma.plan.findUnique({ where: { name: "enterprise" } });

  assert.equal(starter!.seatPriceId, "price_starter_x");
  assert.equal(team!.seatPriceId, "price_team_y");
  // Enterprise has no env-mapped seat price.
  assert.equal(enterprise!.seatPriceId, null);
  // Meter prices apply to every plan row.
  for (const row of [starter, team, enterprise]) {
    assert.equal(row!.meterBomPriceId, "price_meter_bom");
    assert.equal(row!.meterCostPriceId, "price_meter_cost");
    assert.equal(row!.meterExportPriceId, "price_meter_export");
  }
});

test("seedPlans is idempotent — re-runs update without dup rows", async () => {
  await seedPlans(prisma, { STRIPE_PRICE_STARTER_SEAT: "price_first" });
  await seedPlans(prisma, { STRIPE_PRICE_STARTER_SEAT: "price_second" });
  const all = await prisma.plan.findMany();
  // Still exactly three rows.
  assert.equal(all.length, 3);
  const starter = await prisma.plan.findUnique({ where: { name: "starter" } });
  // Second seed updated the seat price (rotation case).
  assert.equal(starter!.seatPriceId, "price_second");
});

test("seedPlans clears Stripe Price IDs when env is unset", async () => {
  // Operator unset STRIPE_PRICE_STARTER_SEAT (e.g. moved to a new
  // Stripe account). Re-running the seed should clear the row's
  // seatPriceId rather than leave the stale one in place.
  await seedPlans(prisma, { STRIPE_PRICE_STARTER_SEAT: "price_initial" });
  await seedPlans(prisma, {}); // unset
  const starter = await prisma.plan.findUnique({ where: { name: "starter" } });
  assert.equal(starter!.seatPriceId, null);
});
