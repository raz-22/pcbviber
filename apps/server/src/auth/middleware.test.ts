/**
 * Direct tests for the auth middleware factories.
 *
 * routes.test.ts covers makeRequireAuth via the live signup/login/me
 * flows. This file exercises the middleware standalone with a mock
 * AuthProvider so the cookie-handling, optional-vs-required behavior,
 * and stale-cookie clearing are pinned without going through the full
 * provider.
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

const FIXED_USER = {
  id: "user_fixed_id",
  email: "fixed@example.com",
  emailVerifiedAt: null,
  workosUserId: null,
  createdAt: new Date(),
};

before(async () => {
  workdir = mkdtempSync(join(tmpdir(), "altium-mcp-mw-test-"));
  const dbPath = join(workdir, "test.db").replace(/\\/g, "/");
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.WORKOS_COOKIE_PASSWORD = randomBytes(48).toString("base64");

  // The middleware loads memberships from the DB, so we still need the
  // schema applied even with a mock AuthProvider.
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

  const { prisma } = await import("@altium-mcp/db");
  await prisma.user.create({
    data: { id: FIXED_USER.id, email: FIXED_USER.email },
  });

  const { makeRequireAuth, makeOptionalAuth } = await import("./middleware.js");

  // Mock AuthProvider — accepts the literal token "valid-token" and
  // returns FIXED_USER, otherwise returns null. No actual JWT verify.
  const auth = {
    kind: "local" as const,
    async signup() {
      throw new Error("not used");
    },
    async login() {
      throw new Error("not used");
    },
    async logout() {},
    async getUser() {
      return FIXED_USER;
    },
    async issueSession() {
      throw new Error("not used");
    },
    async verifySession(sealed: string) {
      return sealed === "valid-token" ? FIXED_USER : null;
    },
  };

  app = Fastify({ logger: false });
  await app.register(cookie);

  app.get(
    "/required",
    { preHandler: makeRequireAuth(auth) },
    async (req) => ({
      userId: req.user?.id ?? null,
      memberships: req.memberships?.length ?? 0,
    })
  );

  app.get(
    "/optional",
    { preHandler: makeOptionalAuth(auth) },
    async (req) => ({
      userId: req.user?.id ?? null,
      hasUser: !!req.user,
    })
  );

  await app.ready();
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

// ─── makeRequireAuth ─────────────────────────────────────────────────

test("requireAuth returns 401 when no cookie is sent", async () => {
  const res = await app.inject({ method: "GET", url: "/required" });
  assert.equal(res.statusCode, 401);
});

test("requireAuth returns 401 + clears cookie when token is invalid", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/required",
    headers: { cookie: "session=garbage" },
  });
  assert.equal(res.statusCode, 401);
  const setCookie = res.headers["set-cookie"];
  const setCookieStr = Array.isArray(setCookie) ? setCookie.join("; ") : (setCookie ?? "");
  // clearCookie sends a Set-Cookie with empty value + immediate expiry.
  assert.match(setCookieStr, /session=/);
});

test("requireAuth attaches req.user when token is valid", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/required",
    headers: { cookie: "session=valid-token" },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.userId, FIXED_USER.id);
  assert.equal(body.memberships, 0);
});

// ─── makeOptionalAuth ────────────────────────────────────────────────

test("optionalAuth returns 200 with no user when no cookie is sent", async () => {
  const res = await app.inject({ method: "GET", url: "/optional" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.hasUser, false);
});

test("optionalAuth returns 200 with no user when token is invalid", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/optional",
    headers: { cookie: "session=garbage" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().hasUser, false);
});

test("optionalAuth populates req.user when token is valid", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/optional",
    headers: { cookie: "session=valid-token" },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.hasUser, true);
  assert.equal(body.userId, FIXED_USER.id);
});

test("optionalAuth: attached user includes memberships ordered by createdAt", async () => {
  // Add two memberships across two orgs and verify order survives.
  const { prisma } = await import("@altium-mcp/db");
  const orgA = await prisma.organization.create({
    data: { name: "First Org", slug: "first-org-mw" },
  });
  // tiny delay so the second membership has a later createdAt even on
  // platforms that bucket Date.now() at coarse resolution.
  await new Promise((r) => setTimeout(r, 25));
  const orgB = await prisma.organization.create({
    data: { name: "Second Org", slug: "second-org-mw" },
  });
  await prisma.membership.create({
    data: { orgId: orgA.id, userId: FIXED_USER.id, role: "owner" },
  });
  await prisma.membership.create({
    data: { orgId: orgB.id, userId: FIXED_USER.id, role: "member" },
  });

  // Re-issue a request and check membership count + ordering.
  const { makeOptionalAuth } = await import("./middleware.js");
  const auth = {
    kind: "local" as const,
    async signup() {
      throw new Error("nu");
    },
    async login() {
      throw new Error("nu");
    },
    async logout() {},
    async getUser() {
      return FIXED_USER;
    },
    async issueSession() {
      throw new Error("nu");
    },
    async verifySession(sealed: string) {
      return sealed === "valid-token" ? FIXED_USER : null;
    },
  };
  const local = Fastify({ logger: false });
  await local.register(cookie);
  local.get(
    "/orgs",
    { preHandler: makeOptionalAuth(auth) },
    async (req) => ({
      orgs: req.memberships ?? [],
    })
  );
  await local.ready();

  const res = await local.inject({
    method: "GET",
    url: "/orgs",
    headers: { cookie: "session=valid-token" },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.orgs.length, 2);
  // First Org (owner) was created first; should come first.
  assert.equal(body.orgs[0].orgSlug, "first-org-mw");
  assert.equal(body.orgs[0].role, "owner");
  assert.equal(body.orgs[1].orgSlug, "second-org-mw");
  assert.equal(body.orgs[1].role, "member");

  await local.close();
});

// ─── setSessionCookie / clearSessionCookie ──────────────────────────

test("setSessionCookie emits Set-Cookie with HttpOnly + SameSite=Lax + Path=/", async () => {
  const { setSessionCookie } = await import("./middleware.js");
  const local = Fastify({ logger: false });
  await local.register(cookie);
  local.get("/set", async (_req, reply) => {
    setSessionCookie(reply, "test-token-value", new Date(Date.now() + 900_000));
    return { ok: true };
  });
  await local.ready();

  const res = await local.inject({ method: "GET", url: "/set" });
  const setCookie = res.headers["set-cookie"];
  const setCookieStr = Array.isArray(setCookie) ? setCookie.join("; ") : (setCookie ?? "");
  assert.match(setCookieStr, /session=test-token-value/);
  assert.match(setCookieStr, /HttpOnly/i);
  assert.match(setCookieStr, /SameSite=Lax/i);
  assert.match(setCookieStr, /Path=\//);
  // Test env is not "production", so Secure should NOT be present.
  assert.doesNotMatch(setCookieStr, /Secure/i);

  await local.close();
});

test("clearSessionCookie emits an expired Set-Cookie", async () => {
  const { clearSessionCookie } = await import("./middleware.js");
  const local = Fastify({ logger: false });
  await local.register(cookie);
  local.get("/clear", async (_req, reply) => {
    clearSessionCookie(reply);
    return { ok: true };
  });
  await local.ready();

  const res = await local.inject({ method: "GET", url: "/clear" });
  const setCookie = res.headers["set-cookie"];
  const setCookieStr = Array.isArray(setCookie) ? setCookie.join("; ") : (setCookie ?? "");
  // Fastify's clearCookie sets value to "" and Expires to Thu, 01 Jan 1970.
  assert.match(setCookieStr, /session=/);
  assert.match(setCookieStr, /Expires=Thu, 01 Jan 1970/i);

  await local.close();
});
