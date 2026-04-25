/**
 * Members + invitations route tests — Sprint 3 PR 3.1.
 *
 * Pins:
 *   - Authorization: any member can list members, only owner/admin can
 *     create/list/revoke invites; cross-tenant probes 403/404
 *   - Invite contract: token returned exactly once on create, never
 *     echoed in listings; expiry is honored (410); double-accept 409;
 *     wrong-email accept is 403 with no email leak
 *   - Self-invite, already-member: collapse to 409 already_member
 *   - Owner role can NOT be granted via invite (only via PR 3.2's
 *     promotion endpoint)
 *   - Audit log: every mutation writes a row with the right action
 *     and metadata
 *
 * Hermetic: temp SQLite DB + applied migrations + in-process Fastify
 * with the auth + members routes wired.
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
let aliceUserId: string;
let bobUserId: string;
let aliceOrgId: string;
let bobOrgId: string;

const STRONG = "correct-horse-battery-staple-3";

before(async () => {
  workdir = mkdtempSync(join(tmpdir(), "altium-mcp-members-test-"));
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
  const { registerMemberRoutes } = await import("./routes.js");

  app = Fastify({ logger: false });
  await app.register(cookie);
  const auth = selectAuthProvider();
  await registerAuthRoutes(app, auth);
  await registerMemberRoutes(app, auth);
  await app.ready();

  // Seed two orgs.
  const aliceSignup = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email: "alice@members-test.example", password: STRONG },
  });
  aliceUserId = aliceSignup.json().user.id;
  aliceOrgId = aliceSignup.json().org.id;
  aliceCookie = extractCookie(aliceSignup.headers["set-cookie"])!;

  const bobSignup = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email: "bob@members-test.example", password: STRONG },
  });
  bobUserId = bobSignup.json().user.id;
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

// ═══ GET /api/orgs/:orgId/members ═══════════════════════════════════════

test("GET /members returns the calling user's membership in their own org", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/members`,
    headers: { cookie: aliceCookie },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.members.length, 1);
  const m = body.members[0];
  assert.equal(m.userId, aliceUserId);
  assert.equal(m.email, "alice@members-test.example");
  assert.equal(m.role, "owner");
  assert.ok(typeof m.joinedAt === "string");
});

test("GET /members 401 without a session", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/members`,
  });
  assert.equal(res.statusCode, 401);
});

test("GET /members from a non-member returns 403 (cross-tenant probe)", async () => {
  // Bob isn't a member of Alice's org — must be a 403, not a 404, and
  // not echo the org's name (no enumeration of org IDs).
  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/members`,
    headers: { cookie: bobCookie },
  });
  assert.equal(res.statusCode, 403);
});

// ═══ POST /api/orgs/:orgId/invites ══════════════════════════════════════

test("POST /invites creates a pending invite and returns the token EXACTLY ONCE", async () => {
  const res = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/invites`,
    headers: { cookie: aliceCookie },
    payload: { email: "newhire1@members-test.example", role: "member" },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.ok(body.invite.id);
  assert.equal(body.invite.email, "newhire1@members-test.example");
  assert.equal(body.invite.role, "member");
  assert.equal(body.invite.acceptedAt, null);
  assert.ok(typeof body.token === "string");
  assert.match(body.token, /^[A-Za-z0-9_-]+$/);
  // The serialized invite must NOT include the token (it's a separate
  // top-level field — leaking it into the embedded invite would risk
  // it ending up in the same JSON store on the client).
  assert.ok(!("token" in body.invite));
});

test("POST /invites with role=owner is rejected (owners only via promotion)", async () => {
  const res = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/invites`,
    headers: { cookie: aliceCookie },
    payload: { email: "wouldbe-owner@members-test.example", role: "owner" },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "invalid_input");
});

test("POST /invites with bad email payload returns 400 invalid_input", async () => {
  const res = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/invites`,
    headers: { cookie: aliceCookie },
    payload: { email: "garbage", role: "member" },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "invalid_input");
});

test("POST /invites for an existing member returns 409 already_member", async () => {
  // Bob has his own org, but he's also a member of Alice's org for
  // this test only.
  const { prisma } = await import("@altium-mcp/db");
  await prisma.membership.create({
    data: { orgId: aliceOrgId, userId: bobUserId, role: "member" },
  });

  const res = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/invites`,
    headers: { cookie: aliceCookie },
    payload: { email: "bob@members-test.example", role: "member" },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, "already_member");

  // Cleanup so later tests aren't polluted.
  await prisma.membership.delete({
    where: { orgId_userId: { orgId: aliceOrgId, userId: bobUserId } },
  });
});

test("POST /invites by a member (not owner/admin) returns 403", async () => {
  // Make a fresh non-admin member of Alice's org.
  const { prisma } = await import("@altium-mcp/db");
  const m = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: {
      email: `non-admin-${randomBytes(3).toString("hex")}@members-test.example`,
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
    url: `/api/orgs/${aliceOrgId}/invites`,
    headers: { cookie: mCookie },
    payload: { email: "nope@members-test.example", role: "member" },
  });
  assert.equal(res.statusCode, 403);
});

test("POST /invites cross-tenant: Bob can't create in Alice's org", async () => {
  const res = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/invites`,
    headers: { cookie: bobCookie },
    payload: { email: "x@y.example", role: "member" },
  });
  assert.equal(res.statusCode, 403);
});

test("POST /invites writes a member.invite audit row with the invite id", async () => {
  const res = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/invites`,
    headers: { cookie: aliceCookie },
    payload: { email: "audited@members-test.example", role: "admin" },
  });
  const inviteId = res.json().invite.id;
  const { prisma } = await import("@altium-mcp/db");
  const log = await prisma.auditLog.findFirst({
    where: { orgId: aliceOrgId, action: "member.invite", target: inviteId },
  });
  assert.ok(log, "audit row not found");
  assert.equal(log.actorUserId, aliceUserId);
  // Token must NOT appear in the audit row metadata — that would
  // turn the audit log into a credential store.
  assert.doesNotMatch(log.metadata ?? "", /[A-Za-z0-9_-]{30,}/);
});

// ═══ GET /api/orgs/:orgId/invites ═══════════════════════════════════════

test("GET /invites lists pending invites for owner/admin", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/invites`,
    headers: { cookie: aliceCookie },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  // We've created several invites in earlier tests — at least one
  // must still be pending. The token must NOT appear on any row.
  assert.ok(body.invites.length >= 1);
  for (const inv of body.invites) {
    assert.ok(!("token" in inv));
    assert.equal(inv.acceptedAt, null);
  }
});

test("GET /invites: a non-admin member is 403", async () => {
  const { prisma } = await import("@altium-mcp/db");
  const m = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: {
      email: `lister-${randomBytes(3).toString("hex")}@members-test.example`,
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
    url: `/api/orgs/${aliceOrgId}/invites`,
    headers: { cookie: mCookie },
  });
  assert.equal(res.statusCode, 403);
});

test("GET /invites does NOT return expired invites", async () => {
  const { prisma } = await import("@altium-mcp/db");
  // Stash an expired invite directly via Prisma — the create endpoint
  // refuses to set expiresAt in the past.
  await prisma.invite.create({
    data: {
      orgId: aliceOrgId,
      email: "expired@members-test.example",
      role: "member",
      token: randomBytes(32).toString("base64url"),
      expiresAt: new Date(Date.now() - 1000),
    },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/invites`,
    headers: { cookie: aliceCookie },
  });
  const body = res.json();
  assert.ok(
    body.invites.every(
      (i: { email: string }) => i.email !== "expired@members-test.example"
    ),
    "expired invite leaked into pending list"
  );
});

// ═══ DELETE /api/orgs/:orgId/invites/:inviteId ══════════════════════════

test("DELETE /invites/:id revokes a pending invite + writes audit row", async () => {
  const created = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/invites`,
    headers: { cookie: aliceCookie },
    payload: { email: "torevoke@members-test.example", role: "member" },
  });
  const inviteId = created.json().invite.id;

  const res = await app.inject({
    method: "DELETE",
    url: `/api/orgs/${aliceOrgId}/invites/${inviteId}`,
    headers: { cookie: aliceCookie },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });

  const { prisma } = await import("@altium-mcp/db");
  const gone = await prisma.invite.findUnique({ where: { id: inviteId } });
  assert.equal(gone, null);
  const log = await prisma.auditLog.findFirst({
    where: { orgId: aliceOrgId, action: "member.invite.revoke", target: inviteId },
  });
  assert.ok(log);
});

test("DELETE /invites cross-tenant: Bob can't revoke Alice's invite (404)", async () => {
  const created = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/invites`,
    headers: { cookie: aliceCookie },
    payload: { email: "crosstenant-revoke@members-test.example", role: "member" },
  });
  const inviteId = created.json().invite.id;

  // Bob is admin of HIS org. He targets Alice's invite via Alice's
  // orgId — the 403 fires from requireAdmin on cross-tenant. He
  // CANNOT use his orgId in the path because the invite isn't there
  // (404). Both shapes prevent enumeration; we test both.
  const cross1 = await app.inject({
    method: "DELETE",
    url: `/api/orgs/${aliceOrgId}/invites/${inviteId}`,
    headers: { cookie: bobCookie },
  });
  assert.equal(cross1.statusCode, 403);

  const cross2 = await app.inject({
    method: "DELETE",
    url: `/api/orgs/${bobOrgId}/invites/${inviteId}`,
    headers: { cookie: bobCookie },
  });
  assert.equal(cross2.statusCode, 404);
});

test("DELETE /invites returns 404 for an unknown id", async () => {
  const res = await app.inject({
    method: "DELETE",
    url: `/api/orgs/${aliceOrgId}/invites/cknotreal000000000000000xx`,
    headers: { cookie: aliceCookie },
  });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, "not_found");
});

test("DELETE /invites returns 409 if the invite was already accepted", async () => {
  const { prisma } = await import("@altium-mcp/db");
  const inv = await prisma.invite.create({
    data: {
      orgId: aliceOrgId,
      email: "consumed@members-test.example",
      role: "member",
      token: randomBytes(32).toString("base64url"),
      expiresAt: new Date(Date.now() + 60_000),
      acceptedAt: new Date(),
    },
  });
  const res = await app.inject({
    method: "DELETE",
    url: `/api/orgs/${aliceOrgId}/invites/${inv.id}`,
    headers: { cookie: aliceCookie },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, "invite_already_accepted");
});

// ═══ POST /api/invites/:token/accept ════════════════════════════════════

test("POST /accept happy path: matching email, valid token, creates membership", async () => {
  // Create an invite for a brand-new email.
  const inviteRes = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/invites`,
    headers: { cookie: aliceCookie },
    payload: { email: "newhire-happy@members-test.example", role: "admin" },
  });
  const token = inviteRes.json().token;

  // Sign up the invitee with the same email.
  const invitee = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: {
      email: "newhire-happy@members-test.example",
      password: STRONG,
    },
  });
  const inviteeCookie = extractCookie(invitee.headers["set-cookie"])!;
  const inviteeUserId = invitee.json().user.id;

  const accept = await app.inject({
    method: "POST",
    url: `/api/invites/${token}/accept`,
    headers: { cookie: inviteeCookie },
  });
  assert.equal(accept.statusCode, 200);
  const body = accept.json();
  assert.equal(body.membership.orgId, aliceOrgId);
  assert.equal(body.membership.userId, inviteeUserId);
  assert.equal(body.membership.role, "admin");
  assert.equal(body.org.id, aliceOrgId);

  // The invite is consumed.
  const { prisma } = await import("@altium-mcp/db");
  const consumed = await prisma.invite.findFirst({
    where: { token },
  });
  assert.ok(consumed?.acceptedAt);

  // Audit row is written.
  const log = await prisma.auditLog.findFirst({
    where: {
      orgId: aliceOrgId,
      action: "member.add",
      target: inviteeUserId,
    },
  });
  assert.ok(log);
  assert.match(log.metadata ?? "", /"via":"invite"/);
});

test("POST /accept fails 401 without a session", async () => {
  const inviteRes = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/invites`,
    headers: { cookie: aliceCookie },
    payload: { email: "needs-auth@members-test.example", role: "member" },
  });
  const token = inviteRes.json().token;
  const res = await app.inject({
    method: "POST",
    url: `/api/invites/${token}/accept`,
  });
  assert.equal(res.statusCode, 401);
});

test("POST /accept rejects mismatched email with 403 invite_email_mismatch", async () => {
  // Invite is for X@... but the logged-in user is Bob.
  const inviteRes = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/invites`,
    headers: { cookie: aliceCookie },
    payload: { email: "wrong-target@members-test.example", role: "member" },
  });
  const token = inviteRes.json().token;
  const res = await app.inject({
    method: "POST",
    url: `/api/invites/${token}/accept`,
    headers: { cookie: bobCookie },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, "invite_email_mismatch");
  // Defense in depth: response body must not echo the invite's email
  // (would leak whether a leaked URL was bound to a specific target).
  assert.doesNotMatch(JSON.stringify(res.json()), /wrong-target/i);
});

test("POST /accept on an unknown token is 404 (no enumeration shape)", async () => {
  const res = await app.inject({
    method: "POST",
    url: `/api/invites/${randomBytes(32).toString("base64url")}/accept`,
    headers: { cookie: bobCookie },
  });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, "not_found");
});

test("POST /accept on an already-accepted token is 409", async () => {
  const inviteRes = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/invites`,
    headers: { cookie: aliceCookie },
    payload: { email: "double-accept@members-test.example", role: "member" },
  });
  const token = inviteRes.json().token;
  const invitee = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: {
      email: "double-accept@members-test.example",
      password: STRONG,
    },
  });
  const inviteeCookie = extractCookie(invitee.headers["set-cookie"])!;

  const first = await app.inject({
    method: "POST",
    url: `/api/invites/${token}/accept`,
    headers: { cookie: inviteeCookie },
  });
  assert.equal(first.statusCode, 200);

  const second = await app.inject({
    method: "POST",
    url: `/api/invites/${token}/accept`,
    headers: { cookie: inviteeCookie },
  });
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().error, "invite_already_accepted");
});

test("POST /accept on an expired token is 410 invite_expired", async () => {
  const { prisma } = await import("@altium-mcp/db");
  // Create an expired invite for a fresh email + sign that user up.
  const expiredToken = randomBytes(32).toString("base64url");
  await prisma.invite.create({
    data: {
      orgId: aliceOrgId,
      email: "expired-accept@members-test.example",
      role: "member",
      token: expiredToken,
      expiresAt: new Date(Date.now() - 1000),
    },
  });
  const invitee = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: {
      email: "expired-accept@members-test.example",
      password: STRONG,
    },
  });
  const inviteeCookie = extractCookie(invitee.headers["set-cookie"])!;
  const res = await app.inject({
    method: "POST",
    url: `/api/invites/${expiredToken}/accept`,
    headers: { cookie: inviteeCookie },
  });
  assert.equal(res.statusCode, 410);
  assert.equal(res.json().error, "invite_expired");
});

test("POST /accept on a target who is already a member is 409 already_member", async () => {
  const { prisma } = await import("@altium-mcp/db");
  // Create an invite for a future user + sign them up + add membership
  // through the "back door" (simulating a parallel add) → accept → 409.
  const target = "race-already-member@members-test.example";
  const created = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/invites`,
    headers: { cookie: aliceCookie },
    payload: { email: target, role: "member" },
  });
  const token = created.json().token;
  const invitee = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email: target, password: STRONG },
  });
  const inviteeUserId = invitee.json().user.id;
  const inviteeCookie = extractCookie(invitee.headers["set-cookie"])!;
  // Sneak in a manual membership before the invitee accepts. This
  // mirrors a race where two flows added the same person.
  await prisma.membership.create({
    data: { orgId: aliceOrgId, userId: inviteeUserId, role: "member" },
  });
  const res = await app.inject({
    method: "POST",
    url: `/api/invites/${token}/accept`,
    headers: { cookie: inviteeCookie },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, "already_member");
});

test("POST /accept appears in GET /members afterward", async () => {
  const inviteRes = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/invites`,
    headers: { cookie: aliceCookie },
    payload: { email: "post-accept-listed@members-test.example", role: "member" },
  });
  const token = inviteRes.json().token;
  const invitee = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: {
      email: "post-accept-listed@members-test.example",
      password: STRONG,
    },
  });
  const inviteeCookie = extractCookie(invitee.headers["set-cookie"])!;
  await app.inject({
    method: "POST",
    url: `/api/invites/${token}/accept`,
    headers: { cookie: inviteeCookie },
  });

  // Now Alice (admin) lists members — the new admin must appear.
  const list = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/members`,
    headers: { cookie: aliceCookie },
  });
  const emails = list.json().members.map((m: { email: string }) => m.email);
  assert.ok(emails.includes("post-accept-listed@members-test.example"));
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
