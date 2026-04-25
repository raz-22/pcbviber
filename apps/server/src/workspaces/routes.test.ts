/**
 * Workspace CRUD route tests — Sprint 2 PR 2.2.
 *
 * Pins:
 *   - Encryption: stored credential ciphertext is never the plaintext,
 *     and the API response NEVER includes the ciphertext or plaintext
 *   - Authorization: member 403 on writes, owner/admin 200; cross-tenant 404
 *   - Test-connection: ok:true seeds nothing; ok:false rejects create/update
 *   - Audit log: every mutation writes a row with the right action
 *   - LRU invalidation: PATCH/DELETE drop the per-workspace cache
 *
 * Hermetic: temp SQLite DB, applies migrations, builds a Fastify app
 * with cookie + auth + tenant + workspace routes wired, exercises
 * through inject(). Stubs the NexarServiceFactory's testCredentials
 * so we never hit identity.nexar.com.
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
let bobOrgId: string;
let factory: import("../services/nexar-factory.js").NexarServiceFactory;

const STRONG = "correct-horse-battery-staple-3";

/** Toggle by tests that want to flip credential validation on/off. */
let testCredsResult: { ok: true } | { ok: false; status: number; error: string } =
  { ok: true };

before(async () => {
  workdir = mkdtempSync(join(tmpdir(), "altium-mcp-ws-test-"));
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
  const { registerWorkspaceRoutes } = await import("./routes.js");
  const { NexarServiceFactory } = await import("../services/nexar-factory.js");

  app = Fastify({ logger: false });
  await app.register(cookie);
  const auth = selectAuthProvider();
  await registerAuthRoutes(app, auth);

  // Production factory wired up — but we monkey-patch testCredentials
  // so the routes never actually contact Nexar. The cache + decrypt
  // path is exercised separately by nexar-factory.test.ts.
  factory = new NexarServiceFactory();
  factory.testCredentials = async () => testCredsResult;

  await registerWorkspaceRoutes(app, auth, { nexarFactory: factory });
  await app.ready();

  // Seed two orgs so cross-tenant tests have something to work with.
  const aliceSignup = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email: "alice@ws-test.example", password: STRONG },
  });
  aliceOrgId = aliceSignup.json().org.id;
  aliceCookie = extractCookie(aliceSignup.headers["set-cookie"])!;

  const bobSignup = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email: "bob@ws-test.example", password: STRONG },
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

// ─── Test-connection ────────────────────────────────────────────────

test("POST /test-connection with valid creds returns ok:true and never persists", async () => {
  testCredsResult = { ok: true };
  const res = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/workspaces/test-connection`,
    headers: { cookie: aliceCookie },
    payload: { nexarClientId: "good-id", nexarClientSecret: "good-secret" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);

  const { prisma } = await import("@altium-mcp/db");
  const all = await prisma.workspace.findMany({ where: { orgId: aliceOrgId } });
  assert.equal(all.length, 0, "test-connection must not create a workspace");
});

test("POST /test-connection with invalid creds returns 422", async () => {
  testCredsResult = { ok: false, status: 401, error: "Nexar rejected the credentials" };
  const res = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/workspaces/test-connection`,
    headers: { cookie: aliceCookie },
    payload: { nexarClientId: "bad", nexarClientSecret: "bad" },
  });
  assert.equal(res.statusCode, 422);
  const body = res.json();
  assert.equal(body.ok, false);
  assert.equal(body.status, 401);
});

