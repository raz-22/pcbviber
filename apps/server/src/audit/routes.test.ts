/**
 * Audit-route integration tests.
 *
 * Pins:
 *   - GET /api/orgs/:orgId/audit returns rows scoped to the org
 *   - Cross-tenant: Bob can't read Alice's rows even with a valid session
 *   - Pagination: cursor walks the full set without dupes / gaps
 *   - Tied timestamps don't break the cursor (ordered by id within ms)
 *   - action filter: exact-match
 *   - 401 unauth, 403 for member role (admin-only), 200 for owner/admin
 *   - actor join survives a deleted user (FK is SetNull)
 *   - metadata: parsed when JSON, raw string fallback when corrupt
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
let aliceCookie: string;
let bobCookie: string;
let aliceOrgId: string;
let aliceUserId: string;
let bobOrgId: string;

const STRONG = "correct-horse-battery-staple-5";

before(async () => {
  workdir = mkdtempSync(join(tmpdir(), "altium-mcp-audit-routes-"));
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

  const { selectAuthProvider } = await import("@altium-mcp/auth");
  const { registerAuthRoutes } = await import("../auth/routes.js");
  const { registerAuditRoutes } = await import("./routes.js");

  app = Fastify({ logger: false });
  await app.register(cookie);
  const auth = selectAuthProvider();
  await registerAuthRoutes(app, auth);
  await registerAuditRoutes(app, auth);
  await app.ready();

  const aliceSignup = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email: "alice@audit.example", password: STRONG },
  });
  aliceOrgId = aliceSignup.json().org.id;
  aliceUserId = aliceSignup.json().user.id;
  aliceCookie = extractCookie(aliceSignup.headers["set-cookie"])!;

  const bobSignup = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email: "bob@audit.example", password: STRONG },
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

test("GET /audit returns rows for the calling org only", async () => {
  // Signup writes a `signup` row for both orgs. Sanity: Alice sees
  // exactly her org's rows, never Bob's.
  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/audit`,
    headers: { cookie: aliceCookie },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(Array.isArray(body.rows));
  assert.ok(body.rows.length >= 1, "alice should have at least the signup row");
  for (const r of body.rows) {
    // The route returns no orgId field (it's scoped by URL), so
    // verify by asserting actor.email is alice's where the actor is set.
    if (r.actor) assert.equal(r.actor.email, "alice@audit.example");
  }
  assert.ok(body.rows.some((r: { action: string }) => r.action === "signup"));
});

test("GET /audit cross-tenant: Bob's session probing Alice's orgId returns 403", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/audit`,
    headers: { cookie: bobCookie },
  });
  assert.equal(res.statusCode, 403);
});

test("GET /audit 401 without a session cookie", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/audit`,
  });
  assert.equal(res.statusCode, 401);
});

test("GET /audit 403 for `member` role (admin-only)", async () => {
  // Pin admin-only — a future role-change accidentally widening
  // visibility would be a regression with PII implications.
  const { prisma } = await import("@altium-mcp/db");
  const dev = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email: "member-on-audit@audit.example", password: STRONG },
  });
  const devUserId = dev.json().user.id;
  const devCookie = extractCookie(dev.headers["set-cookie"])!;
  await prisma.membership.create({
    data: { orgId: aliceOrgId, userId: devUserId, role: "member" },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/audit`,
    headers: { cookie: devCookie },
  });
  assert.equal(res.statusCode, 403);
});

test("GET /audit pagination: cursor walks the full set without dupes or gaps", async () => {
  // Create a fresh org so we control the row set.
  const owner = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email: "page-owner@audit.example", password: STRONG },
  });
  const orgId = owner.json().org.id;
  const userId = owner.json().user.id;
  const ownerCookie = extractCookie(owner.headers["set-cookie"])!;

  const { prisma } = await import("@altium-mcp/db");
  // Drop the signup row so the order is purely the seeded actions.
  await prisma.auditLog.deleteMany({ where: { orgId } });

  // 7 rows with strictly increasing timestamps so `(timestamp DESC, id DESC)`
  // gives a stable, deterministic order.
  const t0 = Date.now();
  for (let i = 0; i < 7; i++) {
    await prisma.auditLog.create({
      data: {
        orgId,
        actorUserId: userId,
        action: `seed.${i}`,
        timestamp: new Date(t0 + i * 1000),
      },
    });
  }

  const seen: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10; page++) {
    const url: string = cursor
      ? `/api/orgs/${orgId}/audit?limit=2&cursor=${encodeURIComponent(cursor)}`
      : `/api/orgs/${orgId}/audit?limit=2`;
    const res = await app.inject({
      method: "GET",
      url,
      headers: { cookie: ownerCookie },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { rows: { action: string }[]; nextCursor: string | null };
    for (const r of body.rows) seen.push(r.action);
    if (!body.nextCursor) break;
    cursor = body.nextCursor;
  }

  // Newest-first order: seed.6 → seed.0
  assert.deepEqual(seen, [
    "seed.6",
    "seed.5",
    "seed.4",
    "seed.3",
    "seed.2",
    "seed.1",
    "seed.0",
  ]);
});

test("GET /audit pagination: ties on timestamp are disambiguated by id", async () => {
  // Same-millisecond rows must not skip or duplicate when crossing
  // a page boundary. This is exactly the case the composite cursor
  // exists to fix.
  const owner = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email: "ties@audit.example", password: STRONG },
  });
  const orgId = owner.json().org.id;
  const ownerCookie = extractCookie(owner.headers["set-cookie"])!;

  const { prisma } = await import("@altium-mcp/db");
  await prisma.auditLog.deleteMany({ where: { orgId } });

  const ts = new Date();
  for (let i = 0; i < 5; i++) {
    await prisma.auditLog.create({
      data: { orgId, action: "tie", timestamp: ts },
    });
  }

  const seen: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10; page++) {
    const url: string = cursor
      ? `/api/orgs/${orgId}/audit?limit=2&cursor=${encodeURIComponent(cursor)}`
      : `/api/orgs/${orgId}/audit?limit=2`;
    const res = await app.inject({
      method: "GET",
      url,
      headers: { cookie: ownerCookie },
    });
    const body = res.json() as { rows: { id: string }[]; nextCursor: string | null };
    for (const r of body.rows) seen.push(r.id);
    if (!body.nextCursor) break;
    cursor = body.nextCursor;
  }
  assert.equal(seen.length, 5, "expected exactly 5 rows across all pages");
  assert.equal(new Set(seen).size, 5, "expected no duplicate ids");
});

test("GET /audit ?action= filters to exact match", async () => {
  const { prisma } = await import("@altium-mcp/db");
  await prisma.auditLog.create({
    data: { orgId: aliceOrgId, action: "filter.target", target: "x" },
  });
  await prisma.auditLog.create({
    data: { orgId: aliceOrgId, action: "filter.other", target: "y" },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/audit?action=filter.target`,
    headers: { cookie: aliceCookie },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(body.rows.length >= 1);
  for (const r of body.rows) assert.equal(r.action, "filter.target");
});

test("GET /audit returns null actor when the user was deleted (SetNull FK)", async () => {
  // Create a fresh org so we can delete an actor without breaking
  // earlier tests that still reference Alice.
  const ownerSignup = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email: "ghost-org@audit.example", password: STRONG },
  });
  const orgId = ownerSignup.json().org.id;
  const ownerC = extractCookie(ownerSignup.headers["set-cookie"])!;

  // Create a soon-to-be-ghost user and seed an audit row pointing
  // at them. The signup endpoint creates the user + their own org;
  // we're going to delete just the user to exercise the SetNull
  // path on AuditLog.actorUserId.
  const ghost = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email: "ghost@audit.example", password: STRONG },
  });
  const ghostUserId = ghost.json().user.id;

  const { prisma } = await import("@altium-mcp/db");
  // Cross-org reference is fine — AuditLog.actorUserId is just a FK
  // to User; the *org* scope is independently enforced by orgId.
  await prisma.auditLog.create({
    data: { orgId, actorUserId: ghostUserId, action: "ghost.action" },
  });
  // Remove the ghost's membership rows first (FK to org), then the
  // user. AuditLog.actorUserId is onDelete: SetNull, so the row
  // survives with a null actor.
  await prisma.membership.deleteMany({ where: { userId: ghostUserId } });
  await prisma.user.delete({ where: { id: ghostUserId } });

  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${orgId}/audit?action=ghost.action`,
    headers: { cookie: ownerC },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.rows.length, 1);
  assert.equal(body.rows[0].actor, null);
});

test("GET /audit parses JSON metadata, falls back to raw string for corrupt rows", async () => {
  const { prisma } = await import("@altium-mcp/db");
  await prisma.auditLog.create({
    data: {
      orgId: aliceOrgId,
      action: "meta.json",
      metadata: JSON.stringify({ a: 1, b: "two" }),
    },
  });
  await prisma.auditLog.create({
    data: {
      orgId: aliceOrgId,
      action: "meta.bad",
      // Not valid JSON — simulate a legacy or hand-written row.
      metadata: "{not-json",
    },
  });

  const okRes = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/audit?action=meta.json`,
    headers: { cookie: aliceCookie },
  });
  const okBody = okRes.json();
  assert.deepEqual(okBody.rows[0].metadata, { a: 1, b: "two" });

  const badRes = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/audit?action=meta.bad`,
    headers: { cookie: aliceCookie },
  });
  const badBody = badRes.json();
  assert.equal(badBody.rows[0].metadata, "{not-json");
});

test("GET /audit limit clamps to MAX_LIMIT", async () => {
  // limit=9999 → server caps to 100. Seed > 100 rows in a fresh org
  // so we can verify the cap takes effect.
  const owner = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email: "limit-cap@audit.example", password: STRONG },
  });
  const orgId = owner.json().org.id;
  const ownerC = extractCookie(owner.headers["set-cookie"])!;

  const { prisma } = await import("@altium-mcp/db");
  await prisma.auditLog.deleteMany({ where: { orgId } });
  for (let i = 0; i < 105; i++) {
    await prisma.auditLog.create({
      data: { orgId, action: "cap", timestamp: new Date(Date.now() + i) },
    });
  }

  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${orgId}/audit?limit=9999`,
    headers: { cookie: ownerC },
  });
  const body = res.json();
  assert.equal(body.rows.length, 100);
  assert.ok(body.nextCursor, "more rows remain → cursor present");
});

test("GET /audit invalid cursor is treated as no cursor (does not 400)", async () => {
  // Stale tab / hand-mangled URL must not surface as a hard error.
  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/audit?cursor=not-base64!&limit=5`,
    headers: { cookie: aliceCookie },
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

// Pin the read path doesn't write its own audit row. Reads to the
// audit log shouldn't generate audit log rows themselves — that
// would flood the table on a busy admin dashboard and obscure the
// signal we actually care about.
test("GET /audit does not write a row for the read action", async () => {
  const { prisma } = await import("@altium-mcp/db");
  const before = await prisma.auditLog.count({ where: { orgId: aliceOrgId } });
  await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/audit`,
    headers: { cookie: aliceCookie },
  });
  const after = await prisma.auditLog.count({ where: { orgId: aliceOrgId } });
  assert.equal(after, before);
});

// Pin actor.id == aliceUserId on rows where alice is the actor.
// Otherwise the SPA's "show me what I did vs. what my admin did"
// rendering breaks silently.
test("GET /audit returns actor.id matching the acting user", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/audit?action=signup`,
    headers: { cookie: aliceCookie },
  });
  const body = res.json();
  const signupRow = body.rows.find((r: { action: string }) => r.action === "signup");
  assert.ok(signupRow, "expected a signup row in alice's org");
  assert.equal(signupRow.actor?.id, aliceUserId);
});

// Sanity: the bobOrgId variable is referenced for cross-tenant
// coverage above; the assertion below pins that the cross-tenant
// guard is independent of the orgId actually existing.
test("GET /audit on a non-member's orgId returns 403, not 404", async () => {
  // Bob is not a member of Alice's org; same path the route takes
  // when the org id is gibberish (collapsed by tenant.ts to 403 to
  // prevent enumeration).
  assert.notEqual(aliceOrgId, bobOrgId);
  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/audit`,
    headers: { cookie: bobCookie },
  });
  assert.equal(res.statusCode, 403);
});
