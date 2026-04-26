/**
 * Row-Level Security integration tests.
 *
 * The application-layer `requireOrgRole` middleware is the primary
 * tenant gate; RLS is defense in depth. These tests prove the RLS
 * policies actually bind when the connection runs as `altium_app`
 * (the runtime role with no BYPASSRLS).
 *
 * Strategy: open a direct pg.Client to the test schema, `SET ROLE
 * altium_app` to drop the table-owner exemption, then run cross-
 * tenant probes with different `app.current_org_id` settings.
 *
 * The schema-test-utils helper applies migrations as the table
 * owner, so most other tests (which use the global Prisma client)
 * are RLS-bypassed and don't need to change. This file is the only
 * one that exercises RLS directly.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setupTestDatabase } from "@altium-mcp/db/test-utils";
import pg from "pg";

let teardown: () => Promise<void>;
let connectionString: string;
let schema: string;

const ALICE = "org_alice_rls";
const BOB = "org_bob_rls";

before(async () => {
  const setup = await setupTestDatabase();
  teardown = setup.teardown;
  connectionString = setup.databaseUrl;
  schema = setup.schema;

  // Seed two orgs + memberships + workspaces as table owner so the
  // probes below have something to filter against. We do this on a
  // separate admin client (no SET ROLE) so the inserts bypass RLS.
  const admin = new pg.Client({ connectionString });
  await admin.connect();
  try {
    await admin.query(`SET search_path TO "${schema}"`);
    await admin.query(
      'INSERT INTO "Organization" (id, name, slug) VALUES ($1,$2,$3)',
      [ALICE, "Alice Co", `${schema}-alice`]
    );
    await admin.query(
      'INSERT INTO "Organization" (id, name, slug) VALUES ($1,$2,$3)',
      [BOB, "Bob Co", `${schema}-bob`]
    );
    await admin.query(
      'INSERT INTO "User" (id, email) VALUES ($1, $2), ($3, $4)',
      ["user_alice", `alice-${schema}@x.test`, "user_bob", `bob-${schema}@x.test`]
    );
    await admin.query(
      'INSERT INTO "Membership" (id, "orgId", "userId", role) VALUES ($1,$2,$3,$4)',
      ["m_alice", ALICE, "user_alice", "owner"]
    );
    await admin.query(
      'INSERT INTO "Membership" (id, "orgId", "userId", role) VALUES ($1,$2,$3,$4)',
      ["m_bob", BOB, "user_bob", "owner"]
    );
    await admin.query(
      'INSERT INTO "Workspace" (id, "orgId") VALUES ($1, $2), ($3, $4)',
      ["ws_alice", ALICE, "ws_bob", BOB]
    );
  } finally {
    await admin.end();
  }
});

after(async () => {
  await teardown();
});

/**
 * Helper: open a connection, switch to altium_app, run `fn` against
 * the test schema, and clean up. Each test gets a fresh connection
 * so a residual SET ROLE / set_config from one test doesn't leak
 * into the next.
 */
async function asAppRole(
  fn: (c: pg.Client) => Promise<void>
): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(`SET search_path TO "${schema}"`);
    await client.query("SET ROLE altium_app");
    await fn(client);
  } finally {
    await client.end();
  }
}

test("RLS: altium_app sees only the org matching app.current_org_id (Organization)", async () => {
  await asAppRole(async (c) => {
    await c.query("SELECT set_config('app.current_org_id', $1, false)", [ALICE]);
    const r = await c.query('SELECT id FROM "Organization" ORDER BY id');
    assert.deepEqual(
      r.rows.map((row) => row.id),
      [ALICE]
    );
  });
});

test("RLS: altium_app sees only that org's Memberships", async () => {
  await asAppRole(async (c) => {
    await c.query("SELECT set_config('app.current_org_id', $1, false)", [ALICE]);
    const r = await c.query('SELECT "orgId" FROM "Membership"');
    assert.deepEqual(
      r.rows.map((row) => row.orgId),
      [ALICE]
    );
  });
});

test("RLS: altium_app sees only that org's Workspaces", async () => {
  await asAppRole(async (c) => {
    await c.query("SELECT set_config('app.current_org_id', $1, false)", [BOB]);
    const r = await c.query('SELECT "orgId" FROM "Workspace"');
    assert.deepEqual(
      r.rows.map((row) => row.orgId),
      [BOB]
    );
  });
});