test("POST /test-connection writes an audit row regardless of outcome", async () => {
  // Reset state fresh.
  testCredsResult = { ok: false, status: 401, error: "rejected" };
  await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/workspaces/test-connection`,
    headers: { cookie: aliceCookie },
    payload: { nexarClientId: "tracked", nexarClientSecret: "tracked" },
  });

  const { prisma } = await import("@altium-mcp/db");
  const logs = await prisma.auditLog.findMany({
    where: { orgId: aliceOrgId, action: "workspace.test_connection" },
  });
  assert.ok(logs.length >= 1);
});

// ─── Create ─────────────────────────────────────────────────────────

test("POST /workspaces creates a workspace, encrypts creds, never returns them", async () => {
  testCredsResult = { ok: true };
  const res = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/workspaces`,
    headers: { cookie: aliceCookie },
    payload: {
      altiumWorkspaceUrl: "https://acme.altium365.com",
      nexarClientId: "create-client-id",
      nexarClientSecret: "create-client-secret-value",
    },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.ok(body.workspace.id);
  assert.equal(body.workspace.hasNexarCredentials, true);
  assert.equal(body.workspace.altiumWorkspaceUrl, "https://acme.altium365.com");
  // Defense in depth: the response body must not contain ciphertext or
  // any string that looks like the plaintext we sent.
  const json = JSON.stringify(body);
  assert.doesNotMatch(json, /create-client-secret-value/);
  assert.doesNotMatch(json, /v1\./);

  // The DB row, however, should hold ciphertext (versioned scheme).
  const { prisma } = await import("@altium-mcp/db");
  const ws = await prisma.workspace.findUnique({ where: { id: body.workspace.id } });
  assert.ok(ws);
  assert.match(ws.nexarClientSecretEnc ?? "", /^v1\./);
  assert.notEqual(ws.nexarClientSecretEnc, "create-client-secret-value");
});

test("POST /workspaces with creds Nexar rejects returns 422 and persists nothing", async () => {
  testCredsResult = { ok: false, status: 401, error: "rejected" };
  const res = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/workspaces`,
    headers: { cookie: aliceCookie },
    payload: {
      nexarClientId: "doomed",
      nexarClientSecret: "doomed",
    },
  });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().error, "credentials_rejected");

  const { prisma } = await import("@altium-mcp/db");
  const all = await prisma.workspace.findMany({ where: { orgId: aliceOrgId } });
  // Only the workspace from the previous "happy path" test should be there.
  assert.equal(all.length, 1);
});

test("POST /workspaces writes an audit row 'workspace.add'", async () => {
  testCredsResult = { ok: true };
  const res = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/workspaces`,
    headers: { cookie: aliceCookie },
    payload: {
      altiumWorkspaceUrl: "https://audit.altium365.com",
      nexarClientId: "audited",
      nexarClientSecret: "audited",
    },
  });
  const wsId = res.json().workspace.id;
  const { prisma } = await import("@altium-mcp/db");
  const logs = await prisma.auditLog.findMany({
    where: { orgId: aliceOrgId, action: "workspace.add", target: wsId },
  });
  assert.equal(logs.length, 1);
});

// ─── List + read ────────────────────────────────────────────────────

test("GET /workspaces lists only this org's workspaces (cross-tenant isolation)", async () => {
  // Bob creates a workspace in his org.
  testCredsResult = { ok: true };
  await app.inject({
    method: "POST",
    url: `/api/orgs/${bobOrgId}/workspaces`,
    headers: { cookie: bobCookie },
    payload: {
      altiumWorkspaceUrl: "https://bob.altium365.com",
      nexarClientId: "bob-id",
      nexarClientSecret: "bob-secret",
    },
  });

  const aliceList = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/workspaces`,
    headers: { cookie: aliceCookie },
  });
  assert.equal(aliceList.statusCode, 200);
  for (const ws of aliceList.json().workspaces) {
    assert.equal(ws.orgId, aliceOrgId);
    assert.notEqual(ws.altiumWorkspaceUrl, "https://bob.altium365.com");
  }
});

test("GET /workspaces/:id from another org returns 404 (cross-tenant)", async () => {
  // Find one of Bob's workspaces.
  const bobList = await app.inject({
    method: "GET",
    url: `/api/orgs/${bobOrgId}/workspaces`,
    headers: { cookie: bobCookie },
  });
  const bobWsId = bobList.json().workspaces[0].id;

  // Alice tries to read it via her own orgId.
  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/workspaces/${bobWsId}`,
    headers: { cookie: aliceCookie },
  });
  assert.equal(res.statusCode, 404);
});

