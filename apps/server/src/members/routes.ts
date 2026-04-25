/**
 * Members + invitations routes — Sprint 3 PR 3.1.
 *
 * Endpoints (matched against the internal design spec §3.3):
 *
 *   GET    /api/orgs/:orgId/members            — list (any member)
 *   POST   /api/orgs/:orgId/invites            — create   (owner/admin)
 *   GET    /api/orgs/:orgId/invites            — list pending (owner/admin)
 *   DELETE /api/orgs/:orgId/invites/:inviteId  — revoke   (owner/admin)
 *   POST   /api/invites/:token/accept          — accept   (auth required)
 *
 * Email delivery is deferred — WorkOS / SMTP isn't wired yet. The
 * create response carries the raw `token` so the inviter can copy the
 * accept URL into Slack / email manually. When real email lands, no
 * client-facing API change is needed.
 *
 * Audit log:
 *   member.invite        — on create   (target = invite.id)
 *   member.invite.revoke — on delete   (target = invite.id)
 *   member.add           — on accept   (target = membership.userId)
 *
 * Stable error codes (kept in sync with the SPA's mapper):
 *   not_authenticated  invalid_input  forbidden  not_found
 *   already_member               — invitee email is already a member
 *   invite_email_mismatch        — accept by a user whose email != invite.email
 *   invite_expired               — accept after expiresAt
 *   invite_already_accepted      — token already consumed
 *
 * Owner promotions are NOT done via invite. Owners are minted at signup
 * and otherwise granted via the role-change endpoint (which carries the
 * last-owner-cannot-be-demoted rule).
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@altium-mcp/db";
import type { AuthProvider } from "@altium-mcp/auth";
import { makeRequireAuth } from "../auth/middleware.js";
import { makeRequireOrgRole } from "../auth/tenant.js";
import { writeAuditLog, clientIp } from "../auth/audit.js";
import { generateInviteToken, inviteExpiry } from "./tokens.js";

// ─── Input schemas ────────────────────────────────────────────────────

/**
 * Roles an invite can grant. Excludes `owner` deliberately — owners
 * are minted at signup (auto-org) or promoted via the role-change
 * endpoint, never via an invite link.
 */
const InviteRole = z.enum(["admin", "member", "billing_only"]);

const CreateInviteBody = z.object({
  email: z.string().email().max(320),
  role: InviteRole,
});

// ─── Registration ─────────────────────────────────────────────────────