test("RLS: with no app.current_org_id set, every tenant table returns 0 rows", async () => {
  // Fail-closed default: missing setting → current_setting(...,true)
  // returns NULL → policy comparison is NULL → falsy → all rows
  // hidden. A handler that forgets withTenantTx() returns empty
  // results, not someone else's data.
  await asAppRole(async (c) => {
    // Don't call set_config. Run a query directly.
    const orgs = await c.query('SELECT id FROM "Organization"');
    const memberships = await c.query('SELECT id FROM "Membership"');
    const workspaces = await c.query('SELECT id FROM "Workspace"');
    assert.equal(orgs.rows.length, 0);
    assert.equal(memberships.rows.length, 0);
    assert.equal(workspaces.rows.length, 0);
  });
});

test("RLS: WITH CHECK blocks INSERT into a different org", async () => {
  // A handler bug that constructs an INSERT with the wrong orgId
  // (e.g. forgetting to use req.ctx.org.id) gets rejected by RLS
  // instead of writing into the wrong tenant.
  await asAppRole(async (c) => {
    await c.query("SELECT set_config('app.current_org_id', $1, false)", [ALICE]);
    await assert.rejects(
      c.query(
        'INSERT INTO "Workspace" (id, "orgId") VALUES ($1, $2)',
        ["ws_smuggled", BOB] // tenant = bob, but ctx = alice
      ),
      /violates row-level security/i
    );
  });
});

test("RLS: switching app.current_org_id within a connection swaps visibility", async () => {
  // Prove that the setting is per-call, not stuck once set. This is
  // essential for connection pooling — a pooled connection might be
  // reused across requests; each request's set_config must override
  // the previous one.
  await asAppRole(async (c) => {
    await c.query("SELECT set_config('app.current_org_id', $1, false)", [ALICE]);
    let r = await c.query('SELECT id FROM "Organization"');
    assert.deepEqual(
      r.rows.map((x) => x.id),
      [ALICE]
    );

    await c.query("SELECT set_config('app.current_org_id', $1, false)", [BOB]);
    r = await c.query('SELECT id FROM "Organization"');
    assert.deepEqual(
      r.rows.map((x) => x.id),
      [BOB]
    );
  });
});

test("admin (table owner) bypasses RLS — fixtures keep working", async () => {
  // Sanity that the test-utils admin path still sees everything.
  // If this test ever fails, all the other tests are unintentionally
  // RLS-enforced + their before() hooks are silently inserting rows
  // that they can't read back.
  const admin = new pg.Client({ connectionString });
  await admin.connect();
  try {
    await admin.query(`SET search_path TO "${schema}"`);
    const r = await admin.query('SELECT id FROM "Organization" ORDER BY id');
    assert.deepEqual(
      r.rows.map((x) => x.id).sort(),
      [ALICE, BOB].sort()
    );
  } finally {
    await admin.end();
  }
});

test("withTenantTx: query inside the helper sees only the scoped org", async () => {
  // Exercises the production code path end-to-end: the helper opens
  // a Prisma transaction, drops to altium_app, sets the org id, runs
  // a Prisma model query. The result must be filtered by RLS.
  const { withTenantTx } = await import("./tenant-tx.js");
  const { prisma } = await import("@altium-mcp/db");

  const alice = await withTenantTx(ALICE, async (tx) => {
    return await tx.organization.findMany({ select: { id: true } });
  });
  assert.deepEqual(
    alice.map((o) => o.id),
    [ALICE]
  );

  const bob = await withTenantTx(BOB, async (tx) => {
    return await tx.workspace.findMany({ select: { orgId: true } });
  });
  assert.deepEqual(
    bob.map((w) => w.orgId),
    [BOB]
  );

  // After the helper returns, role + setting are gone — a follow-up
  // raw query on the global client runs as admin again, bypassing RLS.
  const all = await prisma.organization.findMany({ select: { id: true } });
  assert.ok(
    all.length >= 2,
    "post-withTenantTx: admin connection should see all rows"
  );
  await prisma.$disconnect();
});