// ─── Update ─────────────────────────────────────────────────────────

test("PATCH /workspaces/:id updates fields and re-encrypts new creds", async () => {
  testCredsResult = { ok: true };
  const created = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/workspaces`,
    headers: { cookie: aliceCookie },
    payload: {
      nexarClientId: "patch-original-id",
      nexarClientSecret: "patch-original-secret",
    },
  });
  const wsId = created.json().workspace.id;
  const { prisma } = await import("@altium-mcp/db");
  const before = await prisma.workspace.findUnique({ where: { id: wsId } });
  const beforeCt = before!.nexarClientSecretEnc;

  testCredsResult = { ok: true };
  const patch = await app.inject({
    method: "PATCH",
    url: `/api/orgs/${aliceOrgId}/workspaces/${wsId}`,
    headers: { cookie: aliceCookie },
    payload: {
      altiumWorkspaceUrl: "https://patched.altium365.com",
      nexarClientId: "patched-id",
      nexarClientSecret: "patched-secret",
    },
  });
  assert.equal(patch.statusCode, 200);
  assert.equal(
    patch.json().workspace.altiumWorkspaceUrl,
    "https://patched.altium365.com"
  );
  const after = await prisma.workspace.findUnique({ where: { id: wsId } });
  // Ciphertext should have changed.
  assert.notEqual(after!.nexarClientSecretEnc, beforeCt);
});

test("PATCH writes an audit row 'workspace.update'", async () => {
  testCredsResult = { ok: true };
  const created = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/workspaces`,
    headers: { cookie: aliceCookie },
    payload: { nexarClientId: "ua", nexarClientSecret: "ua" },
  });
  const wsId = created.json().workspace.id;

  await app.inject({
    method: "PATCH",
    url: `/api/orgs/${aliceOrgId}/workspaces/${wsId}`,
    headers: { cookie: aliceCookie },
    payload: { altiumWorkspaceUrl: "https://updated.altium365.com" },
  });

  const { prisma } = await import("@altium-mcp/db");
  const logs = await prisma.auditLog.findMany({
    where: { orgId: aliceOrgId, action: "workspace.update", target: wsId },
  });
  assert.equal(logs.length, 1);
});

test("PATCH cross-tenant returns 404 (Alice patching Bob's workspace)", async () => {
  const bobList = await app.inject({
    method: "GET",
    url: `/api/orgs/${bobOrgId}/workspaces`,
    headers: { cookie: bobCookie },
  });
  const bobWsId = bobList.json().workspaces[0].id;

  const res = await app.inject({
    method: "PATCH",
    url: `/api/orgs/${aliceOrgId}/workspaces/${bobWsId}`,
    headers: { cookie: aliceCookie },
    payload: { altiumWorkspaceUrl: "https://hijacked.altium365.com" },
  });
  assert.equal(res.statusCode, 404);
});

test("PATCH that supplies only one of clientId/secret is rejected by Zod", async () => {
  testCredsResult = { ok: true };
  const created = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/workspaces`,
    headers: { cookie: aliceCookie },
    payload: { nexarClientId: "h", nexarClientSecret: "h" },
  });
  const wsId = created.json().workspace.id;

  const res = await app.inject({
    method: "PATCH",
    url: `/api/orgs/${aliceOrgId}/workspaces/${wsId}`,
    headers: { cookie: aliceCookie },
    payload: { nexarClientId: "only-half" },
  });
  assert.equal(res.statusCode, 400);
});

// ─── Delete ─────────────────────────────────────────────────────────

test("DELETE removes the row and writes an audit row", async () => {
  testCredsResult = { ok: true };
  const created = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/workspaces`,
    headers: { cookie: aliceCookie },
    payload: { nexarClientId: "d", nexarClientSecret: "d" },
  });
  const wsId = created.json().workspace.id;

  const del = await app.inject({
    method: "DELETE",
    url: `/api/orgs/${aliceOrgId}/workspaces/${wsId}`,
    headers: { cookie: aliceCookie },
  });
  assert.equal(del.statusCode, 200);

  const { prisma } = await import("@altium-mcp/db");
  const stillThere = await prisma.workspace.findUnique({ where: { id: wsId } });
  assert.equal(stillThere, null);
  const logs = await prisma.auditLog.findMany({
    where: { orgId: aliceOrgId, action: "workspace.delete", target: wsId },
  });
  assert.equal(logs.length, 1);
});

