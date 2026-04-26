/**
 * Schema-level integration tests.
 *
 * Exercises the live Prisma client against a fresh Postgres schema
 * to verify:
 *   - tenant creation + membership + workspace with encrypted creds
 *   - FK cascades (deleting an org removes its memberships/workspaces)
 *   - unique / idempotency constraints actually fire
 *   - audit log + usage event round-trips
 *
 * Requires TEST_DATABASE_URL pointing at a Postgres instance the
 * caller has CREATE/DROP SCHEMA privileges on (Neon free tier, a
 * docker-compose `postgres` service, etc.). See repo docker-compose.yml.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import {
  encryptCredential,
  decryptCredential,
  __resetEncryptionCacheForTests,
} from "./encryption.js";
import { setupTestDatabase } from "./test-utils.js";

// Lazy imports so we can set env vars BEFORE @prisma/client initializes.
let prisma: import("@prisma/client").PrismaClient;
let teardown: () => Promise<void>;

before(async () => {
  ({ teardown } = await setupTestDatabase());

  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  __resetEncryptionCacheForTests();

  // Dynamic import must happen AFTER env is set, so PrismaClient reads
  // the right DATABASE_URL.
  const mod = await import("./index.js");
  prisma = mod.prisma;
});

after(async () => {
  if (prisma) await prisma.$disconnect();
  await teardown();
});

test("creates Organization + User + Membership", async () => {
  const org = await prisma.organization.create({
    data: { name: "Acme Hardware", slug: "acme-hardware" },
  });
  const user = await prisma.user.create({
    data: { email: "owner@acme.test" },
  });
  const membership = await prisma.membership.create({
    data: { orgId: org.id, userId: user.id, role: "owner" },
  });

  assert.equal(membership.role, "owner");
  assert.equal(membership.orgId, org.id);
  assert.equal(membership.userId, user.id);
});

test("Organization.slug unique constraint fires", async () => {
  await prisma.organization.create({
    data: { name: "First", slug: "unique-slug-a" },
  });
  await assert.rejects(
    () =>
      prisma.organization.create({
        data: { name: "Second", slug: "unique-slug-a" },
      }),
    /Unique constraint failed/i
  );
});

test("Membership (orgId,userId) composite unique fires", async () => {
  const org = await prisma.organization.create({
    data: { name: "OrgX", slug: "orgx" },
  });
  const user = await prisma.user.create({ data: { email: "x@acme.test" } });
  await prisma.membership.create({
    data: { orgId: org.id, userId: user.id, role: "member" },
  });
  await assert.rejects(
    () =>
      prisma.membership.create({
        data: { orgId: org.id, userId: user.id, role: "admin" },
      }),
    /Unique constraint failed/i
  );
});

test("Workspace stores encrypted Nexar creds; decryption round-trips", async () => {
  const org = await prisma.organization.create({
    data: { name: "OrgWS", slug: "org-ws" },
  });
  const secret = "nexar-sekrit-secret-value-xyz-123";
  const ws = await prisma.workspace.create({
    data: {
      orgId: org.id,
      altiumWorkspaceUrl: "https://acme.altium365.com",
      nexarClientIdEnc: encryptCredential("client-id-abc"),
      nexarClientSecretEnc: encryptCredential(secret),
    },
  });

  // The ciphertext on disk is NOT the plaintext.
  assert.notEqual(ws.nexarClientSecretEnc, secret);
  assert.match(ws.nexarClientSecretEnc ?? "", /^v1\./);

  // Re-read and decrypt.
  const reloaded = await prisma.workspace.findUnique({ where: { id: ws.id } });
  assert.ok(reloaded);
  assert.equal(decryptCredential(reloaded.nexarClientSecretEnc!), secret);
  assert.equal(decryptCredential(reloaded.nexarClientIdEnc!), "client-id-abc");
});

test("deleting an Organization cascades to Memberships + Workspaces", async () => {
  const org = await prisma.organization.create({
    data: { name: "Doomed", slug: "doomed" },
  });
  const user = await prisma.user.create({ data: { email: "doomed@acme.test" } });
  await prisma.membership.create({
    data: { orgId: org.id, userId: user.id, role: "owner" },
  });
  await prisma.workspace.create({
    data: { orgId: org.id, altiumWorkspaceUrl: "https://doomed.altium365.com" },
  });

  await prisma.organization.delete({ where: { id: org.id } });

  const ms = await prisma.membership.findMany({ where: { orgId: org.id } });
  const wss = await prisma.workspace.findMany({ where: { orgId: org.id } });
  assert.equal(ms.length, 0);
  assert.equal(wss.length, 0);

  // The User survives — we only cascade from Org side.
  const surviving = await prisma.user.findUnique({ where: { id: user.id } });
  assert.ok(surviving);
});

test("UsageEvent.idempotencyKey unique constraint fires", async () => {
  const org = await prisma.organization.create({
    data: { name: "OrgU", slug: "org-u" },
  });
  const key = "idem-" + randomBytes(6).toString("hex");
  await prisma.usageEvent.create({
    data: {
      orgId: org.id,
      tool: "search_parts",
      metric: "bom_lookup",
      idempotencyKey: key,
    },
  });
  await assert.rejects(
    () =>
      prisma.usageEvent.create({
        data: {
          orgId: org.id,
          tool: "search_parts",
          metric: "bom_lookup",
          idempotencyKey: key,
        },
      }),
    /Unique constraint failed/i
  );
});

test("AuditLog writes & reads with optional actor", async () => {
  const org = await prisma.organization.create({
    data: { name: "OrgA", slug: "org-a" },
  });
  const user = await prisma.user.create({ data: { email: "actor@acme.test" } });

  await prisma.auditLog.create({
    data: {
      orgId: org.id,
      actorUserId: user.id,
      action: "workspace.add",
      target: "ws_abc",
      ip: "127.0.0.1",
      userAgent: "node-test",
      metadata: JSON.stringify({ altiumWorkspaceUrl: "https://x.altium365.com" }),
    },
  });
  // Anonymous (system) event — no actor.
  await prisma.auditLog.create({
    data: { orgId: org.id, action: "system.reconcile" },
  });

  const logs = await prisma.auditLog.findMany({
    where: { orgId: org.id },
    orderBy: { timestamp: "asc" },
  });
  assert.equal(logs.length, 2);
  assert.equal(logs[0].actorUserId, user.id);
  assert.equal(logs[1].actorUserId, null);
});

test("deleting an actor User sets AuditLog.actorUserId to null (preserve history)", async () => {
  const org = await prisma.organization.create({
    data: { name: "OrgH", slug: "org-h" },
  });
  const user = await prisma.user.create({ data: { email: "temp@acme.test" } });
  await prisma.auditLog.create({
    data: { orgId: org.id, actorUserId: user.id, action: "login" },
  });

  await prisma.user.delete({ where: { id: user.id } });

  const logs = await prisma.auditLog.findMany({ where: { orgId: org.id } });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].actorUserId, null); // SetNull kept the row
});

// ─── Review additions — PR #3 second-pass coverage ────────────────────

test("User.email unique constraint fires", async () => {
  await prisma.user.create({ data: { email: "unique-email@acme.test" } });
  await assert.rejects(
    () => prisma.user.create({ data: { email: "unique-email@acme.test" } }),
    /Unique constraint failed/i
  );
});

test("User.workosUserId unique constraint fires (when non-null)", async () => {
  await prisma.user.create({
    data: { email: "ws1@acme.test", workosUserId: "workos_user_xyz" },
  });
  await assert.rejects(
    () =>
      prisma.user.create({
        data: { email: "ws2@acme.test", workosUserId: "workos_user_xyz" },
      }),
    /Unique constraint failed/i
  );
});

test("multiple users with null workosUserId are allowed", async () => {
  // Two Local users should not conflict on workosUserId = NULL.
  await prisma.user.create({ data: { email: "null-ws-1@acme.test" } });
  await prisma.user.create({ data: { email: "null-ws-2@acme.test" } });
  // If this throws, the migration wrongly treated NULL as a value.
});

test("deleting a User cascades to their Memberships", async () => {
  const org = await prisma.organization.create({
    data: { name: "OrgCascadeU", slug: "org-cascade-u" },
  });
  const user = await prisma.user.create({ data: { email: "cu@acme.test" } });
  await prisma.membership.create({
    data: { orgId: org.id, userId: user.id, role: "member" },
  });

  await prisma.user.delete({ where: { id: user.id } });

  const memberships = await prisma.membership.findMany({
    where: { userId: user.id },
  });
  assert.equal(memberships.length, 0);
  // Org itself survives.
  const stillThere = await prisma.organization.findUnique({ where: { id: org.id } });
  assert.ok(stillThere);
});

test("deleting a User sets UsageEvent.userId to null (preserve usage history)", async () => {
  const org = await prisma.organization.create({
    data: { name: "OrgUsage", slug: "org-usage" },
  });
  const user = await prisma.user.create({ data: { email: "ue@acme.test" } });
  await prisma.usageEvent.create({
    data: {
      orgId: org.id,
      userId: user.id,
      tool: "search_parts",
      metric: "bom_lookup",
      idempotencyKey: "ue-" + randomBytes(6).toString("hex"),
    },
  });

  await prisma.user.delete({ where: { id: user.id } });

  const events = await prisma.usageEvent.findMany({ where: { orgId: org.id } });
  assert.equal(events.length, 1);
  assert.equal(events[0].userId, null); // SetNull preserved the billing row
});

test("ApiKey.hashedKey unique constraint fires", async () => {
  const org = await prisma.organization.create({
    data: { name: "OrgApi", slug: "org-api" },
  });
  await prisma.apiKey.create({
    data: {
      orgId: org.id,
      name: "primary",
      hashedKey: "sha256_deadbeef",
      scopes: "tools:read",
    },
  });
  await assert.rejects(
    () =>
      prisma.apiKey.create({
        data: {
          orgId: org.id,
          name: "conflict",
          hashedKey: "sha256_deadbeef",
          scopes: "tools:read",
        },
      }),
    /Unique constraint failed/i
  );
});

test("Invite.token unique constraint fires", async () => {
  const org = await prisma.organization.create({
    data: { name: "OrgInv", slug: "org-inv" },
  });
  const token = "inv-" + randomBytes(16).toString("hex");
  const expiresAt = new Date(Date.now() + 24 * 3600 * 1000);
  await prisma.invite.create({
    data: { orgId: org.id, email: "a@acme.test", role: "member", token, expiresAt },
  });
  await assert.rejects(
    () =>
      prisma.invite.create({
        data: { orgId: org.id, email: "b@acme.test", role: "member", token, expiresAt },
      }),
    /Unique constraint failed/i
  );
});

test("Subscription requires an existing Plan (FK)", async () => {
  const org = await prisma.organization.create({
    data: { name: "OrgSub", slug: "org-sub" },
  });
  await assert.rejects(
    () =>
      prisma.subscription.create({
        data: {
          orgId: org.id,
          planId: "does-not-exist",
          status: "trialing",
        },
      }),
    /Foreign key constraint (failed|violated)/i
  );
});

test("Subscription succeeds when the Plan exists", async () => {
  const plan = await prisma.plan.create({
    data: { name: "team-test", seatLimit: 20 },
  });
  const org = await prisma.organization.create({
    data: { name: "OrgSub2", slug: "org-sub-2" },
  });
  const sub = await prisma.subscription.create({
    data: { orgId: org.id, planId: plan.id, status: "trialing", seats: 3 },
  });
  assert.equal(sub.status, "trialing");
  assert.equal(sub.seats, 3);
});

test("Workspace encrypted-only fields can be null (workspace without creds yet)", async () => {
  const org = await prisma.organization.create({
    data: { name: "OrgNoCreds", slug: "org-no-creds" },
  });
  const ws = await prisma.workspace.create({
    data: { orgId: org.id, altiumWorkspaceUrl: "https://placeholder.altium365.com" },
  });
  assert.equal(ws.nexarClientIdEnc, null);
  assert.equal(ws.nexarClientSecretEnc, null);
  assert.equal(ws.altiumRestTokenEnc, null);
});
