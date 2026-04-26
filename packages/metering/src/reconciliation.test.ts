/**
 * Reconciliation tests — sums UsageEvent rows for the current
 * period and writes the result back into the QuotaStore. Hermetic
 * Postgres + InMemoryQuotaStore so the assertions stay deterministic
 * regardless of wall-clock time.
 */

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setupTestDatabase } from "@altium-mcp/db/test-utils";

import { InMemoryQuotaStore } from "./in-memory-store.js";
import { reconcileQuotas } from "./reconciliation.js";
import { monthlyPeriodFor } from "./period.js";

let prisma: import("@altium-mcp/db").PrismaClient;
let teardown: () => Promise<void>;
let store: InMemoryQuotaStore;
let aliceId: string;
let bobId: string;
const NOW = new Date("2026-04-15T00:00:00Z");

before(async () => {
  ({ teardown } = await setupTestDatabase());
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");

  const db = await import("@altium-mcp/db");
  prisma = db.prisma;
});

after(async () => {
  if (prisma) await prisma.$disconnect();
  await teardown();
});

beforeEach(async () => {
  // Per-test isolation: drop everything and re-seed two fresh orgs.
  // FK cascades clear UsageEvent / Membership / etc.
  await prisma.usageEvent.deleteMany({});
  await prisma.subscription.deleteMany({});
  await prisma.organization.deleteMany({});
  store = new InMemoryQuotaStore();

  // Org createdAt of Mar 15 → with NOW = Apr 15, monthlyPeriodFor
  // returns Apr 15 → May 15. We line up UsageEvent timestamps to
  // sit inside that window.
  const alice = await prisma.organization.create({
    data: {
      name: "Alice Hardware",
      slug: "alice-hardware",
      createdAt: new Date("2026-03-15T00:00:00Z"),
    },
  });
  aliceId = alice.id;
  const bob = await prisma.organization.create({
    data: {
      name: "Bob Hardware",
      slug: "bob-hardware",
      createdAt: new Date("2026-03-15T00:00:00Z"),
    },
  });
  bobId = bob.id;
});

test("sums UsageEvent rows by metric and writes to the store", async () => {
  // 3 bom_lookup + 1 cost_analysis + 0 export for Alice, all in
  // the current period (Apr 15 → May 15, anchored on Mar 15).
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
        tool: "analyze_bom_cost",
        metric: "cost_analysis",
        quantity: 1,
        idempotencyKey: "k3",
        timestamp: new Date("2026-04-22T00:00:00Z"),
      },
    ],
  });

  const result = await reconcileQuotas(prisma, store, { now: () => NOW });
  assert.equal(result.orgs, 2); // Alice + Bob
  // Alice gets two writes (bom_lookup + cost_analysis); Bob gets none
  // (zero rows + store starts at 0 → no diff to correct).
  assert.equal(result.writes.length, 2);

  const period = monthlyPeriodFor(new Date("2026-03-15T00:00:00Z"), NOW);
  assert.equal(await store.getUsed(aliceId, "bom_lookup", period), 3);
  assert.equal(await store.getUsed(aliceId, "cost_analysis", period), 1);
  assert.equal(await store.getUsed(aliceId, "export", period), 0);
});

test("ignores out-of-period UsageEvent rows", async () => {
  // Two events for Alice — one inside the current window, one in
  // the prior window. Reconciliation must only count the current.
  await prisma.usageEvent.createMany({
    data: [
      {
        orgId: aliceId,
        tool: "search_parts",
        metric: "bom_lookup",
        quantity: 1,
        idempotencyKey: "k-current",
        timestamp: new Date("2026-04-20T00:00:00Z"),
      },
      {
        orgId: aliceId,
        tool: "search_parts",
        metric: "bom_lookup",
        quantity: 100, // huge; should not leak into current period
        idempotencyKey: "k-prior",
        timestamp: new Date("2026-03-20T00:00:00Z"),
      },
    ],
  });

  await reconcileQuotas(prisma, store, { now: () => NOW });

  const currentPeriod = monthlyPeriodFor(new Date("2026-03-15T00:00:00Z"), NOW);
  assert.equal(await store.getUsed(aliceId, "bom_lookup", currentPeriod), 1);
});

test("uses Subscription.currentPeriodStart/End when available", async () => {
  // Stripe-aligned period: Apr 1 → May 1. Org createdAt is Mar 15
  // (would otherwise yield Apr 15 → May 15). The Subscription
  // window WINS — events on Apr 5 fall into the Stripe window but
  // would be out-of-period under the synthesized monthly window.
  await prisma.subscription.create({
    data: {
      orgId: aliceId,
      status: "active",
      currentPeriodStart: new Date("2026-04-01T00:00:00Z"),
      currentPeriodEnd: new Date("2026-05-01T00:00:00Z"),
      seats: 1,
    },
  });
  await prisma.usageEvent.createMany({
    data: [
      {
        orgId: aliceId,
        tool: "search_parts",
        metric: "bom_lookup",
        quantity: 7,
        idempotencyKey: "k-stripe-window",
        timestamp: new Date("2026-04-05T00:00:00Z"),
      },
    ],
  });

  await reconcileQuotas(prisma, store, { now: () => NOW });

  const stripePeriod = {
    start: new Date("2026-04-01T00:00:00Z"),
    end: new Date("2026-05-01T00:00:00Z"),
  };
  // Lookup uses the stripe window; the synthesized monthly window
  // would be a different key.
  assert.equal(await store.getUsed(aliceId, "bom_lookup", stripePeriod), 7);
});