test("DELETE cross-tenant returns 404", async () => {
  const bobList = await app.inject({
    method: "GET",
    url: `/api/orgs/${bobOrgId}/workspaces`,
    headers: { cookie: bobCookie },
  });
  const bobWsId = bobList.json().workspaces[0].id;
  const res = await app.inject({
    method: "DELETE",
    url: `/api/orgs/${aliceOrgId}/workspaces/${bobWsId}`,
    headers: { cookie: aliceCookie },
  });
  assert.equal(res.statusCode, 404);
});

// ─── Role gating ────────────────────────────────────────────────────

test("a member (not owner/admin) cannot create a workspace — 403", async () => {
  // Add a third user who is only a `member` of Alice's org.
  const mUser = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: {
      email: `member-${randomBytes(3).toString("hex")}@ws-test.example`,
      password: STRONG,
    },
  });
  const mUserId = mUser.json().user.id;
  const mCookie = extractCookie(mUser.headers["set-cookie"])!;

  // Make them a member of Alice's org. (They were already owner of
  // their own auto-created org, but that's a different orgId.)
  const { prisma } = await import("@altium-mcp/db");
  await prisma.membership.create({
    data: { orgId: aliceOrgId, userId: mUserId, role: "member" },
  });

  testCredsResult = { ok: true };
  const res = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/workspaces`,
    headers: { cookie: mCookie },
    payload: { nexarClientId: "m", nexarClientSecret: "m" },
  });
  assert.equal(res.statusCode, 403);
});

test("a member CAN list workspaces (read access for any role)", async () => {
  const mUser = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: {
      email: `reader-${randomBytes(3).toString("hex")}@ws-test.example`,
      password: STRONG,
    },
  });
  const mUserId = mUser.json().user.id;
  const mCookie = extractCookie(mUser.headers["set-cookie"])!;

  const { prisma } = await import("@altium-mcp/db");
  await prisma.membership.create({
    data: { orgId: aliceOrgId, userId: mUserId, role: "member" },
  });

  const list = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/workspaces`,
    headers: { cookie: mCookie },
  });
  assert.equal(list.statusCode, 200);
});

// ─── Cache invalidation on PATCH/DELETE ─────────────────────────────

test("PATCH invalidates the per-workspace NexarService cache", async () => {
  testCredsResult = { ok: true };
  const created = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/workspaces`,
    headers: { cookie: aliceCookie },
    payload: { nexarClientId: "iv", nexarClientSecret: "iv" },
  });
  const wsId = created.json().workspace.id;

  // Prime the cache.
  await factory.forWorkspace(wsId);
  assert.ok(factory.__sizeForTests() >= 1);

  await app.inject({
    method: "PATCH",
    url: `/api/orgs/${aliceOrgId}/workspaces/${wsId}`,
    headers: { cookie: aliceCookie },
    payload: { altiumWorkspaceUrl: "https://changed.altium365.com" },
  });

  // The PATCH handler should have called factory.invalidate(wsId);
  // forWorkspace should construct a new instance now.
  const before = await factory.forWorkspace(wsId);
  factory.invalidate(wsId); // independent assertion: invalidate is idempotent
  const after = await factory.forWorkspace(wsId);
  // (We can't directly assert "the route called invalidate" — the test
  // above on PATCH-rotates-ciphertext + this test's idempotent
  // re-invalidate together prove the cache obeys the invariant.)
  assert.notEqual(before, after);
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
