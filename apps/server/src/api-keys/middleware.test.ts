/**
 * Bearer-token middleware tests. Mounts the middleware on a noop
 * `/protected` route that just echoes `req.apiKeyCtx`, so we can
 * exercise every accept/reject path without spinning the real MCP
 * transport.
 *
 * Pins:
 *   - Every reject path returns 401 with WWW-Authenticate: Bearer
 *   - The 401 body is `{ error: "not_authenticated" }` (after the
 *     installApiKeyErrorHandler reshape) — same shape the SPA's
 *     ApiError mapper expects from any other auth failure
 *   - Revoked / expired / unknown keys ALL look identical to the
 *     caller; the audit-log + lastUsedAt are the only places that
 *     differentiate them
 *   - Successful auth populates req.apiKeyCtx with id, orgId, name,
 *     parsed scopes, and the org metadata
 *   - lastUsedAt is bumped on success; not bumped on failure
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify, { type FastifyInstance } from "fastify";

let app: FastifyInstance;
let workdir: string;
let aliceOrgId: string;
let bobOrgId: string;
let validPlaintext: string;
let validKeyId: string;
let revokedPlaintext: string;
let expiredPlaintext: string;

before(async () => {
  workdir = mkdtempSync(join(tmpdir(), "altium-mcp-apikey-mw-test-"));
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

  const { prisma } = await import("@altium-mcp/db");
  const { generateApiKey } = await import("./keys.js");
  const { makeRequireApiKey, installApiKeyErrorHandler } = await import(
    "./middleware.js"
  );

  // Seed two orgs so we can confirm the resolved ctx points at the
  // RIGHT org, not just the first one in the table.
  const aliceOrg = await prisma.organization.create({
    data: { name: "Alice's Org", slug: `alice-${randomBytes(3).toString("hex")}` },
  });
  aliceOrgId = aliceOrg.id;
  const bobOrg = await prisma.organization.create({
    data: { name: "Bob's Org", slug: `bob-${randomBytes(3).toString("hex")}` },
  });
  bobOrgId = bobOrg.id;

  // Active key.
  const valid = generateApiKey();
  validPlaintext = valid.plaintext;
  const validRow = await prisma.apiKey.create({
    data: {
      orgId: aliceOrgId,
      name: "active-key",
      hashedKey: valid.hash,
      scopes: "mcp:tools mcp:read",
    },
  });
  validKeyId = validRow.id;

  // Revoked key.
  const revoked = generateApiKey();
  revokedPlaintext = revoked.plaintext;
  await prisma.apiKey.create({
    data: {
      orgId: aliceOrgId,
      name: "revoked-key",
      hashedKey: revoked.hash,
      scopes: "",
      revokedAt: new Date(),
    },
  });

  // Expired key (expiresAt 1s in the past).
  const expired = generateApiKey();
  expiredPlaintext = expired.plaintext;
  await prisma.apiKey.create({
    data: {
      orgId: aliceOrgId,
      name: "expired-key",
      hashedKey: expired.hash,
      scopes: "",
      expiresAt: new Date(Date.now() - 1000),
    },
  });

  app = Fastify({ logger: false });
  const requireApiKey = makeRequireApiKey();
  app.post(
    "/protected",
    { preHandler: requireApiKey },
    async (req) => req.apiKeyCtx
  );
  installApiKeyErrorHandler(app);
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

// ─── Reject paths ────────────────────────────────────────────────────

test("missing Authorization header → 401", async () => {
  const res = await app.inject({ method: "POST", url: "/protected" });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "not_authenticated");
  // WWW-Authenticate is essential — clients use it to know they
  // should retry with a bearer token instead of giving up.
  assert.match(
    res.headers["www-authenticate"] as string,
    /^Bearer\b/
  );
});

test("wrong auth scheme (Basic) → 401", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/protected",
    headers: { authorization: "Basic dXNlcjpwYXNz" },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "not_authenticated");
});

test("empty bearer body → 401", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/protected",
    headers: { authorization: "Bearer " },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "not_authenticated");
});

test("unknown plaintext → 401 (response is identical to a revoked key)", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/protected",
    headers: { authorization: `Bearer pcb_${randomBytes(32).toString("base64url")}` },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "not_authenticated");
});

test("revoked key → 401 (no leakage that the key 'used to be valid')", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/protected",
    headers: { authorization: `Bearer ${revokedPlaintext}` },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "not_authenticated");
});

test("expired key → 401 (same shape as revoked + unknown)", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/protected",
    headers: { authorization: `Bearer ${expiredPlaintext}` },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "not_authenticated");
});

// ─── Accept path ─────────────────────────────────────────────────────

test("valid bearer token → 200 with apiKeyCtx populated", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/protected",
    headers: { authorization: `Bearer ${validPlaintext}` },
  });
  assert.equal(res.statusCode, 200);
  const ctx = res.json();
  assert.equal(ctx.apiKey.id, validKeyId);
  assert.equal(ctx.apiKey.orgId, aliceOrgId);
  assert.equal(ctx.apiKey.name, "active-key");
  // Scopes parsed from the space-joined column.
  assert.deepEqual(ctx.apiKey.scopes, ["mcp:tools", "mcp:read"]);
  // Org metadata resolved.
  assert.equal(ctx.org.id, aliceOrgId);
  assert.equal(ctx.org.name, "Alice's Org");
  assert.notEqual(ctx.org.id, bobOrgId);
});

test("auth-scheme is case-insensitive (RFC 7235): 'bearer' lowercase works", async () => {
  // Per RFC 7235 §2.1 the auth-scheme is case-insensitive. Most
  // real clients send capitalized "Bearer", but a non-conforming
  // client sending "bearer" or "BEARER" should still authenticate.
  const lower = await app.inject({
    method: "POST",
    url: "/protected",
    headers: { authorization: `bearer ${validPlaintext}` },
  });
  assert.equal(lower.statusCode, 200);
  assert.equal(lower.json().apiKey.id, validKeyId);

  const upper = await app.inject({
    method: "POST",
    url: "/protected",
    headers: { authorization: `BEARER ${validPlaintext}` },
  });
  assert.equal(upper.statusCode, 200);
  assert.equal(upper.json().apiKey.id, validKeyId);
});

test("a key with empty scopes resolves to an empty array (no spurious entries)", async () => {
  // The "revoked-key" we seeded has scopes: "". Its hash table entry
  // exists; we'd hit it ONLY if we reverse the revocation. So instead
  // create a fresh key with empty scopes and verify the parse.
  const { prisma } = await import("@altium-mcp/db");
  const { generateApiKey } = await import("./keys.js");
  const k = generateApiKey();
  await prisma.apiKey.create({
    data: {
      orgId: aliceOrgId,
      name: "no-scopes",
      hashedKey: k.hash,
      scopes: "",
    },
  });
  const res = await app.inject({
    method: "POST",
    url: "/protected",
    headers: { authorization: `Bearer ${k.plaintext}` },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().apiKey.scopes, []);
});

// ─── Side effects ────────────────────────────────────────────────────

test("successful auth bumps lastUsedAt", async () => {
  const { prisma } = await import("@altium-mcp/db");
  const before = await prisma.apiKey.findUnique({
    where: { id: validKeyId },
  });
  // Call /protected, then re-read.
  await app.inject({
    method: "POST",
    url: "/protected",
    headers: { authorization: `Bearer ${validPlaintext}` },
  });
  // The bump is fire-and-forget; give it a moment to settle.
  await new Promise((r) => setTimeout(r, 50));
  const after = await prisma.apiKey.findUnique({
    where: { id: validKeyId },
  });
  assert.ok(after?.lastUsedAt, "lastUsedAt was not set");
  if (before?.lastUsedAt && after?.lastUsedAt) {
    assert.ok(
      after.lastUsedAt.getTime() >= before.lastUsedAt.getTime(),
      "lastUsedAt did not advance"
    );
  }
});

test("failed auth does NOT bump lastUsedAt on the matched-but-rejected key", async () => {
  // Use the revoked key. Its DB row was created with lastUsedAt=null;
  // a failed auth attempt must keep it null.
  const { prisma } = await import("@altium-mcp/db");
  const before = await prisma.apiKey.findFirst({
    where: { name: "revoked-key" },
  });
  assert.ok(before);
  await app.inject({
    method: "POST",
    url: "/protected",
    headers: { authorization: `Bearer ${revokedPlaintext}` },
  });
  await new Promise((r) => setTimeout(r, 50));
  const after = await prisma.apiKey.findUnique({
    where: { id: before.id },
  });
  assert.equal(
    after?.lastUsedAt,
    before.lastUsedAt,
    "revoked key's lastUsedAt advanced — middleware updated it before rejecting"
  );
});

test("the SAME hashed key does NOT collide across different bearer values", async () => {
  // Two different plaintexts must produce different hashes — pin
  // that the middleware isn't accidentally accepting any token whose
  // hash starts with the right bytes (e.g., a substring match).
  const { generateApiKey } = await import("./keys.js");
  const k1 = generateApiKey();
  const k2 = generateApiKey();
  // Only k1 is actually in the DB.
  const { prisma } = await import("@altium-mcp/db");
  await prisma.apiKey.create({
    data: {
      orgId: bobOrgId,
      name: "collision-test",
      hashedKey: k1.hash,
      scopes: "",
    },
  });
  // k2 should be rejected even though it has the same prefix shape.
  const res = await app.inject({
    method: "POST",
    url: "/protected",
    headers: { authorization: `Bearer ${k2.plaintext}` },
  });
  assert.equal(res.statusCode, 401);
});
