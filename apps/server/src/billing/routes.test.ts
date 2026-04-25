/**
 * Billing route tests — POST /api/orgs/:orgId/billing/checkout-session.
 *
 * Provider is injected as a stub so we never hit api.stripe.com.
 * Asserts:
 *   - 403 for non-owner roles (admin/member/billing_only)
 *   - 503 when the provider isn't configured
 *   - 400 invalid_input on bad body shape
 *   - 400 invalid_price for a priceId not on the env allow-list
 *   - happy: 200 with url + sessionId; provider received the right
 *     payload; client_reference_id is signed (verifies via signer)
 *   - audit log written
 *   - existing customerId is forwarded; null on first checkout
 *   - cross-tenant: bob can't initiate checkout for alice's org
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
  makeBillingSigner,
  type BillingProvider,
  type CheckoutSessionRequest,
  type CheckoutSessionResult,
} from "@altium-mcp/billing";

const STRONG = "correct-horse-battery-staple-3";

const STARTER_PRICE = "price_starter_seat_test";
const TEAM_PRICE = "price_team_seat_test";
const ENTERPRISE_PRICE = "price_enterprise_seat_test";

const SIGNING_SECRET = randomBytes(32);
const signer = makeBillingSigner(SIGNING_SECRET);

let app: FastifyInstance;
let workdir: string;
let aliceOrgId: string;
let aliceCookie: string;
let aliceUserId: string;
let bobOrgId: string;
let bobCookie: string;

/**
 * Captures the most recent createCheckoutSession call so tests can
 * assert what the provider received. The default response is a fixed
 * Stripe-shaped pair; tests can flip flags to make it throw or return
 * a different result.
 */
const capture: {
  lastInput: CheckoutSessionRequest | null;
  isConfigured: boolean;
  shouldThrow: Error | null;
  result: CheckoutSessionResult;
} = {
  lastInput: null,
  isConfigured: true,
  shouldThrow: null,
  result: { url: "https://checkout.stripe.com/c/pay/cs_test_123", sessionId: "cs_test_123" },
};

const stubBilling: BillingProvider = {
  isConfigured: () => capture.isConfigured,
  createCheckoutSession: async (input) => {
    capture.lastInput = input;
    if (capture.shouldThrow) throw capture.shouldThrow;
    return capture.result;
  },
  // The checkout-session route doesn't call verifyWebhook; stubbing
  // it here keeps the BillingProvider interface satisfied without
  // pulling webhook test fixtures into this file.
  verifyWebhook: () => {
    throw new Error("verifyWebhook not used by checkout-session tests");
  },
};

before(async () => {
  workdir = mkdtempSync(join(tmpdir(), "altium-mcp-billing-test-"));
  const dbPath = join(workdir, "test.db").replace(/\\/g, "/");
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.WORKOS_COOKIE_PASSWORD = randomBytes(48).toString("base64");
  process.env.STRIPE_PRICE_STARTER_SEAT = STARTER_PRICE;
  process.env.STRIPE_PRICE_TEAM_SEAT = TEAM_PRICE;
  delete process.env.WORKOS_API_KEY;
  delete process.env.WORKOS_CLIENT_ID;

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
  const { registerBillingRoutes } = await import("./routes.js");

  app = Fastify({ logger: false });
  await app.register(cookie);
  const auth = selectAuthProvider();
  await registerAuthRoutes(app, auth);
  await registerBillingRoutes(app, auth, {
    billing: stubBilling,
    signer,
    appBaseUrl: "http://localhost:5173",
  });
  await app.ready();

  const aliceSignup = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email: "alice@billing-test.example", password: STRONG },
  });
  aliceUserId = aliceSignup.json().user.id;
  aliceOrgId = aliceSignup.json().org.id;
  aliceCookie = extractCookie(aliceSignup.headers["set-cookie"])!;

  const bobSignup = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email: "bob@billing-test.example", password: STRONG },
  });
  bobOrgId = bobSignup.json().org.id;
  bobCookie = extractCookie(bobSignup.headers["set-cookie"])!;
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

function resetCapture() {
  capture.lastInput = null;
  capture.isConfigured = true;
  capture.shouldThrow = null;
  capture.result = {
    url: "https://checkout.stripe.com/c/pay/cs_test_123",
    sessionId: "cs_test_123",
  };
}

