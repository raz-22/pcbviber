/**
 * SSO route integration tests.
 *
 * The active AuthProvider here is a stub that mirrors the
 * WorkOSAuthProvider's `startSso` / `completeSsoCallback` shape.
 * That keeps these tests focused on:
 *
 *   - State JWT signing + verification at the route boundary
 *   - Org / connection lookup edge cases (unknown org, no SSO)
 *   - Membership creation on first SSO + idempotent re-login
 *   - Audit row written for sso.signup / sso.login
 *   - Open-redirect defense via returnTo sanitization
 *
 * No real WorkOS SDK calls — that's left for a manual sandbox
 * smoke when an operator wires up a real connection.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setupTestDatabase } from "@altium-mcp/db/test-utils";
import {
  type AuthProvider,
  type AuthUser,
  type Session,
  type SignupInput,
  type SignupResult,
  type LoginInput,
  type LoginResult,
} from "@altium-mcp/auth";

import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";

let app: FastifyInstance;
let teardown: () => Promise<void>;
let testOrgId: string;
let testOrgSlug: string;
const STORE: { lastStartArgs: unknown; lastCallbackArgs: unknown } = {
  lastStartArgs: null,
  lastCallbackArgs: null,
};

const STUB_AUTH_URL =
  "https://api.workos.com/sso/authorize?stub=1";
const NEW_USER_EMAIL = "sso-new@enterprise.test";

before(async () => {
  ({ teardown } = await setupTestDatabase());
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.WORKOS_COOKIE_PASSWORD = randomBytes(48).toString("base64");
  process.env.APP_BASE_URL = "http://test-host:3000";

  const { __resetSessionCacheForTests } = await import("@altium-mcp/auth");
  __resetSessionCacheForTests();
  const { __resetSsoStateCacheForTests } = await import("./sso-state.js");
  __resetSsoStateCacheForTests();

  // Stub provider. The WorkOSAuthProvider's startSso is a pure call
  // into the WorkOS SDK; modeling it as a deterministic stub lets us
  // assert the route plumbed orgId / returnTo / state correctly.
  const { signSession } = await import("@altium-mcp/auth");
  const { prisma } = await import("@altium-mcp/db");

  async function issueSession(userId: string): Promise<Session> {
    const signed = await signSession(userId, { issuer: "altium-mcp/test" });
    return {
      sealed: signed.sealed,
      userId,
      expiresAt: signed.expiresAt,
    };
  }

  const stubProvider: AuthProvider = {
    kind: "workos",
    async signup(_: SignupInput): Promise<SignupResult> {
      throw new Error("stub: signup not used in SSO tests");
    },
    async login(_: LoginInput): Promise<LoginResult> {
      throw new Error("stub: login not used in SSO tests");
    },
    async verifySession(_sealed: string): Promise<AuthUser | null> {
      return null;
    },
    async logout(_sealed: string): Promise<void> {},
    async getUser(userId: string) {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      return user
        ? {
            id: user.id,
            email: user.email,
            emailVerifiedAt: user.emailVerifiedAt,
            workosUserId: user.workosUserId,
            createdAt: user.createdAt,
          }
        : null;
    },
    issueSession,
    startSso(opts) {
      STORE.lastStartArgs = opts;
      // Echo state in the URL so tests can confirm it's threaded.
      return `${STUB_AUTH_URL}&state=${encodeURIComponent(opts.state)}`;
    },
    async completeSsoCallback(opts) {
      STORE.lastCallbackArgs = opts;
      // Two synthetic IdP profiles, keyed on the `code` value the
      // route forwards. Real WorkOS exchanges the code for a profile;
      // the stub just returns one we control.
      const profileFor: Record<
        string,
        { email: string; workosUserId: string }
      > = {
        good_new: { email: NEW_USER_EMAIL, workosUserId: "wos_new" },
        good_existing: {
          email: "sso-existing@enterprise.test",
          workosUserId: "wos_existing",
        },
      };
      const profile = profileFor[opts.code];
      if (!profile) {
        const { AuthError } = await import("@altium-mcp/auth");
        throw new AuthError("invalid_credentials", "stub: bad code");
      }
      const before = await prisma.user.findUnique({
        where: { email: profile.email },
        select: { id: true },
      });
      const user = await prisma.user.upsert({
        where: { email: profile.email },
        update: { workosUserId: profile.workosUserId },
        create: {
          email: profile.email,
          workosUserId: profile.workosUserId,
          emailVerifiedAt: new Date(),
        },
      });
      const session = await issueSession(user.id);
      return {
        user: {
          id: user.id,
          email: user.email,
          emailVerifiedAt: user.emailVerifiedAt,
          workosUserId: user.workosUserId,
          createdAt: user.createdAt,
        },
        session,
        isNewUser: !before,
      };
    },
  };

  const { registerSsoRoutes } = await import("./sso-routes.js");
  app = Fastify({ logger: false });
  await app.register(cookie);
  await registerSsoRoutes(app, stubProvider);
  await app.ready();

  // Seed an org with an SSO connection set + an existing SSO user
  // for the "second login" idempotency test.
  const org = await prisma.organization.create({
    data: {
      name: "Enterprise Co",
      slug: "enterprise-co",
      workosConnectionId: "conn_test_01",
    },
  });
  testOrgId = org.id;
  testOrgSlug = org.slug;

  const existing = await prisma.user.create({
    data: {
      email: "sso-existing@enterprise.test",
      workosUserId: "wos_existing",
      emailVerifiedAt: new Date(),
    },
  });
  await prisma.membership.create({
    data: { orgId: org.id, userId: existing.id, role: "member" },
  });
});

after(async () => {
  if (app) await app.close();
  const { prisma } = await import("@altium-mcp/db");
  await prisma.$disconnect();
  await teardown();
});

// ─── /sso/start ─────────────────────────────────────────────────────

test("GET /sso/start: 302s to provider URL with state in query", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/auth/sso/start?orgSlug=${testOrgSlug}&returnTo=/settings`,
  });
  assert.equal(res.statusCode, 302);
  const loc = res.headers.location as string;
  assert.match(loc, /api\.workos\.com\/sso\/authorize/);
  assert.match(loc, /state=/);
});

test("GET /sso/start: provider receives connectionId, redirectUri, state", async () => {
  await app.inject({
    method: "GET",
    url: `/api/auth/sso/start?orgSlug=${testOrgSlug}`,
  });
  const args = STORE.lastStartArgs as {
    connectionId: string;
    redirectUri: string;
    state: string;
  };
  assert.equal(args.connectionId, "conn_test_01");
  assert.equal(args.redirectUri, "http://test-host:3000/api/auth/sso/callback");
  assert.ok(args.state.length > 0, "state JWT should be non-empty");
});

test("GET /sso/start: unknown orgSlug → 404 sso_not_configured", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/auth/sso/start?orgSlug=does-not-exist`,
  });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, "sso_not_configured");
});

test("GET /sso/start: org with no workosConnectionId → 404 sso_not_configured", async () => {
  // Create a fresh org without a connection id. Same response shape
  // as "unknown org" — defense against probing.
  const { prisma } = await import("@altium-mcp/db");
  await prisma.organization.create({
    data: { name: "No SSO Co", slug: "no-sso-co" },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/auth/sso/start?orgSlug=no-sso-co`,
  });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, "sso_not_configured");
});

test("GET /sso/start: missing orgSlug → 400 invalid_input", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/auth/sso/start`,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "invalid_input");
});

// ─── /sso/callback ──────────────────────────────────────────────────

test("GET /sso/callback: valid state + good code creates user + membership + session, redirects to returnTo", async () => {
  // Acquire a state by going through start (signed by the route).
  const startRes = await app.inject({
    method: "GET",
    url: `/api/auth/sso/start?orgSlug=${testOrgSlug}&returnTo=/settings/usage`,
  });
  const state = new URL(startRes.headers.location as string).searchParams.get(
    "state"
  )!;

  const res = await app.inject({
    method: "GET",
    url: `/api/auth/sso/callback?code=good_new&state=${encodeURIComponent(state)}`,
  });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, "/settings/usage");

  // Session cookie set.
  const setCookie = res.headers["set-cookie"];
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie!];
  assert.ok(
    cookies.some((c) => /^session=/.test(String(c))),
    "session cookie should be set on the response"
  );

  // User row + membership created.
  const { prisma } = await import("@altium-mcp/db");
  const user = await prisma.user.findUnique({
    where: { email: NEW_USER_EMAIL },
  });
  assert.ok(user, "new user row should exist");
  const membership = await prisma.membership.findUnique({
    where: { orgId_userId: { orgId: testOrgId, userId: user!.id } },
  });
  assert.ok(membership, "membership should be auto-created on first SSO");
  assert.equal(membership!.role, "member");

  // Audit row written tagged sso.signup with metadata.firstMembership=true.
  const audit = await prisma.auditLog.findFirst({
    where: { orgId: testOrgId, action: "sso.signup", actorUserId: user!.id },
  });
  assert.ok(audit);
  assert.match(audit!.metadata ?? "", /"firstMembership":true/);
});

test("GET /sso/callback: returning user → no duplicate membership, sso.login audit", async () => {
  const startRes = await app.inject({
    method: "GET",
    url: `/api/auth/sso/start?orgSlug=${testOrgSlug}`,
  });
  const state = new URL(startRes.headers.location as string).searchParams.get(
    "state"
  )!;

  const res = await app.inject({
    method: "GET",
    url: `/api/auth/sso/callback?code=good_existing&state=${encodeURIComponent(state)}`,
  });
  assert.equal(res.statusCode, 302);

  const { prisma } = await import("@altium-mcp/db");
  const memberships = await prisma.membership.findMany({
    where: {
      orgId: testOrgId,
      user: { email: "sso-existing@enterprise.test" },
    },
  });
  assert.equal(
    memberships.length,
    1,
    "second SSO of an existing member must not duplicate the membership"
  );

  const audit = await prisma.auditLog.findFirst({
    where: { orgId: testOrgId, action: "sso.login" },
    orderBy: { timestamp: "desc" },
  });
  assert.ok(audit, "sso.login audit row should be written");
});

test("GET /sso/callback: bad code → 401 sso_callback_failed", async () => {
  const startRes = await app.inject({
    method: "GET",
    url: `/api/auth/sso/start?orgSlug=${testOrgSlug}`,
  });
  const state = new URL(startRes.headers.location as string).searchParams.get(
    "state"
  )!;
  const res = await app.inject({
    method: "GET",
    url: `/api/auth/sso/callback?code=evil&state=${encodeURIComponent(state)}`,
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "sso_callback_failed");
});

test("GET /sso/callback: tampered state → 400 sso_state_invalid", async () => {
  const startRes = await app.inject({
    method: "GET",
    url: `/api/auth/sso/start?orgSlug=${testOrgSlug}`,
  });
  const state = new URL(startRes.headers.location as string).searchParams.get(
    "state"
  )!;
  // Flip a character in the signature segment.
  const dot = state.lastIndexOf(".");
  const bad = state.slice(0, dot + 1) + "Aaa" + state.slice(dot + 4);
  const res = await app.inject({
    method: "GET",
    url: `/api/auth/sso/callback?code=good_new&state=${encodeURIComponent(bad)}`,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "sso_state_invalid");
});

test("GET /sso/callback: missing query params → 400 invalid_input", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/auth/sso/callback`,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "invalid_input");
});

test("GET /sso/callback: open-redirect attempt in returnTo collapses to '/'", async () => {
  // Build a state whose returnTo is '//evil.com'. The state JWT
  // sanitizes at sign time, so we have to forge our own. Sign with
  // the cookie password, pass through the route — the verify path
  // re-sanitizes, and the redirect Location is `/`.
  const { SignJWT } = await import("jose");
  const key = new Uint8Array(
    Buffer.from(process.env.WORKOS_COOKIE_PASSWORD!, "utf8")
  );
  const malicious = await new SignJWT({
    orgId: testOrgId,
    returnTo: "//evil.com",
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setIssuer("altium-mcp/sso-state")
    .setExpirationTime("10m")
    .sign(key);

  const res = await app.inject({
    method: "GET",
    url: `/api/auth/sso/callback?code=good_existing&state=${encodeURIComponent(malicious)}`,
  });
  assert.equal(res.statusCode, 302);
  assert.equal(
    res.headers.location,
    "/",
    "malicious returnTo must collapse to root"
  );
});

test("GET /sso/callback: org with SSO disabled between start and callback → 400 sso_not_configured", async () => {
  // Fresh org, sign a state, then unset workosConnectionId BEFORE
  // calling /callback. The callback re-checks the connection — an
  // admin who disabled SSO in the window between start and callback
  // shouldn't accidentally complete an auth.
  const { prisma } = await import("@altium-mcp/db");
  const org = await prisma.organization.create({
    data: {
      name: "Disabled Co",
      slug: "disabled-co",
      workosConnectionId: "conn_temp",
    },
  });
  const startRes = await app.inject({
    method: "GET",
    url: `/api/auth/sso/start?orgSlug=disabled-co`,
  });
  const state = new URL(startRes.headers.location as string).searchParams.get(
    "state"
  )!;
  // Disable SSO on the org.
  await prisma.organization.update({
    where: { id: org.id },
    data: { workosConnectionId: null },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/auth/sso/callback?code=good_existing&state=${encodeURIComponent(state)}`,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "sso_not_configured");
});

// ─── Provider doesn't support SSO ───────────────────────────────────

test("GET /sso/start: 503 when provider has no startSso (LocalAuth-style)", async () => {
  // Spin a separate Fastify with a stub that omits startSso.
  const { __resetSessionCacheForTests } = await import("@altium-mcp/auth");
  __resetSessionCacheForTests();
  const noSsoApp = Fastify({ logger: false });
  await noSsoApp.register(cookie);
  const noSsoProvider: AuthProvider = {
    kind: "local",
    async signup(_: SignupInput): Promise<SignupResult> {
      throw new Error("stub");
    },
    async login(_: LoginInput): Promise<LoginResult> {
      throw new Error("stub");
    },
    async verifySession(_sealed) {
      return null;
    },
    async logout(_sealed) {},
    async getUser(_id) {
      return null;
    },
    async issueSession(userId) {
      const { signSession } = await import("@altium-mcp/auth");
      const signed = await signSession(userId, { issuer: "altium-mcp/test" });
      return { sealed: signed.sealed, userId, expiresAt: signed.expiresAt };
    },
    // intentionally NO startSso / completeSsoCallback
  };
  const { registerSsoRoutes } = await import("./sso-routes.js");
  await registerSsoRoutes(noSsoApp, noSsoProvider);
  await noSsoApp.ready();
  const res = await noSsoApp.inject({
    method: "GET",
    url: `/api/auth/sso/start?orgSlug=${testOrgSlug}`,
  });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error, "sso_not_configured");
  await noSsoApp.close();
});
