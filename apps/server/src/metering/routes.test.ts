/**
 * Sprint 5 PR 5.1 — metering wired into the /parts/search route.
 *
 * What this pins:
 *   - First N calls succeed and each one writes a UsageEvent row keyed
 *     on a fresh idempotencyKey.
 *   - Once the org's bucket is empty AND overage is not allowed,
 *     the route returns 429 + `error: "quota_exceeded"` and does NOT
 *     hit the Nexar stub (proof we short-circuit before fn()).
 *   - A retry with the SAME requestId hits the UNIQUE on
 *     UsageEvent.idempotencyKey → no double-decrement, no second row.
 *   - When the upstream throws, no UsageEvent is written and quota is
 *     not consumed (failed Nexar calls don't bill).
 *   - When billingStatus is `suspended`, the requireActiveBilling
 *     middleware 402s before metering runs.
 *
 * Hermetic: fresh SQLite DB per file, stubbed NexarServiceFactory, a
 * fixed in-memory quota store, and a tiny test plan (limit=2) so the
 * cap is reachable in three calls.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import {
  InMemoryQuotaStore,
  type QuotaStore,
  type RecordUsage,
} from "@altium-mcp/metering";

let app: FastifyInstance;
let workdir: string;
let aliceCookie: string;
let aliceOrgId: string;
let aliceWsId: string;
let quotaStore: QuotaStore;
let usageRows: Array<{ orgId: string; metric: string; idempotencyKey: string; tool: string }> = [];
/**
 * Test recordUsage that hits the real Prisma write so the UNIQUE
 * constraint is exercised end-to-end. Pushes a flat copy onto
 * usageRows so assertions don't have to query the DB.
 */
let recordUsage: RecordUsage;

/** Counts how often the stub Nexar searchParts was invoked. */
let searchPartsCalls = 0;
/** Override the stub's behavior per test. */
let searchPartsImpl: () => Promise<unknown> = async () => [
  {
    mpn: "STM32F407",
    manufacturer: "ST",
    description: "MCU",
    category: "MCU",
    lifecycle: "Active",
    offers: [],
  },
];

const STRONG = "correct-horse-battery-staple-4";

before(async () => {
  workdir = mkdtempSync(join(tmpdir(), "altium-mcp-metering-routes-"));
  const dbPath = join(workdir, "test.db").replace(/\\/g, "/");
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.WORKOS_COOKIE_PASSWORD = randomBytes(48).toString("base64");
  delete process.env.WORKOS_API_KEY;
  delete process.env.WORKOS_CLIENT_ID;
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

  const { __resetSessionCacheForTests, __resetAuthProviderCacheForTests } =
    await import("@altium-mcp/auth");
  __resetSessionCacheForTests();
  __resetAuthProviderCacheForTests();

  const { selectAuthProvider } = await import("@altium-mcp/auth");
  const { registerAuthRoutes } = await import("../auth/routes.js");
  const { registerWorkspaceRoutes } = await import("../workspaces/routes.js");
  const { registerNexarRoutes } = await import("../workspaces/nexar-routes.js");
  const { NexarServiceFactory } = await import("../services/nexar-factory.js");
  const { writeUsageEvent } = await import("@altium-mcp/metering");
  const { prisma } = await import("@altium-mcp/db");

  // Custom genReqId: when a test passes `x-test-request-id`, Fastify
  // uses it as req.id. Lets us pin the idempotency key from a test
  // without monkey-patching Fastify internals. Falls back to a random
  // id when the header is absent (production-equivalent behavior).
  app = Fastify({
    logger: false,
    genReqId(req) {
      const h = req.headers["x-test-request-id"];
      if (typeof h === "string" && h.length > 0) return h;
      return randomBytes(8).toString("hex");
    },
  });
  await app.register(cookie);

  const auth = selectAuthProvider();
  await registerAuthRoutes(app, auth);

  // Seed a hard-walled plan with a tiny bucket so we can exhaust it
  // in a couple of calls. The resolver maps `name === "free"` to
  // overageAllowed=false (same rule for "trialing"), so naming the
  // test plan "free" gives us a deterministic 429 path. Production
  // seeds starter / team / enterprise — those allow overage by name.
  await prisma.plan.create({
    data: {
      name: "free",
      includedQuotas: JSON.stringify({
        bom_lookup: 2,
        cost_analysis: 2,
        export: 2,
      }),
      seatLimit: 0,
    },
  });

  // Stub NexarFactory — never reaches the network.
  const stubFactory = new NexarServiceFactory();
  stubFactory.testCredentials = async () => ({ ok: true });
  stubFactory.forWorkspace = async () => {
    return {
      searchParts: async () => {
        searchPartsCalls += 1;
        return await searchPartsImpl();
      },
      checkPartAvailability: async () => ({
        mpn: "STM32F407",
        offers: [],
      }),
      findAlternativeParts: async () => [
        { mpn: "STM32F427", reason: "pin-compatible" },
      ],
    } as unknown as Awaited<ReturnType<typeof stubFactory.forWorkspace>>;
  };

  quotaStore = new InMemoryQuotaStore();
  recordUsage = async (entry) => {
    const ok = await writeUsageEvent(entry);
    if (ok) {
      usageRows.push({
        orgId: entry.orgId,
        metric: entry.metric,
        idempotencyKey: entry.idempotencyKey,
        tool: entry.tool,
      });
    }
    return ok;
  };

  await registerWorkspaceRoutes(app, auth, { nexarFactory: stubFactory });
  await registerNexarRoutes(app, auth, {
    nexarFactory: stubFactory,
    quotaStore,
    recordUsage,
  });
  await app.ready();

  // Sign Alice up.
  const signup = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email: "alice@metering.example", password: STRONG },
  });
  aliceOrgId = signup.json().org.id;
  aliceCookie = extractCookie(signup.headers["set-cookie"])!;

  // Pin Alice's org to the test plan via a synthetic Subscription
  // row. billingStatus=active so requireActiveBilling doesn't block
  // the metered routes.
  const testPlan = await prisma.plan.findUnique({ where: { name: "free" } });
  await prisma.subscription.create({
    data: {
      orgId: aliceOrgId,
      planId: testPlan!.id,
      status: "active",
      seats: 1,
      currentPeriodStart: new Date("2026-04-01T00:00:00Z"),
      currentPeriodEnd: new Date("2026-05-01T00:00:00Z"),
    },
  });
  await prisma.organization.update({
    where: { id: aliceOrgId },
    data: { billingStatus: "active" },
  });

  // Workspace with creds.
  const ws = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/workspaces`,
    headers: { cookie: aliceCookie },
    payload: {
      altiumWorkspaceUrl: "https://alice.altium365.com",
      nexarClientId: "alice-id",
      nexarClientSecret: "alice-secret",
    },
  });
  aliceWsId = ws.json().workspace.id;
});

after(async () => {
  if (app) await app.close();
  const { prisma } = await import("@altium-mcp/db");
  await prisma.$disconnect();
  try {
    rmSync(workdir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

test("first call succeeds and writes a UsageEvent (bom_lookup)", async () => {
  const before = usageRows.length;
  searchPartsCalls = 0;
  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/workspaces/${aliceWsId}/parts/search?query=STM32`,
    headers: { cookie: aliceCookie },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(searchPartsCalls, 1);
  assert.equal(usageRows.length, before + 1);
  assert.equal(usageRows[before]!.metric, "bom_lookup");
  assert.equal(usageRows[before]!.tool, "search_parts");
  assert.equal(usageRows[before]!.orgId, aliceOrgId);
});