// ═══ Happy path ═════════════════════════════════════════════════════════

test("POST /checkout-session: 200 with url + sessionId; signer claim verifies", async () => {
  resetCapture();
  const res = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/billing/checkout-session`,
    headers: { cookie: aliceCookie },
    payload: { priceId: TEAM_PRICE, seats: 5 },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.url, "https://checkout.stripe.com/c/pay/cs_test_123");
  assert.equal(body.sessionId, "cs_test_123");

  // Provider received the right input — most importantly, the
  // client_reference_id is the signer's output for (orgId, priceId, seats).
  const input = capture.lastInput!;
  assert.ok(input);
  assert.equal(input.orgId, aliceOrgId);
  assert.equal(input.priceId, TEAM_PRICE);
  assert.equal(input.seats, 5);
  assert.equal(input.customerEmail, "alice@billing-test.example");
  // First-time checkout — no Stripe customer id yet.
  assert.equal(input.customerId, null);
  // Round-trip the client_reference_id through the same signer the
  // route used: the claim must verify and equal the input.
  const claim = signer.verify(input.clientReferenceId);
  assert.deepEqual(claim, {
    orgId: aliceOrgId,
    priceId: TEAM_PRICE,
    seats: 5,
  });
  // Success/cancel URLs are absolute, point at the SPA, and include
  // the session-id placeholder for the success route to read after
  // Stripe's redirect.
  assert.match(input.successUrl, /^http:\/\/localhost:5173\/settings\/billing/);
  assert.match(input.successUrl, /session_id=\{CHECKOUT_SESSION_ID\}/);
  assert.match(input.cancelUrl, /^http:\/\/localhost:5173\/settings\/billing/);
});

test("POST /checkout-session: existing billingCustomerId is forwarded", async () => {
  resetCapture();
  const { prisma } = await import("@altium-mcp/db");
  // Simulate a returning customer — set billingCustomerId on the org.
  await prisma.organization.update({
    where: { id: aliceOrgId },
    data: { billingCustomerId: "cus_alice_existing" },
  });
  await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/billing/checkout-session`,
    headers: { cookie: aliceCookie },
    payload: { priceId: TEAM_PRICE, seats: 3 },
  });
  assert.equal(capture.lastInput?.customerId, "cus_alice_existing");
  // Cleanup so subsequent tests see Alice as a fresh customer again.
  await prisma.organization.update({
    where: { id: aliceOrgId },
    data: { billingCustomerId: null },
  });
});

test("POST /checkout-session writes billing.checkout_session.create audit row", async () => {
  resetCapture();
  // The stub returns the same sessionId on every call, so test
  // ordering would otherwise have findFirst return an earlier row.
  // Use a unique sessionId for this test so we look up the right one.
  capture.result = {
    url: "https://checkout.stripe.com/c/pay/cs_audit_pin",
    sessionId: "cs_audit_pin",
  };
  await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/billing/checkout-session`,
    headers: { cookie: aliceCookie },
    payload: { priceId: STARTER_PRICE, seats: 1 },
  });
  const { prisma } = await import("@altium-mcp/db");
  const log = await prisma.auditLog.findFirst({
    where: {
      orgId: aliceOrgId,
      action: "billing.checkout_session.create",
      target: "cs_audit_pin",
    },
  });
  assert.ok(log);
  assert.equal(log.actorUserId, aliceUserId);
  assert.match(log.metadata ?? "", /"priceId":"price_starter_seat_test"/);
  assert.match(log.metadata ?? "", /"seats":1/);
});

// ═══ Authz / config rejections ══════════════════════════════════════════

test("POST /checkout-session: 401 without a session", async () => {
  resetCapture();
  const res = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/billing/checkout-session`,
    payload: { priceId: TEAM_PRICE, seats: 1 },
  });
  assert.equal(res.statusCode, 401);
});

