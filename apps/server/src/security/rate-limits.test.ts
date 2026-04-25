/**
 * Rate-limit integration tests — pin the per-route caps from spec
 * §3.6 + the 429 response shape that the SPA's mapper depends on.
 *
 * Hermetic: in-memory store (the plugin's default when no Redis is
 * passed). Each test boots its own Fastify so buckets don't leak
 * across cases.
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
import rateLimit from "@fastify/rate-limit";

import {
  AUTH_RATE_LIMIT,
  INVITE_RATE_LIMIT,
  MCP_RATE_LIMIT,
  installRateLimitErrorHandler,
  rateLimitErrorBuilder,
} from "./rate-limits.js";

let workdir: string;

const STRONG = "correct-horse-battery-staple-9";

// ── DB bootstrap (shared across tests in this file) ─────────────────

before(async () => {
  workdir = mkdtempSync(join(tmpdir(), "altium-mcp-rate-limit-test-"));
  const dbPath = join(workdir, "test.db").replace(/\\/g, "/");
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.WORKOS_COOKIE_PASSWORD = randomBytes(48).toString("base64");
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
});

after(async () => {
  const { prisma } = await import("@altium-mcp/db");
  await prisma.$disconnect();
  try {
    rmSync(workdir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/**
 * Builds a fresh Fastify with rate-limit + auth routes wired.
 * Each test gets its own app so bucket state never leaks.
 *
 * The 429 errorResponseBuilder mirrors the production wiring in
 * http.ts — keeping the test rig truthful about the body shape.
 */
async function buildAuthApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: rateLimitErrorBuilder,
  });
  installRateLimitErrorHandler(app);
  const { selectAuthProvider } = await import("@altium-mcp/auth");
  const { registerAuthRoutes } = await import("../auth/routes.js");
  await registerAuthRoutes(app, selectAuthProvider());
  await app.ready();
  return app;
}

async function buildInviteApp(): Promise<{
  app: FastifyInstance;
  ownerCookie: string;
  orgId: string;
}> {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: rateLimitErrorBuilder,
  });
  installRateLimitErrorHandler(app);
  const { selectAuthProvider } = await import("@altium-mcp/auth");
  const { registerAuthRoutes } = await import("../auth/routes.js");
  const { registerMemberRoutes } = await import("../members/routes.js");
  const auth = selectAuthProvider();
  await registerAuthRoutes(app, auth);
  await registerMemberRoutes(app, auth);
  await app.ready();

  // Sign one owner up so we have an org + cookie for the invite calls.
  const signup = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: {
      email: `owner-${randomBytes(4).toString("hex")}@rate-limit.example`,
      password: STRONG,
    },
  });
  const orgId = signup.json().org.id;
  const setCookie = signup.headers["set-cookie"];
  const all = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
  let cookieHeader: string | null = null;
  for (const sc of all) {
    const m = /^session=([^;]*)/i.exec(sc);
    if (m && m[1] && m[1].length > 0) {
      cookieHeader = `session=${m[1]}`;
      break;
    }
  }
  if (!cookieHeader) throw new Error("test: missing session cookie after signup");
  return { app, ownerCookie: cookieHeader, orgId };
}

// ── /api/auth/login ──────────────────────────────────────────────────

test("login: 5/min/IP cap — 6th request returns 429 rate_limited", async () => {
  const app = await buildAuthApp();
  try {
    // 5 wrong-credentials attempts all return 401, but each consumes
    // a token from the bucket. The 6th gets 429 BEFORE the auth
    // provider runs — that's the whole point of the limit.
    for (let i = 0; i < AUTH_RATE_LIMIT.max; i += 1) {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "nobody@nowhere.example", password: "wrong-pw-1234" },
      });
      assert.equal(res.statusCode, 401, `attempt ${i + 1} should be 401`);
    }
    const sixth = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "nobody@nowhere.example", password: "wrong-pw-1234" },
    });
    assert.equal(sixth.statusCode, 429);
    assert.equal(sixth.json().error, "rate_limited");
    assert.equal(typeof sixth.json().detail.retryAfterSeconds, "number");
    // Retry-After header (RFC 6585) so well-behaved clients can back off.
    assert.ok(sixth.headers["retry-after"]);
  } finally {
    await app.close();
  }
});

