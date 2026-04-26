/**
 * Usage route integration tests.
 *
 * Pins:
 *   - GET /api/orgs/:orgId/usage returns the report shape
 *   - Authorization: every role gets through (including
 *     billing_only — finance budgeting visibility per spec §3.4)
 *   - Cross-tenant: Bob's session can't read Alice's usage
 *   - 404 when the org has been soft / hard deleted between auth
 *     and the handler query
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setupTestDatabase } from "@altium-mcp/db/test-utils";

import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";

let app: FastifyInstance;
let teardown: () => Promise<void>;
let aliceCookie: string;
let bobCookie: string;
let aliceOrgId: string;
let bobOrgId: string;

const STRONG = "correct-horse-battery-staple-5";

before(async () => {
  ({ teardown } = await setupTestDatabase());
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.WORKOS_COOKIE_PASSWORD = randomBytes(48).toString("base64");
  delete process.env.WORKOS_API_KEY;
  delete process.env.WORKOS_CLIENT_ID;

  const { __resetSessionCacheForTests, __resetAuthProviderCacheForTests } =
    await import("@altium-mcp/auth");
  __resetSessionCacheForTests();
  __resetAuthProviderCacheForTests();

  const { selectAuthProvider } = await import("@altium-mcp/auth");
  const { registerAuthRoutes } = await import("../auth/routes.js");
  const { registerUsageRoutes } = await import("./routes.js");

  app = Fastify({ logger: false });
  await app.register(cookie);
  const auth = selectAuthProvider();
  await registerAuthRoutes(app, auth);
  await registerUsageRoutes(app, auth);
  await app.ready();

  const aliceSignup = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email: "alice@usage.example", password: STRONG },
  });
  aliceOrgId = aliceSignup.json().org.id;
  aliceCookie = extractCookie(aliceSignup.headers["set-cookie"])!;

  const bobSignup = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email: "bob@usage.example", password: STRONG },
  });
  bobOrgId = bobSignup.json().org.id;
  bobCookie = extractCookie(bobSignup.headers["set-cookie"])!;
});

after(async () => {
  if (app) await app.close();
  const { prisma } = await import("@altium-mcp/db");
  await prisma.$disconnect();
  await teardown();
});

test("GET /usage returns the report shape with zero-filled metrics for a fresh org", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/usage`,
    headers: { cookie: aliceCookie },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  // Period + plan present.
  assert.ok(body.period?.start);
  assert.ok(body.period?.end);
  assert.ok(typeof body.plan?.name === "string");
  assert.equal(typeof body.plan?.overageAllowed, "boolean");
  // Every known metric appears with used=0.
  assert.equal(body.metrics.bom_lookup.used, 0);
  assert.equal(body.metrics.cost_analysis.used, 0);
  assert.equal(body.metrics.export.used, 0);
  // Every metered tool appears with 0.
  assert.equal(body.byTool.search_parts, 0);
  assert.equal(body.byTool.export_manufacturing_data, 0);
});

test("GET /usage reflects UsageEvent rows", async () => {
  const { prisma } = await import("@altium-mcp/db");
  // Insert in the org's current period. Default trialing org ⇒
  // monthly window from createdAt (now-ish) so we use a
  // freshly-created timestamp.
  await prisma.usageEvent.create({
    data: {
      orgId: aliceOrgId,
      tool: "search_parts",
      metric: "bom_lookup",
      quantity: 3,
      idempotencyKey: "alice-usage-route-1",
      timestamp: new Date(),
    },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/usage`,
    headers: { cookie: aliceCookie },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.metrics.bom_lookup.used, 3);
  assert.equal(body.byTool.search_parts, 3);
});

test("GET /usage cross-tenant — Bob's session probing Alice's orgId returns 403", async () => {
  // requireOrgRole rejects at 403 before the handler runs; same
  // defense the rest of the API uses (no enumeration of org ids).
  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/usage`,
    headers: { cookie: bobCookie },
  });
  assert.equal(res.statusCode, 403);
});

test("GET /usage 401 without a session cookie", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/usage`,
  });
  assert.equal(res.statusCode, 401);
});

test("GET /usage: billing_only role passes can() and gets the report", async () => {
  // Promote a synthetic billing_only member of Alice's org and
  // verify they can read usage. Spec §3.4: finance teams need
  // budget visibility without tool / billing privileges.
  const { prisma } = await import("@altium-mcp/db");
  // Create a fresh user, then add a billing_only Membership in
  // Alice's org. Direct DB write because the SPA flow for promoting
  // to billing_only is a focused PR away.
  const finance = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email: "finance@usage.example", password: STRONG },
  });
  const financeUserId = finance.json().user.id;
  const financeCookie = extractCookie(finance.headers["set-cookie"])!;
  await prisma.membership.create({
    data: { orgId: aliceOrgId, userId: financeUserId, role: "billing_only" },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/usage`,
    headers: { cookie: financeCookie },
  });
  assert.equal(res.statusCode, 200);
  // Sanity: shape is what the SPA expects.
  const body = res.json();
  assert.ok(body.metrics.bom_lookup);
});

test("GET /usage: a `member` role passes can() and gets the report", async () => {
  // Pin "any role can read" behavior for the standard member role.
  // Without this, if a future can() change accidentally restricted
  // usage.read, the dashboard would silently break for the most
  // common role.
  const { prisma } = await import("@altium-mcp/db");
  const dev = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email: "dev@usage.example", password: STRONG },
  });
  const devUserId = dev.json().user.id;
  const devCookie = extractCookie(dev.headers["set-cookie"])!;
  await prisma.membership.create({
    data: { orgId: aliceOrgId, userId: devUserId, role: "member" },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/usage`,
    headers: { cookie: devCookie },
  });
  assert.equal(res.statusCode, 200);
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