test("second call also succeeds — within the limit-of-2 bucket", async () => {
  const before = usageRows.length;
  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/workspaces/${aliceWsId}/parts/search?query=STM32x`,
    headers: { cookie: aliceCookie },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(usageRows.length, before + 1);
});

test("third call exhausts the bucket → 429 quota_exceeded; fn() is NOT invoked", async () => {
  const before = usageRows.length;
  const callsBefore = searchPartsCalls;
  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/workspaces/${aliceWsId}/parts/search?query=STM32y`,
    headers: { cookie: aliceCookie },
  });
  assert.equal(res.statusCode, 429);
  assert.equal(res.json().error, "quota_exceeded");
  assert.deepEqual(res.json().detail, {
    metric: "bom_lookup",
    limit: 2,
    used: 2,
  });
  // Quota check ran BEFORE fn() — Nexar wasn't touched.
  assert.equal(searchPartsCalls, callsBefore);
  // No new UsageEvent.
  assert.equal(usageRows.length, before);
});

test("upstream Nexar failure does NOT bill — counter unchanged, no UsageEvent", async () => {
  // Reset the counter first so we have headroom.
  quotaStore.reset();
  const before = usageRows.length;
  const callsBefore = searchPartsCalls;

  searchPartsImpl = async () => {
    throw new Error("nexar 502");
  };
  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/workspaces/${aliceWsId}/parts/search?query=fail`,
    headers: { cookie: aliceCookie },
  });
  // Route maps unknown errors to 502 upstream_error.
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().error, "upstream_error");
  // fn() ran (and threw), but no UsageEvent was written.
  assert.equal(searchPartsCalls, callsBefore + 1);
  assert.equal(usageRows.length, before);

  // Restore for downstream tests.
  searchPartsImpl = async () => [
    {
      mpn: "STM32F407",
      manufacturer: "ST",
      description: "MCU",
      category: "MCU",
      lifecycle: "Active",
      offers: [],
    },
  ];
});

test("billingStatus=suspended short-circuits BEFORE metering with 402 billing_inactive", async () => {
  // requireActiveBilling lives upstream of buildMeterContext / meter
  // — flipping the org to suspended must not move quota counters.
  quotaStore.reset();
  const beforeUsage = usageRows.length;
  const callsBefore = searchPartsCalls;

  const { prisma } = await import("@altium-mcp/db");
  await prisma.organization.update({
    where: { id: aliceOrgId },
    data: { billingStatus: "suspended" },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/workspaces/${aliceWsId}/parts/search?query=blocked`,
    headers: { cookie: aliceCookie },
  });
  assert.equal(res.statusCode, 402);
  assert.equal(searchPartsCalls, callsBefore);
  assert.equal(usageRows.length, beforeUsage);

  // Restore so the next test runs against the active org.
  await prisma.organization.update({
    where: { id: aliceOrgId },
    data: { billingStatus: "active" },
  });
});

