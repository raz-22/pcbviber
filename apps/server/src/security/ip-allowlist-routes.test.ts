/**
 * IP allowlist route + enforcement tests.
 *
 * Pinned behaviors:
 *   - GET /ip-allowlist requires admin; returns the parsed entries
 *   - PUT validates each entry; collects all parse failures
 *   - PUT de-duplicates + canonicalizes
 *   - PUT refuses self-lockout unless force=true
 *   - tenant.ts enforces the configured allowlist on subsequent
 *     /api/orgs/* requests with a 403 ip_not_allowed body
 *   - Empty array on PUT clears the allowlist (back to disabled)
 *   - Audit row written for ip_allowlist.update + ip_allowlist.block
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
let aliceOrgId: string;
let bobCookie: string;
let bobOrgId: string;

const STRONG = "correct-horse-battery-staple-7";
// Inject's default client IP is 127.0.0.1; tests rely on this for
// the self-lockout guard + the "currently allowed" probe.
const INJECT_IP = "127.0.0.1";

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
  const { registerIpAllowlistRoutes } = await import("./ip-allowlist-routes.js");
  const { installTenantErrorHandler } = await import("../auth/tenant.js");

  app = Fastify({ logger: false });
  await app.register(cookie);
  const auth = selectAuthProvider();
  await registerAuthRoutes(app, auth);
  await registerIpAllowlistRoutes(app, auth);
  installTenantErrorHandler(app);
  await app.ready();

  const aliceSignup = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email: "alice@iplist.example", password: STRONG },
  });
  aliceOrgId = aliceSignup.json().org.id;
  aliceCookie = extractCookie(aliceSignup.headers["set-cookie"])!;

  const bobSignup = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email: "bob@iplist.example", password: STRONG },
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

// ─── GET /ip-allowlist ──────────────────────────────────────────────

test("GET /ip-allowlist: fresh org returns empty array", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/ip-allowlist`,
    headers: { cookie: aliceCookie },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().entries, []);
});

test("GET /ip-allowlist: 401 without session, 403 cross-tenant, 403 for member role", async () => {
  // 401 unauth.
  let res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/ip-allowlist`,
  });
  assert.equal(res.statusCode, 401);

  // 403 cross-tenant — Bob trying to read Alice's allowlist.
  res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/ip-allowlist`,
    headers: { cookie: bobCookie },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, "forbidden");

  // 403 for `member` role — admin-only matches the rest of the
  // org-config surfaces (Members, Audit, Billing).
  const { prisma } = await import("@altium-mcp/db");
  const dev = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email: "dev-on-iplist@iplist.example", password: STRONG },
  });
  const devUserId = dev.json().user.id;
  const devCookie = extractCookie(dev.headers["set-cookie"])!;
  await prisma.membership.create({
    data: { orgId: aliceOrgId, userId: devUserId, role: "member" },
  });
  res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/ip-allowlist`,
    headers: { cookie: devCookie },
  });
  assert.equal(res.statusCode, 403);
});

// ─── PUT /ip-allowlist ──────────────────────────────────────────────

test("PUT /ip-allowlist: stores normalized + de-duplicated entries", async () => {
  const res = await app.inject({
    method: "PUT",
    url: `/api/orgs/${aliceOrgId}/ip-allowlist`,
    headers: { cookie: aliceCookie, "content-type": "application/json" },
    // Mix duplicates + casing variations + a CIDR.
    payload: {
      entries: [
        "127.0.0.1",
        "127.0.0.1", // exact dup
        "2001:DB8::1", // uppercase
        "2001:db8::1", // dup of the above after canonicalization
        "10.0.0.0/8",
      ],
    },
  });
  assert.equal(res.statusCode, 200);
  const entries = res.json().entries as string[];
  assert.ok(entries.includes("127.0.0.1"));
  assert.ok(entries.some((e) => e.startsWith("2001:db8")));
  assert.ok(entries.includes("10.0.0.0/8"));
  // De-duped — 2 unique IPs + 1 CIDR after collapsing.
  assert.equal(entries.length, 3);
});

test("PUT /ip-allowlist: invalid entries → 400 with all parse failures", async () => {
  const res = await app.inject({
    method: "PUT",
    url: `/api/orgs/${aliceOrgId}/ip-allowlist`,
    headers: { cookie: aliceCookie, "content-type": "application/json" },
    payload: {
      entries: ["127.0.0.1", "not-an-ip", "10.0.0.0/40", "example.com"],
    },
  });
  assert.equal(res.statusCode, 400);
  const body = res.json();
  assert.equal(body.error, "invalid_ip_entries");
  assert.deepEqual(body.detail.invalid.sort(), [
    "10.0.0.0/40",
    "example.com",
    "not-an-ip",
  ]);
});

test("PUT /ip-allowlist: refuses self-lockout without force flag", async () => {
  // The inject client IP is 127.0.0.1. An allowlist of [10.0.0.0/8]
  // would lock out 127.0.0.1 → 409 unless force=true.
  const res = await app.inject({
    method: "PUT",
    url: `/api/orgs/${aliceOrgId}/ip-allowlist`,
    headers: { cookie: aliceCookie, "content-type": "application/json" },
    payload: { entries: ["10.0.0.0/8"] },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, "ip_allowlist_would_lock_out_self");
  assert.equal(res.json().detail.clientIp, INJECT_IP);
});

test("PUT /ip-allowlist: force=true overrides self-lockout guard", async () => {
  // Set up a fresh org so the lockout doesn't poison the rest of
  // the suite.
  const owner = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email: "lockout@iplist.example", password: STRONG },
  });
  const orgId = owner.json().org.id;
  const ownerCookie = extractCookie(owner.headers["set-cookie"])!;

  const res = await app.inject({
    method: "PUT",
    url: `/api/orgs/${orgId}/ip-allowlist`,
    headers: { cookie: ownerCookie, "content-type": "application/json" },
    payload: { entries: ["10.0.0.0/8"], force: true },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().entries, ["10.0.0.0/8"]);
});

test("PUT /ip-allowlist: empty array clears the allowlist", async () => {
  // Pre-condition: set something, then clear.
  const owner = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email: "clear@iplist.example", password: STRONG },
  });
  const orgId = owner.json().org.id;
  const ownerCookie = extractCookie(owner.headers["set-cookie"])!;
  await app.inject({
    method: "PUT",
    url: `/api/orgs/${orgId}/ip-allowlist`,
    headers: { cookie: ownerCookie, "content-type": "application/json" },
    payload: { entries: ["127.0.0.1"] },
  });
  const res = await app.inject({
    method: "PUT",
    url: `/api/orgs/${orgId}/ip-allowlist`,
    headers: { cookie: ownerCookie, "content-type": "application/json" },
    payload: { entries: [] },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().entries, []);

  const { prisma } = await import("@altium-mcp/db");
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { ipAllowlistJson: true },
  });
  assert.equal(
    org?.ipAllowlistJson,
    null,
    "empty array should persist as NULL in the column"
  );
});

test("PUT /ip-allowlist: writes ip_allowlist.update audit row with size delta", async () => {
  const owner = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email: "audit@iplist.example", password: STRONG },
  });
  const orgId = owner.json().org.id;
  const ownerCookie = extractCookie(owner.headers["set-cookie"])!;

  await app.inject({
    method: "PUT",
    url: `/api/orgs/${orgId}/ip-allowlist`,
    headers: { cookie: ownerCookie, "content-type": "application/json" },
    payload: { entries: ["127.0.0.1", "10.0.0.0/8"] },
  });

  const { prisma } = await import("@altium-mcp/db");
  const audit = await prisma.auditLog.findFirst({
    where: { orgId, action: "ip_allowlist.update" },
    orderBy: { timestamp: "desc" },
  });
  assert.ok(audit);
  // Sizes only — entry strings stay out of the metadata so the
  // audit log doesn't leak sensitive ranges.
  assert.match(audit!.metadata ?? "", /"newSize":2/);
  assert.match(audit!.metadata ?? "", /"previousSize":0/);
  // Real entries must NOT be in the metadata payload.
  assert.doesNotMatch(audit!.metadata ?? "", /127\.0\.0\.1/);
});

// ─── enforceIpAllowlist (the actual gate) ───────────────────────────

test("enforce: a configured allowlist rejects off-allowlist requests with 403 ip_not_allowed", async () => {
  // Configure the allowlist to a CIDR that does NOT include
  // 127.0.0.1, with force=true to bypass the self-lockout guard.
  const owner = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email: "enforce@iplist.example", password: STRONG },
  });
  const orgId = owner.json().org.id;
  const ownerCookie = extractCookie(owner.headers["set-cookie"])!;
  await app.inject({
    method: "PUT",
    url: `/api/orgs/${orgId}/ip-allowlist`,
    headers: { cookie: ownerCookie, "content-type": "application/json" },
    payload: { entries: ["10.0.0.0/8"], force: true },
  });

  // Now any tenant-scoped request from the inject IP (127.0.0.1)
  // should get 403 ip_not_allowed BEFORE the handler runs.
  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${orgId}/ip-allowlist`,
    headers: { cookie: ownerCookie },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, "ip_not_allowed");

  // ip_allowlist.block audit row written.
  const { prisma } = await import("@altium-mcp/db");
  const audit = await prisma.auditLog.findFirst({
    where: { orgId, action: "ip_allowlist.block" },
    orderBy: { timestamp: "desc" },
  });
  assert.ok(audit);
  assert.match(audit!.metadata ?? "", /"method":"GET"/);
  assert.match(audit!.metadata ?? "", /"path":/);
});

test("enforce: requests from an allowlisted IP pass", async () => {
  // Add 127.0.0.1 to the allowlist; the same request now succeeds.
  const owner = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email: "permit@iplist.example", password: STRONG },
  });
  const orgId = owner.json().org.id;
  const ownerCookie = extractCookie(owner.headers["set-cookie"])!;
  await app.inject({
    method: "PUT",
    url: `/api/orgs/${orgId}/ip-allowlist`,
    headers: { cookie: ownerCookie, "content-type": "application/json" },
    payload: { entries: ["127.0.0.0/24"] },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${orgId}/ip-allowlist`,
    headers: { cookie: ownerCookie },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().entries, ["127.0.0.0/24"]);
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
