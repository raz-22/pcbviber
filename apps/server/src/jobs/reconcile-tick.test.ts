/**
 * reconcile-tick tests — thin wrapper over reconcileQuotas. The
 * sum-by-metric logic is tested in @altium-mcp/metering. Here we
 * just pin the wrapper contract: it forwards `now`, returns a
 * structured result with `orgs` + `writes` count, and logs the
 * drift summary at info level.
 */

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { setupTestDatabase } from "@altium-mcp/db/test-utils";

import { InMemoryQuotaStore } from "@altium-mcp/metering";
import { reconcileTick } from "./reconcile-tick.js";

let prisma: import("@altium-mcp/db").PrismaClient;
let teardown: () => Promise<void>;
let aliceId: string;

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
  await prisma.usageEvent.deleteMany({});
  await prisma.organization.deleteMany({});
  const alice = await prisma.organization.create({
    data: {
      name: "Alice",
      slug: "alice-reconcile-tick",
      createdAt: new Date("2026-03-15T00:00:00Z"),
    },
  });
  aliceId = alice.id;
});

test("returns orgs + writes count from reconcileQuotas", async () => {
  await prisma.usageEvent.create({
    data: {
      orgId: aliceId,
      tool: "search_parts",
      metric: "bom_lookup",
      quantity: 5,
      idempotencyKey: "k1",
      timestamp: new Date("2026-04-20T00:00:00Z"),
    },
  });
  const store = new InMemoryQuotaStore();

  const result = await reconcileTick(prisma, store, {
    now: () => NOW,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });

  assert.equal(result.orgs, 1);
  assert.equal(result.writes, 1);
});

test("logs drift summary at info level when corrections happen", async () => {
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
  const store = new InMemoryQuotaStore();
  const infoMessages: string[] = [];

  await reconcileTick(prisma, store, {
    now: () => NOW,
    log: {
      info: (msg: string) => infoMessages.push(msg),
      warn: () => {},
      error: () => {},
    },
  });

  assert.ok(
    infoMessages.some((m) => /1 drift correction/.test(m)),
    `expected 'drift correction' in info logs; saw: ${infoMessages.join(" | ")}`
  );
});

test("logs 'no drift' when store and DB are already in sync", async () => {
  // No UsageEvent rows = DB sum is 0; store starts at 0 → no diff.
  const store = new InMemoryQuotaStore();
  const infoMessages: string[] = [];

  await reconcileTick(prisma, store, {
    now: () => NOW,
    log: {
      info: (msg: string) => infoMessages.push(msg),
      warn: () => {},
      error: () => {},
    },
  });

  assert.ok(
    infoMessages.some((m) => /no drift/.test(m)),
    `expected 'no drift' in info logs; saw: ${infoMessages.join(" | ")}`
  );
});
