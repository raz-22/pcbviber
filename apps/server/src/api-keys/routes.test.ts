/**
 * API key route tests.
 *
 * Pins:
 *   - Plaintext returned EXACTLY ONCE on POST; never echoed in
 *     listings, never written to the audit log
 *   - Server stores sha256(plaintext), not plaintext
 *   - Authorization: owner/admin only on every endpoint;
 *     cross-tenant probes 403/404
 *   - Soft-revoke: ApiKey.revokedAt set, row stays for history
 *
 * Hermetic: temp SQLite + prisma migrate deploy + in-process Fastify
 * with auth + members + api-keys routes wired.
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

const STRONG = "correct-horse-battery-staple-3";

before(async () => {
  workdir = mkdtempSync(join(tmpdir(), "altium-mcp-apikey-test-"));
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
  const { registerApiKeyRoutes } = await import("./routes.js");

  app = Fastify({ logger: false });
  await app.register(cookie);
  const auth = selectAuthProvider();
  await registerAuthRoutes(app, auth);
  await registerApiKeyRoutes(app, auth);
  await app.ready();

  const aliceSignup = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email: "alice@apikey-test.example", password: STRONG },
  });
  aliceOrgId = aliceSignup.json().org.id;
  aliceCookie = extractCookie(aliceSignup.headers["set-cookie"])!;

  const bobSignup = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email: "bob@apikey-test.example", password: STRONG },
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

// ═══ POST /api-keys ═════════════════════════════════════════════════════

test("POST /api-keys returns plaintext exactly once + metadata; stores only the hash", async () => {
  const res = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/api-keys`,
    headers: { cookie: aliceCookie },
    payload: { name: "production server" },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.ok(body.apiKey.id);
  assert.equal(body.apiKey.name, "production server");
  assert.deepEqual(body.apiKey.scopes, []);
  assert.equal(body.apiKey.revokedAt, null);
  assert.ok(typeof body.key === "string");
  assert.match(body.key, /^pcb_[A-Za-z0-9_-]+$/);
  // Preview is the prefix + first 8 chars; the SPA renders this
  // alongside "pcb_••••••••" once the user navigates away.
  assert.ok(typeof body.apiKey.preview === "string");
  assert.ok(body.key.startsWith(body.apiKey.preview));

  // The DB stores the hash, NEVER the plaintext.
  const { prisma } = await import("@altium-mcp/db");
  const stored = await prisma.apiKey.findUnique({
    where: { id: body.apiKey.id },
  });
  assert.ok(stored);
  assert.notEqual(stored.hashedKey, body.key, "DB stores hash, not plaintext");
  assert.match(stored.hashedKey, /^[a-f0-9]{64}$/);
});

test("POST /api-keys: same plaintext hashes deterministically (matches stored)", async () => {
  // The bearer-token verification path will hash the incoming token
  // and look up by hashedKey. Pin that the create-time hash matches
  // what hashApiKey() would produce on the same plaintext — break
  // this and authentication stops resolving.
  const { hashApiKey } = await import("./keys.js");
  const res = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/api-keys`,
    headers: { cookie: aliceCookie },
    payload: { name: "verify-roundtrip" },
  });
  const body = res.json();
  const { prisma } = await import("@altium-mcp/db");
  const stored = await prisma.apiKey.findUnique({
    where: { id: body.apiKey.id },
  });
  assert.equal(stored?.hashedKey, hashApiKey(body.key));
});

test("POST /api-keys writes audit row WITHOUT the plaintext or hash", async () => {
  const res = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/api-keys`,
    headers: { cookie: aliceCookie },
    payload: {
      name: "audited-key",
      scopes: ["mcp:tools", "mcp:read"],
    },
  });
  const keyId = res.json().apiKey.id;
  const plaintext = res.json().key;
  const { prisma } = await import("@altium-mcp/db");
  const log = await prisma.auditLog.findFirst({
    where: { orgId: aliceOrgId, action: "api_key.create", target: keyId },
  });
  assert.ok(log);
  // Defense in depth: no part of the metadata column can contain the
  // plaintext or any plausible hash. We check both.
  const meta = log.metadata ?? "";
  assert.ok(!meta.includes(plaintext), "plaintext leaked into audit metadata");
  assert.doesNotMatch(meta, /\b[a-f0-9]{64}\b/, "hash-shaped string in metadata");
  // Non-secret metadata IS expected.
  assert.match(meta, /"name":"audited-key"/);
  assert.match(meta, /"scopes":\["mcp:tools","mcp:read"\]/);
});

test("POST /api-keys with whitespace inside a scope → 400 (round-trip safety)", async () => {
  // Scopes are stored space-joined. A scope containing a space would
  // split apart on read (`["foo bar"]` round-trips as `["foo","bar"]`),
  // silently corrupting the key's grant. Reject it at the boundary
  // so the corruption can't reach the DB.
  const res = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/api-keys`,
    headers: { cookie: aliceCookie },
    payload: { name: "ws-scope", scopes: ["mcp:tools", "foo bar"] },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "invalid_input");
});

test("POST /api-keys with empty name → 400 invalid_input", async () => {
  const res = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/api-keys`,
    headers: { cookie: aliceCookie },
    payload: { name: "" },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "invalid_input");
});

test("POST /api-keys with past expiresAt → 400 invalid_input", async () => {
  const res = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/api-keys`,
    headers: { cookie: aliceCookie },
    payload: {
      name: "past-expiry",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "invalid_input");
});

test("POST /api-keys with future expiresAt → 201 + stored expiresAt", async () => {
  const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // +30d
  const res = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/api-keys`,
    headers: { cookie: aliceCookie },
    payload: { name: "future-expiry", expiresAt: future.toISOString() },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  // Expiry is round-tripped to ISO string.
  assert.equal(body.apiKey.expiresAt, future.toISOString());
});

test("POST /api-keys: cross-tenant — Bob can't create a key in Alice's org", async () => {
  const res = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/api-keys`,
    headers: { cookie: bobCookie },
    payload: { name: "intruder" },
  });
  assert.equal(res.statusCode, 403);
});

test("POST /api-keys: a member (not owner/admin) returns 403 forbidden", async () => {
  const { prisma } = await import("@altium-mcp/db");
  const m = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: {
      email: `apikey-member-${randomBytes(3).toString("hex")}@apikey-test.example`,
      password: STRONG,
    },
  });
  const mUserId = m.json().user.id;
  const mCookie = extractCookie(m.headers["set-cookie"])!;
  await prisma.membership.create({
    data: { orgId: aliceOrgId, userId: mUserId, role: "member" },
  });

  const res = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/api-keys`,
    headers: { cookie: mCookie },
    payload: { name: "member-attempt" },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, "forbidden");
});

// ═══ GET /api-keys ══════════════════════════════════════════════════════

test("GET /api-keys returns all keys for the org; never includes plaintext or hash", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/api-keys`,
    headers: { cookie: aliceCookie },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(Array.isArray(body.apiKeys));
  // We've created several keys above; assert none of the rows include
  // a `key`, `hashedKey`, or anything matching the plaintext shape.
  const json = JSON.stringify(body);
  assert.doesNotMatch(json, /"key":"pcb_/, "list response must not include plaintext");
  assert.doesNotMatch(json, /"hashedKey"/, "list must not include hashedKey");
  for (const k of body.apiKeys) {
    assert.ok(k.id);
    assert.ok(typeof k.name === "string");
    // preview is omitted on listings (server can't reproduce it).
    assert.equal(k.preview, undefined);
  }
});

test("GET /api-keys cross-tenant: Bob's list does NOT include Alice's keys", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${bobOrgId}/api-keys`,
    headers: { cookie: bobCookie },
  });
  assert.equal(res.statusCode, 200);
  // Bob hasn't created any keys yet — and certainly shouldn't see Alice's.
  assert.equal(res.json().apiKeys.length, 0);
});

test("GET /api-keys: Bob 403s on Alice's org", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/api-keys`,
    headers: { cookie: bobCookie },
  });
  assert.equal(res.statusCode, 403);
});

test("GET /api-keys: a member 403s (not owner/admin)", async () => {
  const { prisma } = await import("@altium-mcp/db");
  const m = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: {
      email: `lister-${randomBytes(3).toString("hex")}@apikey-test.example`,
      password: STRONG,
    },
  });
  const mUserId = m.json().user.id;
  const mCookie = extractCookie(m.headers["set-cookie"])!;
  await prisma.membership.create({
    data: { orgId: aliceOrgId, userId: mUserId, role: "member" },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/api-keys`,
    headers: { cookie: mCookie },
  });
  assert.equal(res.statusCode, 403);
});

// ═══ DELETE /api-keys/:keyId ════════════════════════════════════════════

test("DELETE /api-keys/:id revokes (sets revokedAt) and keeps the row", async () => {
  const created = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/api-keys`,
    headers: { cookie: aliceCookie },
    payload: { name: "torevoke" },
  });
  const keyId = created.json().apiKey.id;

  const res = await app.inject({
    method: "DELETE",
    url: `/api/orgs/${aliceOrgId}/api-keys/${keyId}`,
    headers: { cookie: aliceCookie },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });

  // Row stays, revokedAt populated.
  const { prisma } = await import("@altium-mcp/db");
  const row = await prisma.apiKey.findUnique({ where: { id: keyId } });
  assert.ok(row);
  assert.ok(row.revokedAt);
});

test("After revoke, GET /api-keys still includes the key with revokedAt populated", async () => {
  const created = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/api-keys`,
    headers: { cookie: aliceCookie },
    payload: { name: "history-row" },
  });
  const keyId = created.json().apiKey.id;
  await app.inject({
    method: "DELETE",
    url: `/api/orgs/${aliceOrgId}/api-keys/${keyId}`,
    headers: { cookie: aliceCookie },
  });
  const list = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/api-keys`,
    headers: { cookie: aliceCookie },
  });
  const row = list.json().apiKeys.find((k: { id: string }) => k.id === keyId);
  assert.ok(row, "revoked row dropped from listing");
  assert.ok(row.revokedAt);
});

test("DELETE /api-keys: 404 for an unknown key id", async () => {
  const res = await app.inject({
    method: "DELETE",
    url: `/api/orgs/${aliceOrgId}/api-keys/cknotreal000000000000000xx`,
    headers: { cookie: aliceCookie },
  });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, "not_found");
});

test("DELETE /api-keys cross-tenant: a key owned by Bob's org returns 404 from Alice's path", async () => {
  // Spin up a key in Bob's org via direct prisma to avoid coupling
  // this test to Bob having owner privilege through the route.
  const { prisma } = await import("@altium-mcp/db");
  const bobsKey = await prisma.apiKey.create({
    data: {
      orgId: bobOrgId,
      name: "bobs-secret",
      hashedKey: randomBytes(32).toString("hex"),
      scopes: "",
    },
  });
  // Alice tries to revoke it via her org's URL — must be 404, not
  // 200 + revoke. Defense against id enumeration across tenants.
  const res = await app.inject({
    method: "DELETE",
    url: `/api/orgs/${aliceOrgId}/api-keys/${bobsKey.id}`,
    headers: { cookie: aliceCookie },
  });
  assert.equal(res.statusCode, 404);
  // And Bob's key must still be live (revokedAt unchanged).
  const after = await prisma.apiKey.findUnique({ where: { id: bobsKey.id } });
  assert.equal(after?.revokedAt, null);
});

test("DELETE /api-keys returns 409 when the key is already revoked", async () => {
  const created = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/api-keys`,
    headers: { cookie: aliceCookie },
    payload: { name: "double-revoke" },
  });
  const keyId = created.json().apiKey.id;
  const first = await app.inject({
    method: "DELETE",
    url: `/api/orgs/${aliceOrgId}/api-keys/${keyId}`,
    headers: { cookie: aliceCookie },
  });
  assert.equal(first.statusCode, 200);
  const second = await app.inject({
    method: "DELETE",
    url: `/api/orgs/${aliceOrgId}/api-keys/${keyId}`,
    headers: { cookie: aliceCookie },
  });
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().error, "api_key_already_revoked");
});

test("DELETE /api-keys writes an audit row with the key's name (not the hash)", async () => {
  const created = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/api-keys`,
    headers: { cookie: aliceCookie },
    payload: { name: "audit-revoke" },
  });
  const keyId = created.json().apiKey.id;
  await app.inject({
    method: "DELETE",
    url: `/api/orgs/${aliceOrgId}/api-keys/${keyId}`,
    headers: { cookie: aliceCookie },
  });
  const { prisma } = await import("@altium-mcp/db");
  const log = await prisma.auditLog.findFirst({
    where: { orgId: aliceOrgId, action: "api_key.revoke", target: keyId },
  });
  assert.ok(log);
  assert.match(log.metadata ?? "", /"name":"audit-revoke"/);
  // No hash-shaped string.
  assert.doesNotMatch(log.metadata ?? "", /\b[a-f0-9]{64}\b/);
});

test("DELETE /api-keys: a member (not owner/admin) returns 403", async () => {
  const created = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/api-keys`,
    headers: { cookie: aliceCookie },
    payload: { name: "for-member-403" },
  });
  const keyId = created.json().apiKey.id;
  const { prisma } = await import("@altium-mcp/db");
  const m = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: {
      email: `delete-member-${randomBytes(3).toString("hex")}@apikey-test.example`,
      password: STRONG,
    },
  });
  const mUserId = m.json().user.id;
  const mCookie = extractCookie(m.headers["set-cookie"])!;
  await prisma.membership.create({
    data: { orgId: aliceOrgId, userId: mUserId, role: "member" },
  });
  const res = await app.inject({
    method: "DELETE",
    url: `/api/orgs/${aliceOrgId}/api-keys/${keyId}`,
    headers: { cookie: mCookie },
  });
  assert.equal(res.statusCode, 403);
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