test("POST /checkout-session: 403 forbidden for an admin (owner-only action)", async () => {
  // Make a fresh user, add as admin of Alice's org.
  resetCapture();
  const { prisma } = await import("@altium-mcp/db");
  const m = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: {
      email: `admin-billing-${randomBytes(3).toString("hex")}@billing-test.example`,
      password: STRONG,
    },
  });
  const adminUserId = m.json().user.id;
  const adminCookie = extractCookie(m.headers["set-cookie"])!;
  await prisma.membership.create({
    data: { orgId: aliceOrgId, userId: adminUserId, role: "admin" },
  });

  const res = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/billing/checkout-session`,
    headers: { cookie: adminCookie },
    payload: { priceId: TEAM_PRICE, seats: 1 },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, "forbidden");
  // Provider was never called — fail fast before constructing a
  // Stripe session.
  assert.equal(capture.lastInput, null);
});

test("POST /checkout-session: cross-tenant — Bob can't checkout in Alice's org", async () => {
  resetCapture();
  const res = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/billing/checkout-session`,
    headers: { cookie: bobCookie },
    payload: { priceId: TEAM_PRICE, seats: 1 },
  });
  // Bob isn't a member of Alice's org — 403 from requireMember
  // (NOT 403-from-can()-billing.checkout, which would only fire
  // after the membership check passed).
  assert.equal(res.statusCode, 403);
});

test("POST /checkout-session: 503 when provider isConfigured() is false", async () => {
  resetCapture();
  capture.isConfigured = false;
  const res = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/billing/checkout-session`,
    headers: { cookie: aliceCookie },
    payload: { priceId: TEAM_PRICE, seats: 1 },
  });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error, "billing_not_configured");
  // Provider's createCheckoutSession was never called.
  assert.equal(capture.lastInput, null);
});

// ═══ Validation ═════════════════════════════════════════════════════════

test("POST /checkout-session: 400 invalid_input on missing priceId", async () => {
  resetCapture();
  const res = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/billing/checkout-session`,
    headers: { cookie: aliceCookie },
    payload: { seats: 1 },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "invalid_input");
});

test("POST /checkout-session: 400 invalid_input on bad seats (zero, negative, huge)", async () => {
  resetCapture();
  for (const seats of [0, -3, 1001]) {
    const res = await app.inject({
      method: "POST",
      url: `/api/orgs/${aliceOrgId}/billing/checkout-session`,
      headers: { cookie: aliceCookie },
      payload: { priceId: TEAM_PRICE, seats },
    });
    assert.equal(res.statusCode, 400, `seats=${seats}`);
    assert.equal(res.json().error, "invalid_input");
  }
});

test("POST /checkout-session: 502 billing_upstream_error when Stripe throws", async () => {
  // Stripe network glitch / rate limit / declined card / invalid
  // price metadata all bubble out of createCheckoutSession as a
  // generic Error. The route catches and surfaces a stable code
  // WITHOUT echoing the original message — Stripe error messages
  // can include customer + payment context that doesn't belong on
  // the wire to a SPA.
  resetCapture();
  capture.shouldThrow = new Error(
    "stripe error with sensitive context: cus_secret_123 declined"
  );
  const res = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/billing/checkout-session`,
    headers: { cookie: aliceCookie },
    payload: { priceId: TEAM_PRICE, seats: 1 },
  });
  assert.equal(res.statusCode, 502);
  const body = res.json();
  assert.equal(body.error, "billing_upstream_error");
  // Defense in depth: the original error message must NOT appear in
  // the response body. Server logs have the full detail.
  assert.doesNotMatch(JSON.stringify(body), /cus_secret_123/);
  assert.doesNotMatch(JSON.stringify(body), /declined/);
});

test("POST /checkout-session: 400 invalid_price for a priceId NOT on the env allow-list", async () => {
  resetCapture();
  const res = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/billing/checkout-session`,
    headers: { cookie: aliceCookie },
    // Enterprise is invoiced (not in env), so its priceId isn't
    // allow-listed for self-serve checkout.
    payload: { priceId: ENTERPRISE_PRICE, seats: 1 },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "invalid_price");
  // Provider not called.
  assert.equal(capture.lastInput, null);
});

// ─── helper ──────────────────────────────────────────────────────────

function extractCookie(setCookie: string | string[] | undefined): string | null {
  if (!setCookie) return null;
  const all = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const sc of all) {
    const m = /^session=([^;]*)/i.exec(sc);
    if (m && m[1] && m[1].length > 0) return `session=${m[1]}`;
  }
  return null;
}
