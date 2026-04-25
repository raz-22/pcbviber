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