test("signup: 5/min/IP cap on its own route", async () => {
  // @fastify/rate-limit scopes each route's bucket independently
  // even when keyGenerators return the same string. So /signup
  // and /login each get their own 5/min/IP bucket — an attacker
  // hammering both hits 5+5 = 10 attempts/min/IP, not 5. That's
  // still a meaningful throttle on credential probing; tightening
  // to a shared bucket would require setting `nameSpace` and is
  // a follow-up if real-world abuse warrants it.
  const app = await buildAuthApp();
  try {
    const fresh = () => `${randomBytes(4).toString("hex")}@rl.example`;
    for (let i = 0; i < AUTH_RATE_LIMIT.max; i += 1) {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/signup",
        payload: { email: fresh(), password: STRONG },
      });
      // Signup succeeds (200 — the route doesn't set 201 explicitly,
      // matches the existing /api/auth/signup test).
      assert.equal(res.statusCode, 200);
    }
    // 6th signup hits the per-route cap.
    const blocked = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: fresh(), password: STRONG },
    });
    assert.equal(blocked.statusCode, 429);
    assert.equal(blocked.json().error, "rate_limited");
  } finally {
    await app.close();
  }
});

test("auth bucket is keyed by IP (x-forwarded-for) — different IPs don't share", async () => {
  // Cloudflare / Fly proxy puts the real client IP in
  // x-forwarded-for. Two attackers behind the same proxy should
  // each get their own 5-request bucket.
  const app = await buildAuthApp();
  try {
    // IP A burns through 5.
    for (let i = 0; i < AUTH_RATE_LIMIT.max; i += 1) {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { "x-forwarded-for": "203.0.113.1" },
        payload: { email: "x@y.example", password: "wrong-1234" },
      });
      assert.equal(res.statusCode, 401);
    }
    // IP A blocked.
    const blockedA = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "x-forwarded-for": "203.0.113.1" },
      payload: { email: "x@y.example", password: "wrong-1234" },
    });
    assert.equal(blockedA.statusCode, 429);

    // IP B fresh.
    const ipBfirst = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "x-forwarded-for": "198.51.100.7" },
      payload: { email: "x@y.example", password: "wrong-1234" },
    });
    assert.equal(ipBfirst.statusCode, 401);
  } finally {
    await app.close();
  }
});

// ── /api/orgs/:orgId/invites ─────────────────────────────────────────

test("invites: 10/hour/orgId cap — 11th invite returns 429", async () => {
  const { app, ownerCookie, orgId } = await buildInviteApp();
  try {
    // 10 distinct invitee emails so already_member doesn't muddy the
    // bucket count.
    for (let i = 0; i < INVITE_RATE_LIMIT.max; i += 1) {
      const res = await app.inject({
        method: "POST",
        url: `/api/orgs/${orgId}/invites`,
        headers: { cookie: ownerCookie },
        payload: { email: `invitee-${i}@rate-limit.example`, role: "member" },
      });
      // 201 on success; first invite to a fresh email always succeeds.
      assert.equal(res.statusCode, 201, `invite ${i + 1} should succeed`);
    }
    const eleventh = await app.inject({
      method: "POST",
      url: `/api/orgs/${orgId}/invites`,
      headers: { cookie: ownerCookie },
      payload: { email: "invitee-overflow@rate-limit.example", role: "member" },
    });
    assert.equal(eleventh.statusCode, 429);
    assert.equal(eleventh.json().error, "rate_limited");
    assert.ok(eleventh.headers["retry-after"]);
  } finally {
    await app.close();
  }
});

test("invites bucket is keyed by orgId — different orgs don't share", async () => {
  const a = await buildInviteApp();
  const b = await buildInviteApp();
  // Sanity: the apps are independent Fastify instances, so this
  // would pass even without per-orgId keying. The interesting case
  // — two orgs in the SAME app — needs both orgs accessible from
  // one Fastify; we approximate by running the two apps and
  // verifying both can hit the cap independently. The keyGenerator
  // unit-test contract is what guarantees orgs in a shared app are
  // isolated.
  try {
    for (let i = 0; i < INVITE_RATE_LIMIT.max; i += 1) {
      const ra = await a.app.inject({
        method: "POST",
        url: `/api/orgs/${a.orgId}/invites`,
        headers: { cookie: a.ownerCookie },
        payload: { email: `a-${i}@rl.example`, role: "member" },
      });
      assert.equal(ra.statusCode, 201);
    }
    // a is now at the cap — verify.
    const aBlocked = await a.app.inject({
      method: "POST",
      url: `/api/orgs/${a.orgId}/invites`,
      headers: { cookie: a.ownerCookie },
      payload: { email: "a-overflow@rl.example", role: "member" },
    });
    assert.equal(aBlocked.statusCode, 429);

    // b is independent — first invite succeeds.
    const bFirst = await b.app.inject({
      method: "POST",
      url: `/api/orgs/${b.orgId}/invites`,
      headers: { cookie: b.ownerCookie },
      payload: { email: "b-first@rl.example", role: "member" },
    });
    assert.equal(bFirst.statusCode, 201);
  } finally {
    await a.app.close();
    await b.app.close();
  }
});