export async function registerMemberRoutes(
  app: FastifyInstance,
  auth: AuthProvider
): Promise<void> {
  const requireAuth = makeRequireAuth(auth);
  const requireMember = makeRequireOrgRole([]);
  const requireAdmin = makeRequireOrgRole(["owner", "admin"]);

  // ── GET /api/orgs/:orgId/members ─────────────────────────────────────
  // Any member can see the team. Returns the membership rows joined to
  // user (id, email, createdAt). The user's password hash and any other
  // auth-internal fields stay on the server.
  app.get(
    "/api/orgs/:orgId/members",
    { preHandler: [requireAuth, requireMember] },
    async (req) => {
      const ctx = req.ctx!;
      const rows = await prisma.membership.findMany({
        where: { orgId: ctx.org.id },
        include: {
          user: { select: { id: true, email: true, createdAt: true } },
        },
        orderBy: { createdAt: "asc" },
      });
      return {
        members: rows.map((m) => ({
          userId: m.userId,
          email: m.user.email,
          role: m.role,
          joinedAt: m.createdAt.toISOString(),
        })),
      };
    }
  );

  // ── POST /api/orgs/:orgId/invites ────────────────────────────────────
  // Owner/admin creates an invite for an email + role. Server returns
  // the raw token so the inviter can paste the accept URL anywhere.
  // Real email delivery lands when SMTP / WorkOS is wired.
  app.post(
    "/api/orgs/:orgId/invites",
    { preHandler: [requireAuth, requireAdmin] },
    async (req, reply) => {
      const parsed = CreateInviteBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid_input", detail: parsed.error.flatten() };
      }
      const ctx = req.ctx!;
      const email = parsed.data.email.toLowerCase();
      const role = parsed.data.role;

      // Reject if the email already belongs to a member of this org.
      // Looking up by user.email is fine because email is unique on
      // the User table; if the user doesn't exist yet, `existing` is
      // null and the invite proceeds normally.
      const existingUser = await prisma.user.findUnique({
        where: { email },
        select: { id: true },
      });
      if (existingUser) {
        const m = await prisma.membership.findUnique({
          where: {
            orgId_userId: { orgId: ctx.org.id, userId: existingUser.id },
          },
          select: { id: true },
        });
        if (m) {
          reply.code(409);
          return { error: "already_member" };
        }
      }

      const token = generateInviteToken();
      const expiresAt = inviteExpiry();
      const invite = await prisma.invite.create({
        data: {
          orgId: ctx.org.id,
          email,
          role,
          token,
          expiresAt,
        },
      });

      await writeAuditLog({
        orgId: ctx.org.id,
        actorUserId: ctx.user.id,
        action: "member.invite",
        target: invite.id,
        ip: clientIp(req),
        userAgent: req.headers["user-agent"],
        metadata: { email, role },
      });

      reply.code(201);
      return {
        invite: serializeInvite(invite),
        token,
      };
    }
  );

  // ── GET /api/orgs/:orgId/invites ─────────────────────────────────────
  // Owner/admin lists pending (non-accepted, non-expired) invites for
  // the org. Members shouldn't see who's been invited (privacy +
  // mirrors the spec's owner/admin gate on Members management).
  app.get(
    "/api/orgs/:orgId/invites",
    { preHandler: [requireAuth, requireAdmin] },
    async (req) => {
      const ctx = req.ctx!;
      const now = new Date();
      const rows = await prisma.invite.findMany({
        where: {
          orgId: ctx.org.id,
          acceptedAt: null,
          expiresAt: { gt: now },
        },
        orderBy: { id: "asc" },
      });
      return { invites: rows.map(serializeInvite) };
    }
  );

  // ── DELETE /api/orgs/:orgId/invites/:inviteId ────────────────────────
  // Owner/admin revokes a pending invite. Already-accepted invites are
  // immutable here — the membership is the thing to revoke at that
  // point, via the member-removal endpoint.
  app.delete(
    "/api/orgs/:orgId/invites/:inviteId",
    { preHandler: [requireAuth, requireAdmin] },
    async (req, reply) => {
      const ctx = req.ctx!;
      const { inviteId } = req.params as { inviteId: string };
      const invite = await prisma.invite.findUnique({
        where: { id: inviteId },
      });
      // Conflate "doesn't exist" and "belongs to a different org" into
      // a 404 — same defense pattern as workspaces. No invite-id
      // enumeration across tenants.
      if (!invite || invite.orgId !== ctx.org.id) {
        reply.code(404);
        return { error: "not_found" };
      }
      if (invite.acceptedAt) {
        reply.code(409);
        return { error: "invite_already_accepted" };
      }

      await prisma.invite.delete({ where: { id: inviteId } });

      await writeAuditLog({
        orgId: ctx.org.id,
        actorUserId: ctx.user.id,
        action: "member.invite.revoke",
        target: inviteId,
        ip: clientIp(req),
        userAgent: req.headers["user-agent"],
        metadata: { email: invite.email, role: invite.role },
      });

      return { ok: true };
    }
  );

  // ── POST /api/invites/:token/accept ──────────────────────────────────
  // Auth required: the user must already be signed in (via /signup or
  // /login) before clicking the accept link. The server matches the
  // invite's email to the logged-in user's email — a leaked URL can
  // NOT auto-bind to whichever account happens to be signed in.
  app.post("/api/invites/:token/accept", { preHandler: [requireAuth] }, async (req, reply) => {
    const user = req.user!;
    const { token } = req.params as { token: string };

    const invite = await prisma.invite.findUnique({ where: { token } });
    if (!invite) {
      reply.code(404);
      return { error: "not_found" };
    }
    if (invite.acceptedAt) {
      reply.code(409);
      return { error: "invite_already_accepted" };
    }
    if (invite.expiresAt.getTime() <= Date.now()) {
      reply.code(410);
      return { error: "invite_expired" };
    }
    if (invite.email.toLowerCase() !== user.email.toLowerCase()) {
      // 403: the user is real, just not the right person for this link.
      // Don't echo the invite email back — that would let an attacker
      // probe membership of a target email by submitting their own
      // session against a guessed token.
      reply.code(403);
      return { error: "invite_email_mismatch" };
    }

    // Idempotent insert: if a membership already exists (e.g. the user
    // was added another way), surface that as 409 instead of P2002.
    const existing = await prisma.membership.findUnique({
      where: { orgId_userId: { orgId: invite.orgId, userId: user.id } },
      select: { id: true },
    });
    if (existing) {
      reply.code(409);
      return { error: "already_member" };
    }

    // Wrap the membership create + invite mark-accepted in a single
    // transaction so a partial failure can't leave a consumed-token
    // row without the membership it represents.
    const [membership] = await prisma.$transaction([
      prisma.membership.create({
        data: {
          orgId: invite.orgId,
          userId: user.id,
          role: invite.role,
        },
      }),
      prisma.invite.update({
        where: { id: invite.id },
        data: { acceptedAt: new Date() },
      }),
    ]);

    await writeAuditLog({
      orgId: invite.orgId,
      actorUserId: user.id,
      action: "member.add",
      target: membership.userId,
      ip: clientIp(req),
      userAgent: req.headers["user-agent"],
      metadata: { via: "invite", inviteId: invite.id, role: membership.role },
    });

    const org = await prisma.organization.findUnique({
      where: { id: invite.orgId },
      select: { id: true, slug: true, name: true },
    });

    return {
      membership: {
        orgId: membership.orgId,
        userId: membership.userId,
        role: membership.role,
        joinedAt: membership.createdAt.toISOString(),
      },
      org,
    };
  });
}

// ─── Response shape ───────────────────────────────────────────────────

function serializeInvite(inv: {
  id: string;
  orgId: string;
  email: string;
  role: string;
  expiresAt: Date;
  acceptedAt: Date | null;
}) {
  // Public Invite shape — never includes the `token` field. The token
  // appears exactly once in the API surface (the create response) and
  // never thereafter; subsequent listings only carry metadata.
  return {
    id: inv.id,
    orgId: inv.orgId,
    email: inv.email,
    role: inv.role,
    expiresAt: inv.expiresAt.toISOString(),
    acceptedAt: inv.acceptedAt ? inv.acceptedAt.toISOString() : null,
  };
}
