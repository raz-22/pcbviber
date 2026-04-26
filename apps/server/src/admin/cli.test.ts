/**
 * Admin CLI integration tests.
 *
 * Each subcommand exercises a real Prisma client against an isolated
 * test schema. We don't spawn a child process — we call `runCli`
 * directly so the assertions can read the structured output and
 * walk the DB for side-effect checks.
 *
 * The CLI is admin-only and runs as the table owner (RLS-bypassed),
 * which is exactly how setupTestDatabase wires the Prisma client by
 * default — no SET ROLE needed.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setupTestDatabase } from "@altium-mcp/db/test-utils";

let teardown: () => Promise<void>;
let runCli: (typeof import("./cli.js"))["runCli"];
let parseArgs: (typeof import("./cli.js"))["parseArgs"];
let prisma: import("@altium-mcp/db").PrismaClient;

let aliceUserId: string;
let bobUserId: string;
let aliceOrgId: string;
let aliceOrgSlug: string;
let bobOrgId: string;
let bobOrgSlug: string;

before(async () => {
  ({ teardown } = await setupTestDatabase());

  ({ runCli, parseArgs } = await import("./cli.js"));
  ({ prisma } = await import("@altium-mcp/db"));

  // Two orgs + two owners + one extra user (Carol) in alice's org as
  // a `member` so the promote-flow test has a realistic target.
  aliceUserId = (
    await prisma.user.create({
      data: { id: "u_alice", email: "alice@admin-cli.test" },
    })
  ).id;
  bobUserId = (
    await prisma.user.create({
      data: { id: "u_bob", email: "bob@admin-cli.test" },
    })
  ).id;
  await prisma.user.create({
    data: { id: "u_carol", email: "carol@admin-cli.test" },
  });

  const alice = await prisma.organization.create({
    data: { id: "o_alice", name: "Alice Co", slug: "alice-co" },
  });
  aliceOrgId = alice.id;
  aliceOrgSlug = alice.slug;
  const bob = await prisma.organization.create({
    data: { id: "o_bob", name: "Bob Co", slug: "bob-co" },
  });
  bobOrgId = bob.id;
  bobOrgSlug = bob.slug;

  await prisma.membership.createMany({
    data: [
      { orgId: aliceOrgId, userId: aliceUserId, role: "owner" },
      { orgId: aliceOrgId, userId: "u_carol", role: "member" },
      { orgId: bobOrgId, userId: bobUserId, role: "owner" },
    ],
  });
});

after(async () => {
  if (prisma) await prisma.$disconnect();
  await teardown();
});

// ─── parseArgs (pure unit) ──────────────────────────────────────────

test("parseArgs: --name value form", () => {
  const r = parseArgs(["orgs", "list", "--json"]);
  assert.deepEqual(r.positional, ["orgs", "list"]);
  assert.equal(r.flags.json, true);
});

test("parseArgs: --name=value form", () => {
  const r = parseArgs(["users", "list", "--email=alice"]);
  assert.deepEqual(r.positional, ["users", "list"]);
  assert.equal(r.flags.email, "alice");
});

test("parseArgs: separated --name value", () => {
  const r = parseArgs(["members", "add", "--org", "alice-co", "--email", "x@y.z"]);
  assert.deepEqual(r.positional, ["members", "add"]);
  assert.equal(r.flags.org, "alice-co");
  assert.equal(r.flags.email, "x@y.z");
});

// ─── --help / no args ──────────────────────────────────────────────

test("--help prints usage and exits 0", async () => {
  const { output, exitCode } = await runCli(["--help"]);
  assert.equal(exitCode, 0);
  assert.match(output, /Usage:/);
  assert.match(output, /orgs list/);
});

test("no args prints usage and exits 0", async () => {
  const { output, exitCode } = await runCli([]);
  assert.equal(exitCode, 0);
  assert.match(output, /Usage:/);
});

test("unknown subcommand exits non-zero", async () => {
  const { output, exitCode } = await runCli(["wat"]);
  assert.notEqual(exitCode, 0);
  assert.match(output, /unknown command/);
});

// ─── orgs list ──────────────────────────────────────────────────────

test("orgs list: text output includes both seeded orgs", async () => {
  const { output, exitCode } = await runCli(["orgs", "list"]);
  assert.equal(exitCode, 0);
  assert.match(output, new RegExp(aliceOrgSlug));
  assert.match(output, new RegExp(bobOrgSlug));
});

test("orgs list --json: returns parseable JSON with member counts", async () => {
  const { output, exitCode } = await runCli(["orgs", "list", "--json"]);
  assert.equal(exitCode, 0);
  const rows = JSON.parse(output) as Array<{
    slug: string;
    members: number;
  }>;
  const alice = rows.find((r) => r.slug === aliceOrgSlug)!;
  const bob = rows.find((r) => r.slug === bobOrgSlug)!;
  // alice has owner + carol; bob has just owner.
  assert.equal(alice.members, 2);
  assert.equal(bob.members, 1);
});

// ─── users list ─────────────────────────────────────────────────────

test("users list: shows all seeded users", async () => {
  const { output } = await runCli(["users", "list", "--json"]);
  const rows = JSON.parse(output) as Array<{ email: string }>;
  const emails = rows.map((r) => r.email);
  assert.ok(emails.includes("alice@admin-cli.test"));
  assert.ok(emails.includes("bob@admin-cli.test"));
  assert.ok(emails.includes("carol@admin-cli.test"));
});

test("users list --email <substr>: filters case-insensitively", async () => {
  const { output } = await runCli(["users", "list", "--email", "Alice", "--json"]);
  const rows = JSON.parse(output) as Array<{ email: string }>;
  // Should find alice, skip bob/carol.
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.email, "alice@admin-cli.test");
});

// ─── members add ────────────────────────────────────────────────────

test("members add --org <slug>: creates membership + writes audit row", async () => {
  // Add Bob (owner of his own org) as admin of Alice's org.
  const { output, exitCode } = await runCli([
    "members",
    "add",
    "--org",
    aliceOrgSlug,
    "--email",
    "bob@admin-cli.test",
    "--role",
    "admin",
  ]);
  assert.equal(exitCode, 0);
  assert.match(output, /added: bob@admin-cli\.test/);

  const m = await prisma.membership.findUnique({
    where: { orgId_userId: { orgId: aliceOrgId, userId: bobUserId } },
  });
  assert.equal(m?.role, "admin");

  const audit = await prisma.auditLog.findFirst({
    where: { orgId: aliceOrgId, action: "admin.member.add", target: bobUserId },
  });
  assert.ok(audit, "audit row should exist");
  assert.equal(audit?.actorUserId, null, "actor should be null (system)");
});

test("members add accepts org by id as well as slug", async () => {
  // Carol → owner of bob's org via id (rather than slug).
  const { exitCode } = await runCli([
    "members",
    "add",
    "--org",
    bobOrgId,
    "--email",
    "carol@admin-cli.test",
    "--role",
    "owner",
  ]);
  assert.equal(exitCode, 0);
  const m = await prisma.membership.findUnique({
    where: { orgId_userId: { orgId: bobOrgId, userId: "u_carol" } },
  });
  assert.equal(m?.role, "owner");
});

test("members add: rejects unknown role", async () => {
  const { output, exitCode } = await runCli([
    "members",
    "add",
    "--org",
    aliceOrgSlug,
    "--email",
    "alice@admin-cli.test",
    "--role",
    "tyrant",
  ]);
  assert.notEqual(exitCode, 0);
  assert.match(output, /invalid role/);
});

test("members add: rejects unknown org", async () => {
  const { output, exitCode } = await runCli([
    "members",
    "add",
    "--org",
    "nonexistent-org",
    "--email",
    "alice@admin-cli.test",
    "--role",
    "admin",
  ]);
  assert.notEqual(exitCode, 0);
  assert.match(output, /org not found/);
});

test("members add: rejects unknown user", async () => {
  const { output, exitCode } = await runCli([
    "members",
    "add",
    "--org",
    aliceOrgSlug,
    "--email",
    "noone@admin-cli.test",
    "--role",
    "member",
  ]);
  assert.notEqual(exitCode, 0);
  assert.match(output, /user not found/);
});

test("members add: refuses to overwrite an existing membership", async () => {
  // Alice is already owner of her own org.
  const { output, exitCode } = await runCli([
    "members",
    "add",
    "--org",
    aliceOrgSlug,
    "--email",
    "alice@admin-cli.test",
    "--role",
    "admin",
  ]);
  assert.notEqual(exitCode, 0);
  assert.match(output, /already a owner/);
  assert.match(output, /promote/);
});

// ─── members promote ────────────────────────────────────────────────

test("members promote: changes role + writes audit row", async () => {
  // Carol joined alice's org as `member` in setup. Promote to admin.
  const { output, exitCode } = await runCli([
    "members",
    "promote",
    "--org",
    aliceOrgSlug,
    "--email",
    "carol@admin-cli.test",
    "--role",
    "admin",
  ]);
  assert.equal(exitCode, 0);
  assert.match(output, /promoted: carol@admin-cli\.test/);
  assert.match(output, /member.*admin/);

  const m = await prisma.membership.findUnique({
    where: { orgId_userId: { orgId: aliceOrgId, userId: "u_carol" } },
  });
  assert.equal(m?.role, "admin");

  const audit = await prisma.auditLog.findFirst({
    where: {
      orgId: aliceOrgId,
      action: "admin.member.role_change",
      target: "u_carol",
    },
  });
  assert.ok(audit);
  assert.equal(audit?.actorUserId, null);
  assert.match(audit?.metadata ?? "", /"from":"member".*"to":"admin"/);
});

test("members promote: rejects when user isn't a member yet", async () => {
  const { output, exitCode } = await runCli([
    "members",
    "promote",
    "--org",
    bobOrgSlug,
    "--email",
    "alice@admin-cli.test",
    "--role",
    "admin",
  ]);
  assert.notEqual(exitCode, 0);
  assert.match(output, /not a member/);
});

test("members promote: rejects no-op (same role)", async () => {
  const { output, exitCode } = await runCli([
    "members",
    "promote",
    "--org",
    aliceOrgSlug,
    "--email",
    "alice@admin-cli.test", // already owner
    "--role",
    "owner",
  ]);
  assert.notEqual(exitCode, 0);
  assert.match(output, /no change/);
});

test("members promote: refuses to demote the last owner", async () => {
  // bob's org has exactly one owner (bob). Promoting carol to owner
  // earlier added a second owner — so for this test we use a fresh
  // single-owner org. Build it inline.
  const orgId = "o_solo";
  const orgSlug = "solo-co";
  await prisma.organization.create({
    data: { id: orgId, name: "Solo", slug: orgSlug },
  });
  await prisma.user.create({
    data: { id: "u_solo", email: "solo@admin-cli.test" },
  });
  await prisma.membership.create({
    data: { orgId, userId: "u_solo", role: "owner" },
  });

  const { output, exitCode } = await runCli([
    "members",
    "promote",
    "--org",
    orgSlug,
    "--email",
    "solo@admin-cli.test",
    "--role",
    "admin",
  ]);
  assert.notEqual(exitCode, 0);
  assert.match(output, /last owner/);

  // Confirm the role wasn't changed despite the failed call.
  const m = await prisma.membership.findUnique({
    where: { orgId_userId: { orgId, userId: "u_solo" } },
  });
  assert.equal(m?.role, "owner");
});

// ─── missing required flag ──────────────────────────────────────────

test("members add: missing --email exits non-zero with usage hint", async () => {
  const { output, exitCode } = await runCli([
    "members",
    "add",
    "--org",
    aliceOrgSlug,
    "--role",
    "admin",
  ]);
  assert.notEqual(exitCode, 0);
  assert.match(output, /missing required flag: --email/);
});