// ── keyGenerator unit-tests ──────────────────────────────────────────

test("AUTH keyGenerator falls back to req.ip when no x-forwarded-for", () => {
  const fakeReq = { ip: "127.0.0.1", headers: {} } as unknown as Parameters<
    typeof AUTH_RATE_LIMIT.keyGenerator
  >[0];
  assert.equal(AUTH_RATE_LIMIT.keyGenerator(fakeReq), "auth:127.0.0.1");
});

test("AUTH keyGenerator picks the FIRST x-forwarded-for entry", () => {
  // Multi-hop proxy: x-forwarded-for becomes a comma-list. The
  // leftmost entry is the original client; everything after is
  // intermediary IPs. The bucket must key on the original.
  const fakeReq = {
    ip: "10.0.0.1",
    headers: { "x-forwarded-for": "203.0.113.1, 10.0.0.1" },
  } as unknown as Parameters<typeof AUTH_RATE_LIMIT.keyGenerator>[0];
  assert.equal(AUTH_RATE_LIMIT.keyGenerator(fakeReq), "auth:203.0.113.1");
});

test("INVITE keyGenerator reads orgId from URL params", () => {
  const fakeReq = {
    params: { orgId: "org_abc" },
    headers: {},
  } as unknown as Parameters<typeof INVITE_RATE_LIMIT.keyGenerator>[0];
  assert.equal(INVITE_RATE_LIMIT.keyGenerator(fakeReq), "invite:org_abc");
});

test("INVITE keyGenerator falls back to 'unknown' when orgId param is missing", () => {
  // Defensive: misregistered route shouldn't make every request
  // share the same bucket. "unknown" partitions defensively (every
  // misconfigured request lands in one bucket — visibly broken
  // rather than silently bypassing).
  const fakeReq = { params: {}, headers: {} } as unknown as Parameters<
    typeof INVITE_RATE_LIMIT.keyGenerator
  >[0];
  assert.equal(INVITE_RATE_LIMIT.keyGenerator(fakeReq), "invite:unknown");
});

test("MCP keyGenerator uses apiKeyCtx.apiKey.id when present (per-key bucket)", () => {
  // The hook is preHandler so by the time the rate-limit fires the
  // api-key middleware has populated apiKeyCtx. The bucket is keyed
  // by ApiKey.id — two different keys from the same IP get
  // INDEPENDENT buckets (the spec's "per-key" intent).
  const fakeReq = {
    apiKeyCtx: {
      apiKey: { id: "ak_alice", orgId: "org_a", name: "alice's", scopes: [] },
      org: { id: "org_a", slug: "alice", name: "Alice" },
    },
    headers: {},
    ip: "127.0.0.1",
  } as unknown as Parameters<typeof MCP_RATE_LIMIT.keyGenerator>[0];
  assert.equal(MCP_RATE_LIMIT.keyGenerator(fakeReq), "mcp:ak_alice");
});

test("MCP keyGenerator falls back to mcp:ip:<ip> when apiKeyCtx absent", () => {
  // Defense in depth: should never happen in production (api-key
  // middleware 401s first), but a misregistered route shouldn't
  // collapse every anonymous probe into the same bucket. The
  // distinct namespace (`mcp:ip:` vs `mcp:`) keeps anon probes
  // from sharing a bucket with authenticated calls from the same
  // proxied IP.
  const fakeReq = {
    headers: { "x-forwarded-for": "203.0.113.5" },
    ip: "127.0.0.1",
  } as unknown as Parameters<typeof MCP_RATE_LIMIT.keyGenerator>[0];
  assert.equal(MCP_RATE_LIMIT.keyGenerator(fakeReq), "mcp:ip:203.0.113.5");
});

test("MCP_RATE_LIMIT runs at preHandler (so apiKeyCtx is populated)", () => {
  // Without this hook override, the plugin's default `onRequest`
  // fires before the api-key middleware — every request would
  // collapse to an IP bucket regardless of which key authenticated.
  // This test pins the requirement so a future "tidy up the config"
  // PR doesn't accidentally drop the hook.
  assert.equal(MCP_RATE_LIMIT.hook, "preHandler");
});
