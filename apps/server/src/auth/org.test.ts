/**
 * Pure-function tests for slug derivation, plus DB-backed tests for
 * createOrgForOwner. The route-level signup happy path is in
 * routes.test.ts; the failure modes (collision retry, transactional
 * rollback) belong here so they can be exercised without going
 * through the auth provider.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deriveSlug, slugFromEmail, createOrgForOwner, findAvailableSlug } from "./org.js";

let workdir: string;
let prisma: import("@altium-mcp/db").PrismaClient;
let testUserId: string;

before(async () => {
  workdir = mkdtempSync(join(tmpdir(), "altium-mcp-org-test-"));
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
  const u = await prisma.user.create({ data: { email: "owner@example.com" } });
  testUserId = u.id;
});

after(async () => {
  if (prisma) await prisma.$disconnect();
  try {
    rmSync(workdir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

test("deriveSlug lowercases + ASCII-folds + collapses non-alnum", () => {
  assert.equal(deriveSlug("Acme Hardware Co."), "acme-hardware-co");
  assert.equal(deriveSlug("My  Org!!!"), "my-org");
  assert.equal(deriveSlug("UPPERCASE"), "uppercase");
});

test("deriveSlug strips diacritics", () => {
  assert.equal(deriveSlug("Café Équipe"), "cafe-equipe");
  assert.equal(deriveSlug("Résumé Co"), "resume-co");
});

test("deriveSlug handles unicode that isn't safely ASCII-foldable", () => {
  // Hebrew / CJK characters disappear; we get an empty-ish result that
  // the caller is expected to fall back from (slugFromEmail or default).
  assert.equal(deriveSlug("סיסמה"), "");
  assert.equal(deriveSlug("日本語"), "");
});

test("deriveSlug strips leading/trailing dashes", () => {
  assert.equal(deriveSlug("-foo-"), "foo");
  assert.equal(deriveSlug("---foo---"), "foo");
});

test("deriveSlug truncates to 48 chars", () => {
  const long = "a".repeat(100);
  assert.equal(deriveSlug(long).length, 48);
});

test("slugFromEmail picks the local-part", () => {
  assert.equal(slugFromEmail("alice@example.com"), "alice");
  assert.equal(slugFromEmail("Mixed.Case+tag@acme.test"), "mixed-case-tag");
});

test("slugFromEmail falls back to 'org' when local-part is unprintable", () => {
  assert.equal(slugFromEmail("שלום@acme.test"), "org");
});

// ─── createOrgForOwner — DB-backed tests ─────────────────────────────

test("createOrgForOwner creates org + owner Membership in one transaction", async () => {
  const out = await createOrgForOwner({
    userId: testUserId,
    orgName: "Acme Hardware",
    email: "owner@example.com",
  });
  assert.equal(out.orgName, "Acme Hardware");
  assert.equal(out.orgSlug, "acme-hardware");

  const m = await prisma.membership.findUnique({
    where: { id: out.membershipId },
  });
  assert.ok(m);
  assert.equal(m.role, "owner");
  assert.equal(m.userId, testUserId);
  assert.equal(m.orgId, out.orgId);
});

test("createOrgForOwner falls back to email-derived slug when orgName is missing", async () => {
  const u = await prisma.user.create({ data: { email: "alice@acme.test" } });
  const out = await createOrgForOwner({
    userId: u.id,
    email: "alice@acme.test",
  });
  assert.equal(out.orgSlug, "alice");
  assert.match(out.orgName, /alice's Organization/);
});

test("createOrgForOwner uses fallback name when orgName is whitespace-only", async () => {
  const u = await prisma.user.create({ data: { email: "ws@acme.test" } });
  const out = await createOrgForOwner({
    userId: u.id,
    orgName: "    ",
    email: "ws@acme.test",
  });
  // Slug derivation gives "ws" because slugFromEmail falls back when
  // orgName trims to empty.
  assert.equal(out.orgSlug, "ws");
  assert.match(out.orgName, /ws's Organization/);
});

test("createOrgForOwner adds a -2 suffix on slug collision", async () => {
  // Pre-create an org claiming the name.
  await prisma.organization.create({
    data: { name: "Already Here", slug: "collide-test" },
  });
  const u = await prisma.user.create({ data: { email: "collision@example.com" } });
  const out = await createOrgForOwner({
    userId: u.id,
    orgName: "collide-test",
    email: "collision@example.com",
  });
  assert.equal(out.orgSlug, "collide-test-2");
});

test("findAvailableSlug skips taken slugs sequentially", async () => {
  await prisma.organization.create({
    data: { name: "P1", slug: "popular" },
  });
  await prisma.organization.create({
    data: { name: "P2", slug: "popular-2" },
  });
  const next = await findAvailableSlug("popular");
  assert.equal(next, "popular-3");
});

test("createOrgForOwner trims a long orgName via deriveSlug's 48-char cap", async () => {
  const u = await prisma.user.create({ data: { email: "longname@example.com" } });
  const longName = "Acme " + "X".repeat(200);
  const out = await createOrgForOwner({
    userId: u.id,
    orgName: longName,
    email: "longname@example.com",
  });
  assert.ok(out.orgSlug.length <= 48);
  assert.equal(out.orgName, longName.trim());
});

test("createOrgForOwner default name uses email local-part", async () => {
  const u = await prisma.user.create({ data: { email: "carol@vendor.io" } });
  const out = await createOrgForOwner({
    userId: u.id,
    email: "carol@vendor.io",
  });
  assert.equal(out.orgName, "carol's Organization");
});