test("retried request with the same idempotency key does not double-bill", async () => {
  // The route key is sha256(orgId|tool|requestId). Fastify generates
  // a fresh req.id per request, so a SECOND HTTP call with the same
  // URL gets a new key — that's the happy path. To test idempotency
  // we pre-write a UsageEvent with what WOULD be the next requestId's
  // key, then make a request that resolves to the same key by
  // injecting `id` on the inject options.
  quotaStore.reset();
  const beforeUsage = usageRows.length;

  // genReqId reads the x-test-request-id header → that becomes
  // req.id, which the meter wrapper hashes into the idempotency
  // key. This pins the key from outside without monkey-patching.
  const fixedRequestId = "metering-idempotency-test-1";
  const { prisma } = await import("@altium-mcp/db");
  // Pre-insert the UsageEvent that the next request WOULD write.
  // sha256(orgId|tool|requestId), in lower hex.
  const { createHash } = await import("node:crypto");
  const idemKey = createHash("sha256")
    .update(`${aliceOrgId}|search_parts|${fixedRequestId}`)
    .digest("hex");
  await prisma.usageEvent.create({
    data: {
      orgId: aliceOrgId,
      tool: "search_parts",
      metric: "bom_lookup",
      quantity: 1,
      idempotencyKey: idemKey,
    },
  });
  const usageBeforeRoute = await prisma.usageEvent.count({
    where: { orgId: aliceOrgId },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/workspaces/${aliceWsId}/parts/search?query=retry`,
    headers: { cookie: aliceCookie, "x-test-request-id": fixedRequestId },
  });
  assert.equal(res.statusCode, 200);
  // Route returned the result, but no NEW UsageEvent was written —
  // recordUsage hit the UNIQUE on idempotencyKey and returned false.
  const usageAfterRoute = await prisma.usageEvent.count({
    where: { orgId: aliceOrgId },
  });
  assert.equal(usageAfterRoute, usageBeforeRoute);
  // Counter increment was skipped too — used should be 0 in the
  // newly-reset store.
  assert.equal(
    await quotaStore.getUsed(aliceOrgId, "bom_lookup", {
      start: new Date("2026-04-01T00:00:00Z"),
      end: new Date("2026-05-01T00:00:00Z"),
    }),
    0
  );
  // usageRows is the in-test mirror; recordUsage only pushes when
  // the underlying write succeeded → no growth here either.
  assert.equal(usageRows.length, beforeUsage);
});

test("/parts/availability is metered as bom_lookup, 1u per call", async () => {
  // Reset so we have headroom — this test runs after the bucket
  // exhaustion case.
  quotaStore.reset();
  const before = usageRows.length;
  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/workspaces/${aliceWsId}/parts/availability?mpn=STM32F407`,
    headers: { cookie: aliceCookie },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(usageRows.length, before + 1);
  assert.equal(usageRows[before]!.tool, "check_part_availability");
  assert.equal(usageRows[before]!.metric, "bom_lookup");
});

test("/parts/alternatives is metered as bom_lookup, 1u per call", async () => {
  quotaStore.reset();
  const before = usageRows.length;
  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/workspaces/${aliceWsId}/parts/alternatives?mpn=STM32F407`,
    headers: { cookie: aliceCookie },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(usageRows.length, before + 1);
  assert.equal(usageRows[before]!.tool, "find_alternative_parts");
  assert.equal(usageRows[before]!.metric, "bom_lookup");
});

test("/parts/availability returns 429 quota_exceeded after the bucket is full", async () => {
  // Same hard-wall behavior as /parts/search — limit=2 plan, two
  // alternative-or-availability calls fill the bucket, the third
  // hits 429.
  quotaStore.reset();
  const url = `/api/orgs/${aliceOrgId}/workspaces/${aliceWsId}/parts/availability?mpn=STM32F407`;
  const r1 = await app.inject({ method: "GET", url, headers: { cookie: aliceCookie } });
  const r2 = await app.inject({ method: "GET", url, headers: { cookie: aliceCookie } });
  assert.equal(r1.statusCode, 200);
  assert.equal(r2.statusCode, 200);
  const r3 = await app.inject({ method: "GET", url, headers: { cookie: aliceCookie } });
  assert.equal(r3.statusCode, 429);
  assert.equal(r3.json().error, "quota_exceeded");
  assert.deepEqual(r3.json().detail, {
    metric: "bom_lookup",
    limit: 2,
    used: 2,
  });
});

function extractCookie(setCookie: string | string[] | undefined): string | null {
  if (!setCookie) return null;
  const all = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const sc of all) {
    const m = /^session=([^;]*)/i.exec(sc);
    if (m && m[1] && m[1].length > 0) return `session=${m[1]}`;
  }
  return null;
}
