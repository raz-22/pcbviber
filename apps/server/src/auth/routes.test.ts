/**
 * End-to-end tests for /api/auth/* via Fastify `inject()`.
 *
 * Hermetic: isolated Postgres schema, applies migrations, builds a Fastify app
 * with cookie + auth routes wired, exercises the routes through HTTP-
 * shaped requests without ever opening a port.
 *
 * The Local provider runs because we leave WORKOS_API_KEY unset.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { setupTestDatabase } from "@altium-mcp/db/test-utils";

import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";

let app: FastifyInstance;
let teardown: () => Promise<void>;

before(async () => {
  ({ teardown } = await setupTestDatabase());
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.WORKOS_COOKIE_PASSWORD = randomBytes(48).toString("base64");
  delete process.env.WORKOS_API_KEY;
  delete process.env.WORKOS_CLIENT_ID;

  // Migrate the temp DB using the per-package prisma shim from packages/db.
  // Reset cached singletons that read env at import time.
  const { __resetSessionCacheForTests, __resetAuthProviderCacheForTests } =
    await import("@altium-mcp/auth");
  __resetSessionCacheForTests();
  __resetAuthProviderCacheForTests();

  // Build the test app — only the auth routes; we don't need MCP/AD
  // wiring to verify auth behavior.
  const { selectAuthProvider } = await import("@altium-mcp/auth");
  const { registerAuthRoutes } = await import("./routes.js");
  app = Fastify({ logger: false });
  await app.register(cookie);
  const auth = selectAuthProvider();
  await registerAuthRoutes(app, auth);
  await app.ready();
});

after(async () => {
  if (app) await app.close();
  await teardown();
});

const STRONG = "correct-horse-battery-staple-9";

// ─── Signup ─────────────────────────────────────────────────────────

test("POST /api/auth/signup creates user + org + sets cookie", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email: "alice@example.com", password: STRONG, name: "Alice" },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.user.email, "alice@example.com");
  assert.ok(body.org.id);
  assert.match(body.org.slug, /^alice/);
  assert.match(body.org.name, /Organization/);

  const setCookie = res.headers["set-cookie"];
  const setCookieStr = Array.isArray(setCookie) ? setCookie.join("; ") : (setCookie ?? "");
  assert.match(setCookieStr, /session=/);
  assert.match(setCookieStr, /HttpOnly/i);
  assert.match(setCookieStr, /SameSite=Lax/i);
});

test("POST /api/auth/signup rejects duplicate email with 409", async () => {
  // Pre-existing alice@example.com from the previous test.
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email: "alice@example.com", password: STRONG },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, "email_taken");
});

test("POST /api/auth/signup rejects weak password with 400", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email: "weak@example.com", password: "short" },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "password_too_weak");
});

test("POST /api/auth/signup rejects malformed email with 400", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email: "not-an-email", password: STRONG },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "invalid_input");
});

test("POST /api/auth/signup honours custom orgName", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: {
      email: "bob@example.com",
      password: STRONG,
      orgName: "Bob's Hardware Co.",
    },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.org.name, "Bob's Hardware Co.");
  assert.equal(body.org.slug, "bob-s-hardware-co");
});

// ─── Login + cookie cycle ───────────────────────────────────────────

test("POST /api/auth/login with right password returns user + orgs + cookie", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "alice@example.com", password: STRONG },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.user.email, "alice@example.com");
  assert.equal(body.orgs.length, 1);
  assert.equal(body.orgs[0].role, "owner");

  const setCookie = res.headers["set-cookie"];
  const setCookieStr = Array.isArray(setCookie) ? setCookie.join("; ") : (setCookie ?? "");
  assert.match(setCookieStr, /session=/);
});

test("POST /api/auth/login wrong password returns 401 invalid_credentials", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "alice@example.com", password: "wrong-but-long-enough" },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "invalid_credentials");
});

test("POST /api/auth/login unknown email returns 401 (same code as wrong password)", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "nobody@example.com", password: STRONG },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "invalid_credentials");
});

// ─── Me + auth gating ────────────────────────────────────────────────

test("GET /api/auth/me without cookie returns 401", async () => {
  const res = await app.inject({ method: "GET", url: "/api/auth/me" });
  assert.equal(res.statusCode, 401);
});

test("GET /api/auth/me with a valid session cookie returns user + orgs", async () => {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "alice@example.com", password: STRONG },
  });
  const sessionCookie = extractSessionCookie(login.headers["set-cookie"]);
  assert.ok(sessionCookie);

  const me = await app.inject({
    method: "GET",
    url: "/api/auth/me",
    headers: { cookie: sessionCookie },
  });
  assert.equal(me.statusCode, 200);
  const body = me.json();
  assert.equal(body.user.email, "alice@example.com");
  assert.equal(body.orgs.length, 1);
  assert.equal(body.orgs[0].role, "owner");
});

test("POST /api/auth/signup response carries billingStatus=trialing + trialEndsAt", async () => {
  // The SPA seeds ["auth","me"] from this response so the post-signup
  // navigate(/) renders billing state without a re-fetch. Pin the
  // fields are present on the wire so the SPA's seed isn't blank.
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email: "trial-signup@example.com", password: STRONG },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.org.billingStatus, "trialing");
  assert.ok(typeof body.org.trialEndsAt === "string");
  // Trial deadline is in the future.
  assert.ok(new Date(body.org.trialEndsAt).getTime() > Date.now());
});

test("GET /api/auth/me carries per-org billingStatus + trialEndsAt", async () => {
  // Sign up a fresh user so we know exactly which org's billing state
  // we expect.
  await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email: "trial-me@example.com", password: STRONG },
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "trial-me@example.com", password: STRONG },
  });
  const sessionCookie = extractSessionCookie(login.headers["set-cookie"]);
  assert.ok(sessionCookie);

  const me = await app.inject({
    method: "GET",
    url: "/api/auth/me",
    headers: { cookie: sessionCookie },
  });
  const body = me.json();
  assert.equal(body.orgs[0].billingStatus, "trialing");
  assert.ok(typeof body.orgs[0].trialEndsAt === "string");
});

test("GET /api/auth/me with a tampered session cookie returns 401 + clears cookie", async () => {
  const me = await app.inject({
    method: "GET",
    url: "/api/auth/me",
    headers: { cookie: "session=not-a-valid-token" },
  });
  assert.equal(me.statusCode, 401);
  // Server should explicitly clear the bad cookie.
  const setCookie = me.headers["set-cookie"];
  const setCookieStr = Array.isArray(setCookie) ? setCookie.join("; ") : (setCookie ?? "");
  assert.match(setCookieStr, /session=/);
});

// ─── Logout ─────────────────────────────────────────────────────────

test("POST /api/auth/logout clears cookie + revokes session", async () => {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "alice@example.com", password: STRONG },
  });
  const sessionCookie = extractSessionCookie(login.headers["set-cookie"]);
  assert.ok(sessionCookie);

  const logout = await app.inject({
    method: "POST",
    url: "/api/auth/logout",
    headers: { cookie: sessionCookie },
  });
  assert.equal(logout.statusCode, 200);
  assert.equal(logout.json().ok, true);

  // The cookie's still in our test client's hand, but verifySession
  // should now reject it (revoked). The server signals "log out" by
  // setting an expired Set-Cookie header.
  const setCookie = logout.headers["set-cookie"];
  const setCookieStr = Array.isArray(setCookie) ? setCookie.join("; ") : (setCookie ?? "");
  assert.match(setCookieStr, /session=/);
  // Best-effort revocation check: re-using the OLD sealed token after
  // logout should NOT authenticate (revoked session id is in the
  // local provider's in-memory set).
  const me = await app.inject({
    method: "GET",
    url: "/api/auth/me",
    headers: { cookie: sessionCookie },
  });
  assert.equal(me.statusCode, 401);
});

test("POST /api/auth/logout without a cookie still 200s (idempotent)", async () => {
  const res = await app.inject({ method: "POST", url: "/api/auth/logout" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
});

// ─── Audit log ──────────────────────────────────────────────────────

test("signup writes an AuditLog entry", async () => {
  // Use a fresh email so we get a fresh signup audit row.
  const email = `audit-${randomBytes(4).toString("hex")}@example.com`;
  const signup = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email, password: STRONG },
  });
  assert.equal(signup.statusCode, 200);
  const orgId = signup.json().org.id;

  const { prisma } = await import("@altium-mcp/db");
  const logs = await prisma.auditLog.findMany({
    where: { orgId, action: "signup" },
  });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].action, "signup");
  assert.ok(logs[0].actorUserId);
});

// ─── PR #4 review additions ─────────────────────────────────────────

test("login writes an AuditLog entry tied to the user's anchor org", async () => {
  // Fresh user so we get a clean audit log.
  const email = `login-audit-${randomBytes(4).toString("hex")}@example.com`;
  const signup = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email, password: STRONG },
  });
  const orgId = signup.json().org.id;

  await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password: STRONG },
  });

  const { prisma } = await import("@altium-mcp/db");
  const logs = await prisma.auditLog.findMany({
    where: { orgId, action: "login" },
  });
  assert.ok(logs.length >= 1, "expected at least one login audit row");
  assert.ok(logs[0].actorUserId);
});

test("logout writes an AuditLog entry", async () => {
  const email = `logout-audit-${randomBytes(4).toString("hex")}@example.com`;
  const signup = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email, password: STRONG },
  });
  const orgId = signup.json().org.id;
  const sessionCookie = extractSessionCookie(signup.headers["set-cookie"]);
  assert.ok(sessionCookie);

  await app.inject({
    method: "POST",
    url: "/api/auth/logout",
    headers: { cookie: sessionCookie },
  });

  const { prisma } = await import("@altium-mcp/db");
  const logs = await prisma.auditLog.findMany({
    where: { orgId, action: "logout" },
  });
  assert.equal(logs.length, 1);
});

test("/me response shape: never leaks workosUserId or any password field", async () => {
  // Use the existing alice account.
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "alice@example.com", password: STRONG },
  });
  const sessionCookie = extractSessionCookie(login.headers["set-cookie"]);
  assert.ok(sessionCookie);

  const me = await app.inject({
    method: "GET",
    url: "/api/auth/me",
    headers: { cookie: sessionCookie },
  });
  assert.equal(me.statusCode, 200);
  const body = me.json();
  // Surface check: only the known-safe keys appear on user.
  const userKeys = Object.keys(body.user).sort();
  assert.deepEqual(userKeys, ["createdAt", "email", "emailVerifiedAt", "id"]);
  // Defense in depth: no password-ish field anywhere in the body.
  const json = JSON.stringify(body);
  assert.doesNotMatch(json, /password/i);
  assert.doesNotMatch(json, /workos/i);
  assert.doesNotMatch(json, /scrypt/i);
});

test("signup body without email is rejected with invalid_input (Zod)", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { password: STRONG },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "invalid_input");
});

test("signup body without password is rejected with invalid_input", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email: "no-pw@example.com" },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "invalid_input");
});

test("login body without password is rejected with invalid_input", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "alice@example.com" },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "invalid_input");
});

test("signup body with non-JSON returns 400 (not 500)", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    headers: { "content-type": "text/plain" },
    payload: "garbage",
  });
  // Fastify rejects unsupported media type with 415; either way it's
  // NOT a 500. Both 400 and 415 are acceptable client-error responses.
  assert.ok(
    res.statusCode === 400 || res.statusCode === 415,
    `expected 4xx, got ${res.statusCode}`
  );
});

test("orgName with extreme length is rejected by Zod (max 120)", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: {
      email: `long-org-${randomBytes(3).toString("hex")}@example.com`,
      password: STRONG,
      orgName: "A".repeat(200),
    },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "invalid_input");
});

test("name with extreme length is rejected by Zod (max 120)", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: {
      email: `long-name-${randomBytes(3).toString("hex")}@example.com`,
      password: STRONG,
      name: "A".repeat(200),
    },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "invalid_input");
});

test("signup persists audit ip + userAgent when client provides them", async () => {
  const email = `ip-audit-${randomBytes(4).toString("hex")}@example.com`;
  const signup = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email, password: STRONG },
    headers: {
      "x-forwarded-for": "203.0.113.7, 10.0.0.1",
      "user-agent": "TestAgent/1.0",
    },
  });
  assert.equal(signup.statusCode, 200);
  const orgId = signup.json().org.id;

  const { prisma } = await import("@altium-mcp/db");
  const log = await prisma.auditLog.findFirst({
    where: { orgId, action: "signup" },
  });
  assert.ok(log);
  // First IP from X-Forwarded-For is what we want to record.
  assert.equal(log.ip, "203.0.113.7");
  assert.equal(log.userAgent, "TestAgent/1.0");
});

// ─── helpers ────────────────────────────────────────────────────────

function extractSessionCookie(
  setCookie: string | string[] | undefined
): string | null {
  if (!setCookie) return null;
  const all = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const sc of all) {
    const m = /^session=([^;]*)/i.exec(sc);
    if (m && m[1] && m[1].length > 0) return `session=${m[1]}`;
  }
  return null;
}
