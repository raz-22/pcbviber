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
import { setupTestDatabase } from "@altium-mcp/db/test-utils";

let teardown: () => Promise<void>;
let prisma: import("@altium-mcp/db").PrismaClient;
let NexarServiceFactory: typeof import("./nexar-factory.js").NexarServiceFactory;
let encryptCredential: typeof import("@altium-mcp/db").encryptCredential;

before(async () => {
  ({ teardown } = await setupTestDatabase());
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");

  const db = await import("@altium-mcp/db");
  prisma = db.prisma;
  encryptCredential = db.encryptCredential;
  ({ NexarServiceFactory } = await import("./nexar-factory.js"));
});

after(async () => {
  if (prisma) await prisma.$disconnect();
  await teardown();
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
  const service1 = await factory.forWorkspace(ws.id, org.id);
  assert.ok(service1);
  // Cached on second call — same instance returned.
  const service2 = await factory.forWorkspace(ws.id, org.id);
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
    () => factory.forWorkspace(ws.id, org.id),
    /no Nexar credentials/i
  );
});

test("forWorkspace throws when the workspace doesn't exist", async () => {
  const factory = new NexarServiceFactory();
  // No org is set up in this test — the orgId arg is just the
  // tenant scope for the read; with a bogus workspaceId there are
  // no rows that could match either way.
  await assert.rejects(
    () => factory.forWorkspace("nonexistent-id", "org_placeholder"),
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
  const a = await factory.forWorkspace(ws.id, org.id);
  factory.invalidate(ws.id);
  const b = await factory.forWorkspace(ws.id, org.id);
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

  await factory.forWorkspace(ws1.id, org.id);
  await factory.forWorkspace(ws2.id, org.id);
  assert.equal(factory.__sizeForTests(), 2);
  await factory.forWorkspace(ws3.id, org.id);
  // ws1 evicted (oldest); ws2 + ws3 retained.
  assert.equal(factory.__sizeForTests(), 2);
  // Re-loading ws1 constructs a fresh service.
  const reloaded = await factory.forWorkspace(ws1.id, org.id);
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
  const a = await factory.forWorkspace(ws.id, org.id);
  await new Promise((r) => setTimeout(r, 25));
  const b = await factory.forWorkspace(ws.id, org.id);
  assert.notEqual(a, b, "expired cache entry should not be reused");
});

// ─── PR #8 review additions ─────────────────────────────────────────

test("invalidateAll() clears every cached service in one call", async () => {
  const factory = new NexarServiceFactory();
  const org = await prisma.organization.create({
    data: { name: "InvAll", slug: "invall-org" },
  });
  const w1 = await prisma.workspace.create({
    data: {
      orgId: org.id,
      nexarClientIdEnc: encryptCredential("c1"),
      nexarClientSecretEnc: encryptCredential("s1"),
    },
  });
  const w2 = await prisma.workspace.create({
    data: {
      orgId: org.id,
      nexarClientIdEnc: encryptCredential("c2"),
      nexarClientSecretEnc: encryptCredential("s2"),
    },
  });
  await factory.forWorkspace(w1.id, org.id);
  await factory.forWorkspace(w2.id, org.id);
  assert.equal(factory.__sizeForTests(), 2);

  factory.invalidateAll();
  assert.equal(factory.__sizeForTests(), 0);
});

test("LRU bumps recently-used entries so the OLDEST gets evicted", async () => {
  // PR 2.2's eviction test only confirmed "size capped at max"; this
  // pins the bump-on-hit behavior — without it, recently-used entries
  // could be evicted while stale ones survive.
  const factory = new NexarServiceFactory({ maxEntries: 2, ttlMs: 60_000 });
  const org = await prisma.organization.create({
    data: { name: "FIFO", slug: "fifo-bump-org" },
  });
  const a = await prisma.workspace.create({
    data: {
      orgId: org.id,
      nexarClientIdEnc: encryptCredential("a"),
      nexarClientSecretEnc: encryptCredential("a"),
    },
  });
  const b = await prisma.workspace.create({
    data: {
      orgId: org.id,
      nexarClientIdEnc: encryptCredential("b"),
      nexarClientSecretEnc: encryptCredential("b"),
    },
  });
  const c = await prisma.workspace.create({
    data: {
      orgId: org.id,
      nexarClientIdEnc: encryptCredential("c"),
      nexarClientSecretEnc: encryptCredential("c"),
    },
  });

  // Seed: cache holds [a, b] (a oldest).
  const aSvc1 = await factory.forWorkspace(a.id, org.id);
  await factory.forWorkspace(b.id, org.id);
  // Touch a → cache should now hold [b, a] (a most-recent).
  const aSvc2 = await factory.forWorkspace(a.id, org.id);
  assert.equal(aSvc1, aSvc2, "touching a should hit the cache, not reload");
  // Load c → b is now oldest and should be evicted, NOT a.
  await factory.forWorkspace(c.id, org.id);
  // Reloading a still hits the cache (proves it wasn't the one evicted).
  const aSvc3 = await factory.forWorkspace(a.id, org.id);
  assert.equal(aSvc1, aSvc3, "a was bumped on touch, must survive eviction");
});

test("forWorkspace surfaces a clear error when ciphertext is corrupt", async () => {
  const org = await prisma.organization.create({
    data: { name: "Corrupt", slug: "corrupt-cipher-org" },
  });
  const ws = await prisma.workspace.create({
    data: {
      orgId: org.id,
      // Hand-crafted "valid wire format prefix, garbage body" — passes
      // the parser shape check but fails GCM auth at decrypt.
      nexarClientIdEnc: "v1.bm9wZQ.bm9wZQ.bm9wZW5vcGVub3Bl",
      nexarClientSecretEnc: "v1.bm9wZQ.bm9wZQ.bm9wZW5vcGVub3Bl",
    },
  });

  const factory = new NexarServiceFactory();
  await assert.rejects(() => factory.forWorkspace(ws.id, org.id), /failed to decrypt/i);
});

test("forWorkspace cache: hit only when orgId matches the cached entry", async () => {
  // Defense in depth on the orgId param added in PR 7.6. The
  // primary tenant gate is `requireWorkspace` (RLS-bounded read),
  // so a buggy direct caller is the only way to reach forWorkspace
  // with a mismatched orgId. The cache must NOT silently return a
  // service for the wrong tenant.
  const orgA = await prisma.organization.create({
    data: { name: "A", slug: "cache-tenant-a" },
  });
  const orgB = await prisma.organization.create({
    data: { name: "B", slug: "cache-tenant-b" },
  });
  const ws = await prisma.workspace.create({
    data: {
      orgId: orgA.id,
      nexarClientIdEnc: encryptCredential("c"),
      nexarClientSecretEnc: encryptCredential("s"),
    },
  });

  const factory = new NexarServiceFactory();
  // Prime cache for orgA.
  const a = await factory.forWorkspace(ws.id, orgA.id);
  assert.equal(factory.__sizeForTests(), 1);

  // orgB asking for the same workspaceId — must NOT return the
  // cached service. The tenant-bounded read returns null (RLS
  // hides ws since ws.orgId === orgA.id), so we throw "not found".
  await assert.rejects(
    () => factory.forWorkspace(ws.id, orgB.id),
    /not found/i,
    "cache hit for wrong orgId must fall through to RLS-filtered read"
  );

  // orgA still gets the original cached service (the failed B
  // lookup didn't poison the entry).
  const a2 = await factory.forWorkspace(ws.id, orgA.id);
  assert.equal(a, a2, "orgA's cache hit should still return the original service");
});
