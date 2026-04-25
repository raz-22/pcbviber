/**
 * NexarServiceFactory unit tests.
 *
 * Covers the pure cache + decrypt path. The HTTP testCredentials path
 * is covered by mocking globalThis.fetch — we never want unit tests to
 * actually contact identity.nexar.com.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let workdir: string;
let prisma: import("@altium-mcp/db").PrismaClient;
let NexarServiceFactory: typeof import("./nexar-factory.js").NexarServiceFactory;
let encryptCredential: typeof import("@altium-mcp/db").encryptCredential;

before(async () => {
  workdir = mkdtempSync(join(tmpdir(), "altium-mcp-factory-test-"));
  const dbPath = join(workdir, "test.db").replace(/\\/g, "/");
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");

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

  const db = await import("@altium-mcp/db");
  prisma = db.prisma;
  encryptCredential = db.encryptCredential;
  ({ NexarServiceFactory } = await import("./nexar-factory.js"));
});

after(async () => {
  if (prisma) await prisma.$disconnect();
  try {
    rmSync(workdir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// ─── testCredentials (mocks fetch) ──────────────────────────────────

const realFetch = globalThis.fetch;

test("testCredentials returns ok:true on Nexar 200", async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ access_token: "x", expires_in: 3600 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  const factory = new NexarServiceFactory();
  const out = await factory.testCredentials("client-id", "client-secret");
  assert.equal(out.ok, true);

  globalThis.fetch = realFetch;
});

test("testCredentials returns ok:false on Nexar 401", async () => {
  globalThis.fetch = (async () =>
    new Response("invalid_client", { status: 401 })) as typeof fetch;

  const factory = new NexarServiceFactory();
  const out = await factory.testCredentials("bad", "creds");
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.status, 401);
    assert.match(out.error, /rejected/i);
  }

  globalThis.fetch = realFetch;
});

test("testCredentials surfaces network errors as ok:false (no throw)", async () => {
  globalThis.fetch = (async () => {
    throw new TypeError("network down");
  }) as typeof fetch;

  const factory = new NexarServiceFactory();
  const out = await factory.testCredentials("c", "s");
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.status, 0);
    assert.match(out.error, /network/i);
  }

  globalThis.fetch = realFetch;
});

test("testCredentials with empty creds rejects without hitting the network", async () => {
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response("", { status: 200 });
  }) as typeof fetch;

  const factory = new NexarServiceFactory();
  const out = await factory.testCredentials("", "secret");
  assert.equal(out.ok, false);
  assert.equal(fetchCalled, false, "must not contact Nexar with empty client id");

  globalThis.fetch = realFetch;
});

// ─── forWorkspace + caching ─────────────────────────────────────────

test("forWorkspace decrypts stored creds and instantiates NexarService", async () => {
  const org = await prisma.organization.create({
    data: { name: "FactoryOrg", slug: "factory-org-1" },
  });
  const ws = await prisma.workspace.create({
    data: {
      orgId: org.id,
      nexarClientIdEnc: encryptCredential("real-client-id"),
      nexarClientSecretEnc: encryptCredential("real-client-secret"),
    },
  });

  const factory = new NexarServiceFactory();
  const service1 = await factory.forWorkspace(ws.id);
  assert.ok(service1);
  // Cached on second call — same instance returned.
  const service2 = await factory.forWorkspace(ws.id);
  assert.equal(service1, service2);
});

test("forWorkspace throws when the workspace has no creds", async () => {
  const org = await prisma.organization.create({
    data: { name: "NoCredsOrg", slug: "no-creds-org" },
  });
  const ws = await prisma.workspace.create({
    data: { orgId: org.id, altiumWorkspaceUrl: "https://x.altium365.com" },
  });

  const factory = new NexarServiceFactory();
  await assert.rejects(
    () => factory.forWorkspace(ws.id),
    /no Nexar credentials/i
  );
});

test("forWorkspace throws when the workspace doesn't exist", async () => {
  const factory = new NexarServiceFactory();
  await assert.rejects(
    () => factory.forWorkspace("nonexistent-id"),
    /not found/i
  );
});

test("invalidate(workspaceId) drops the cached service", async () => {
  const org = await prisma.organization.create({
    data: { name: "InvOrg", slug: "inv-org" },
  });
  const ws = await prisma.workspace.create({
    data: {
      orgId: org.id,
      nexarClientIdEnc: encryptCredential("c"),
      nexarClientSecretEnc: encryptCredential("s"),
    },
  });

  const factory = new NexarServiceFactory();
  const a = await factory.forWorkspace(ws.id);
  factory.invalidate(ws.id);
  const b = await factory.forWorkspace(ws.id);
  // Cache was cleared, so a fresh NexarService was constructed.
  assert.notEqual(a, b);
});

test("LRU eviction kicks in when maxEntries is exceeded", async () => {
  const factory = new NexarServiceFactory({ maxEntries: 2, ttlMs: 60_000 });
  const org = await prisma.organization.create({
    data: { name: "LRU", slug: "lru-org" },
  });
  const ws1 = await prisma.workspace.create({
    data: {
      orgId: org.id,
      nexarClientIdEnc: encryptCredential("c1"),
      nexarClientSecretEnc: encryptCredential("s1"),
    },
  });
  const ws2 = await prisma.workspace.create({
    data: {
      orgId: org.id,
      nexarClientIdEnc: encryptCredential("c2"),
      nexarClientSecretEnc: encryptCredential("s2"),
    },
  });
  const ws3 = await prisma.workspace.create({
    data: {
      orgId: org.id,
      nexarClientIdEnc: encryptCredential("c3"),
      nexarClientSecretEnc: encryptCredential("s3"),
    },
  });

  await factory.forWorkspace(ws1.id);
  await factory.forWorkspace(ws2.id);
  assert.equal(factory.__sizeForTests(), 2);
  await factory.forWorkspace(ws3.id);
  // ws1 evicted (oldest); ws2 + ws3 retained.
  assert.equal(factory.__sizeForTests(), 2);
  // Re-loading ws1 constructs a fresh service.
  const reloaded = await factory.forWorkspace(ws1.id);
  assert.ok(reloaded);
});

test("expired entries are reloaded on next forWorkspace call", async () => {
  const factory = new NexarServiceFactory({ ttlMs: 10 }); // 10 ms
  const org = await prisma.organization.create({
    data: { name: "TTL", slug: "ttl-org" },
  });
  const ws = await prisma.workspace.create({
    data: {
      orgId: org.id,
      nexarClientIdEnc: encryptCredential("c"),
      nexarClientSecretEnc: encryptCredential("s"),
    },
  });
  const a = await factory.forWorkspace(ws.id);
  await new Promise((r) => setTimeout(r, 25));
  const b = await factory.forWorkspace(ws.id);
  assert.notEqual(a, b, "expired cache entry should not be reused");
});
