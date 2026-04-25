/**
 * Tenant-scope middleware tests — Sprint 2 PR 2.1.
 *
 * These pin the foundation that every later Sprint-2 PR depends on:
 *   - Anonymous → 401
 *   - Authenticated non-member → 403 (cross-tenant defense)
 *   - Member → 200 with `req.ctx` populated
 *   - Role-restricted middleware rejects allowed-set mismatch
 *   - Forged orgId → same 403 as not-a-member (no enumeration leak)
 *
 * Hermetic: temp SQLite DB, applies migrations, builds a Fastify app
 * with cookie + auth + org routes wired, exercises through inject().
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

let app: FastifyInstance;
let workdir: string;
let aliceCookie: string; // owner of Alice's org
let bobCookie: string;   // owner of Bob's org (different tenant)
let aliceOrgId: string;
let bobOrgId: string;
let aliceUserId: string;
let bobUserId: string;

const STRONG = "correct-horse-battery-staple-2";

before(async () => {
  workdir = mkdtempSync(join(tmpdir(), "altium-mcp-tenant-test-"));
  const dbPath = join(workdir, "test.db").replace(/\\/g, "/");
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.WORKOS_COOKIE_PASSWORD = randomBytes(48).toString("base64");
  delete process.env.WORKOS_API_KEY;
  delete process.env.WORKOS_CLIENT_ID;

  // Apply schema to the temp DB.
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

  // Reset the cached singletons so the new env vars take effect.
  const { __resetSessionCacheForTests, __resetAuthProviderCacheForTests } =
    await import("@altium-mcp/auth");
  __resetSessionCacheForTests();
  __resetAuthProviderCacheForTests();

  const { selectAuthProvider } = await import("@altium-mcp/auth");
  const { registerAuthRoutes } = await import("./routes.js");
  const { registerOrgRoutes } = await import("./org-routes.js");

  app = Fastify({ logger: false });
  await app.register(cookie);
  const auth = selectAuthProvider();
  await registerAuthRoutes(app, auth);
  await registerOrgRoutes(app, auth);
  await app.ready();

  // Seed two orgs via signup. Each user is owner of their own org.
  const aliceSignup = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email: "alice@tenant-test.example", password: STRONG },
  });
  assert.equal(aliceSignup.statusCode, 200);
  aliceOrgId = aliceSignup.json().org.id;
  aliceUserId = aliceSignup.json().user.id;
  aliceCookie = extractCookie(aliceSignup.headers["set-cookie"])!;

  const bobSignup = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email: "bob@tenant-test.example", password: STRONG },
  });
  assert.equal(bobSignup.statusCode, 200);
  bobOrgId = bobSignup.json().org.id;
  bobUserId = bobSignup.json().user.id;
  bobCookie = extractCookie(bobSignup.headers["set-cookie"])!;

  assert.notEqual(aliceOrgId, bobOrgId);
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

// ─── 401: anonymous request to a protected route ────────────────────

test("GET /api/orgs/:orgId/info without a session returns 401", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/info`,
  });
  assert.equal(res.statusCode, 401);
});

test("GET /api/orgs/:orgId/info with an invalid session cookie returns 401", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/info`,
    headers: { cookie: "session=garbage" },
  });
  assert.equal(res.statusCode, 401);
});

// ─── 403: cross-tenant access attempts ──────────────────────────────

test("Alice trying to access Bob's org returns 403 (cross-tenant defense)", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${bobOrgId}/info`,
    headers: { cookie: aliceCookie },
  });
  assert.equal(res.statusCode, 403);
});

test("Bob trying to access Alice's org returns 403 (symmetric check)", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/info`,
    headers: { cookie: bobCookie },
  });
  assert.equal(res.statusCode, 403);
});

test("non-existent orgId returns 403, NOT 404 (no enumeration leak)", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/api/orgs/clx_does_not_exist/info",
    headers: { cookie: aliceCookie },
  });
  assert.equal(res.statusCode, 403);
});

// ─── 200: valid member access ───────────────────────────────────────

test("Alice can read her own org's info", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/info`,
    headers: { cookie: aliceCookie },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.org.id, aliceOrgId);
  assert.equal(body.you.userId, aliceUserId);
  assert.equal(body.you.email, "alice@tenant-test.example");
  assert.equal(body.you.role, "owner");
});

test("ctx.org includes slug + name (not just id)", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/info`,
    headers: { cookie: aliceCookie },
  });
  const body = res.json();
  assert.match(body.org.slug, /^alice/);
  assert.ok(body.org.name);
});

// ─── Role-restricted middleware ─────────────────────────────────────

test("makeRequireOrgRole(['admin']) rejects an owner (role mismatch)", async () => {
  // Mount a one-off route that requires admin specifically — alice is
  // an owner, so this must 403.
  const { makeRequireOrgRole } = await import("./tenant.js");
  const { makeRequireAuth } = await import("./middleware.js");
  const { selectAuthProvider } = await import("@altium-mcp/auth");
  const auth = selectAuthProvider();
  const local = Fastify({ logger: false });
  await local.register(cookie);
  // Re-mount auth so /api/auth/* exists for cookie verification.
  const { registerAuthRoutes } = await import("./routes.js");
  await registerAuthRoutes(local, auth);
  local.get(
    "/api/orgs/:orgId/admin-only",
    {
      preHandler: [
        makeRequireAuth(auth),
        makeRequireOrgRole(["admin"]),
      ],
    },
    async () => ({ ok: true })
  );
  await local.ready();

  const res = await local.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/admin-only`,
    headers: { cookie: aliceCookie },
  });
  assert.equal(res.statusCode, 403);
  await local.close();
});

test("makeRequireOrgRole(['owner','admin']) accepts an owner", async () => {
  const { makeRequireOrgRole } = await import("./tenant.js");
  const { makeRequireAuth } = await import("./middleware.js");
  const { selectAuthProvider } = await import("@altium-mcp/auth");
  const auth = selectAuthProvider();
  const local = Fastify({ logger: false });
  await local.register(cookie);
  const { registerAuthRoutes } = await import("./routes.js");
  await registerAuthRoutes(local, auth);
  local.get(
    "/api/orgs/:orgId/owner-or-admin",
    {
      preHandler: [
        makeRequireAuth(auth),
        makeRequireOrgRole(["owner", "admin"]),
      ],
    },
    async () => ({ ok: true })
  );
  await local.ready();

  const res = await local.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/owner-or-admin`,
    headers: { cookie: aliceCookie },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
  await local.close();
});

// ─── Two-org membership: pick the right org's role ──────────────────

test("a user in two orgs gets the right role per org context", async () => {
  // Add Alice as a 'member' in Bob's org.
  const { prisma } = await import("@altium-mcp/db");
  await prisma.membership.create({
    data: { orgId: bobOrgId, userId: aliceUserId, role: "member" },
  });

  // In her own org → owner.
  const ownOrg = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/info`,
    headers: { cookie: aliceCookie },
  });
  assert.equal(ownOrg.statusCode, 200);
  assert.equal(ownOrg.json().you.role, "owner");

  // In Bob's org → member.
  const bobsOrg = await app.inject({
    method: "GET",
    url: `/api/orgs/${bobOrgId}/info`,
    headers: { cookie: aliceCookie },
  });
  assert.equal(bobsOrg.statusCode, 200);
  assert.equal(bobsOrg.json().you.role, "member");
});

// ─── PR #7 review additions ─────────────────────────────────────────

test("a corrupt role string in DB is rejected as 403 (fail-closed defense)", async () => {
  // Add Bob to Alice's org with a deliberately-garbage role.
  const { prisma } = await import("@altium-mcp/db");
  // Bob is already in his own org from before/setup; if a previous
  // test added him to Alice's, we'd hit a unique-constraint. Use a
  // distinct extra user to keep this test independent.
  const extraSignup = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: {
      email: `corruptrole-${randomBytes(3).toString("hex")}@tenant-test.example`,
      password: STRONG,
    },
  });
  const extraCookie = extractCookie(extraSignup.headers["set-cookie"])!;
  const extraUserId = extraSignup.json().user.id;

  await prisma.membership.create({
    data: { orgId: aliceOrgId, userId: extraUserId, role: "superadmin" },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/info`,
    headers: { cookie: extraCookie },
  });
  // Despite being a "member" of Alice's org via the corrupt row, the
  // middleware refuses to honor an unknown role.
  assert.equal(res.statusCode, 403);
});

test("requireOrgOwner shorthand: accepts owner, rejects member", async () => {
  // Build a route protected by the requireOrgOwner shorthand.
  const { requireOrgOwner } = await import("./tenant.js");
  const { makeRequireAuth } = await import("./middleware.js");
  const { selectAuthProvider } = await import("@altium-mcp/auth");
  const { registerAuthRoutes } = await import("./routes.js");
  const auth = selectAuthProvider();

  const local = Fastify({ logger: false });
  await local.register(cookie);
  await registerAuthRoutes(local, auth);
  local.get(
    "/api/orgs/:orgId/owner-only",
    { preHandler: [makeRequireAuth(auth), requireOrgOwner] },
    async () => ({ ok: true })
  );
  await local.ready();

  // Alice owns aliceOrg → 200.
  const ownerRes = await local.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/owner-only`,
    headers: { cookie: aliceCookie },
  });
  assert.equal(ownerRes.statusCode, 200);

  // Alice is a `member` (not owner) of bobOrg per the earlier "two-org"
  // test that added the membership → 403.
  const memberRes = await local.inject({
    method: "GET",
    url: `/api/orgs/${bobOrgId}/owner-only`,
    headers: { cookie: aliceCookie },
  });
  assert.equal(memberRes.statusCode, 403);

  await local.close();
});

test("a malformed / extremely long :orgId stays in the 4xx range (no 500)", async () => {
  // Two cases worth pinning:
  //   1. A 4 KB orgId exceeds Fastify's default maxParamLength (100)
  //      and is rejected at routing → 404. That's fine; the request
  //      never reached our middleware.
  //   2. A short-but-bogus orgId reaches the middleware and 403s on
  //      "no Membership for this user in this org".
  // The contract: the server must NEVER 500 because of a malformed
  // path segment — that would be an unhandled exception in the
  // middleware, not a tenant-scope outcome.
  const longId = "X".repeat(4096);
  const long = await app.inject({
    method: "GET",
    url: `/api/orgs/${longId}/info`,
    headers: { cookie: aliceCookie },
  });
  assert.ok(
    long.statusCode >= 400 && long.statusCode < 500,
    `expected 4xx for over-long orgId, got ${long.statusCode}`
  );

  const bogus = await app.inject({
    method: "GET",
    url: "/api/orgs/cklbogus000000000000000xx/info",
    headers: { cookie: aliceCookie },
  });
  assert.equal(bogus.statusCode, 403);
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