test("only writes when before !== after (no-op when in sync)", async () => {
  await prisma.usageEvent.create({
    data: {
      orgId: aliceId,
      tool: "search_parts",
      metric: "bom_lookup",
      quantity: 4,
      idempotencyKey: "k1",
      timestamp: new Date("2026-04-20T00:00:00Z"),
    },
  });

  const period = monthlyPeriodFor(new Date("2026-03-15T00:00:00Z"), NOW);
  // Pre-warm the store with the same value the DB has.
  await store.setExact(aliceId, "bom_lookup", 4, period);

  const result = await reconcileQuotas(prisma, store, { now: () => NOW });
  // bom_lookup is in sync → no write recorded for that metric.
  // The other two metrics (cost_analysis, export) are also 0 in
  // both store and DB → no write either.
  assert.equal(result.writes.length, 0);
});

test("corrects drift downward (DB lower than store)", async () => {
  // Simulates the scenario the Redis reconciliation guards against:
  // a counter went up in Redis but the DB rolled back the
  // UsageEvent (or Redis was hand-edited by ops). Reconciliation
  // SETs the counter to the DB sum.
  const period = monthlyPeriodFor(new Date("2026-03-15T00:00:00Z"), NOW);
  await store.setExact(aliceId, "bom_lookup", 50, period);

  await prisma.usageEvent.create({
    data: {
      orgId: aliceId,
      tool: "search_parts",
      metric: "bom_lookup",
      quantity: 2,
      idempotencyKey: "k1",
      timestamp: new Date("2026-04-20T00:00:00Z"),
    },
  });

  const result = await reconcileQuotas(prisma, store, { now: () => NOW });
  assert.equal(await store.getUsed(aliceId, "bom_lookup", period), 2);
  const aliceWrite = result.writes.find(
    (w) => w.orgId === aliceId && w.metric === "bom_lookup"
  );
  assert.ok(aliceWrite);
  assert.equal(aliceWrite!.before, 50);
  assert.equal(aliceWrite!.after, 2);
});

test("corrects drift upward (Redis was flushed)", async () => {
  // Redis lost the counter (returns 0). DB has the truth (3).
  // Reconciliation must SET to 3 so the next quota check sees the
  // right value — otherwise the customer would get a free refresh.
  await prisma.usageEvent.create({
    data: {
      orgId: aliceId,
      tool: "search_parts",
      metric: "bom_lookup",
      quantity: 3,
      idempotencyKey: "k1",
      timestamp: new Date("2026-04-20T00:00:00Z"),
    },
  });

  await reconcileQuotas(prisma, store, { now: () => NOW });

  const period = monthlyPeriodFor(new Date("2026-03-15T00:00:00Z"), NOW);
  assert.equal(await store.getUsed(aliceId, "bom_lookup", period), 3);
});

test("skips soft-deleted orgs", async () => {
  await prisma.organization.update({
    where: { id: bobId },
    data: { deletedAt: new Date("2026-04-01T00:00:00Z") },
  });
  await prisma.usageEvent.create({
    data: {
      orgId: bobId,
      tool: "search_parts",
      metric: "bom_lookup",
      quantity: 99,
      idempotencyKey: "bob-k1",
      timestamp: new Date("2026-04-20T00:00:00Z"),
    },
  });

  const result = await reconcileQuotas(prisma, store, { now: () => NOW });
  assert.equal(result.orgs, 1); // only Alice
  // Bob's events are not summed.
  const period = monthlyPeriodFor(new Date("2026-03-15T00:00:00Z"), NOW);
  assert.equal(await store.getUsed(bobId, "bom_lookup", period), 0);
});

test("multi-org reconciliation isolates each org's writes", async () => {
  await prisma.usageEvent.createMany({
    data: [
      {
        orgId: aliceId,
        tool: "search_parts",
        metric: "bom_lookup",
        quantity: 5,
        idempotencyKey: "alice-k",
        timestamp: new Date("2026-04-20T00:00:00Z"),
      },
      {
        orgId: bobId,
        tool: "analyze_bom_cost",
        metric: "cost_analysis",
        quantity: 2,
        idempotencyKey: "bob-k",
        timestamp: new Date("2026-04-20T00:00:00Z"),
      },
    ],
  });

  await reconcileQuotas(prisma, store, { now: () => NOW });

  const period = monthlyPeriodFor(new Date("2026-03-15T00:00:00Z"), NOW);
  assert.equal(await store.getUsed(aliceId, "bom_lookup", period), 5);
  assert.equal(await store.getUsed(aliceId, "cost_analysis", period), 0);
  assert.equal(await store.getUsed(bobId, "bom_lookup", period), 0);
  assert.equal(await store.getUsed(bobId, "cost_analysis", period), 2);
});
