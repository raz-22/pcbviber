/**
 * Members + invitations routes.
 *
 * Endpoints (matched against the internal design spec §3.3):
 *
 *   GET    /api/orgs/:orgId/members              — list (any member)
 *   PATCH  /api/orgs/:orgId/members/:userId      — role change (gated by can())
 *   DELETE /api/orgs/:orgId/members/:userId      — remove (gated by can())
 *   POST   /api/orgs/:orgId/invites              — create   (owner/admin)
 *   GET    /api/orgs/:orgId/invites              — list pending (owner/admin)
 *   DELETE /api/orgs/:orgId/invites/:inviteId    — revoke   (owner/admin)
 *   POST   /api/invites/:token/accept            — accept   (auth required)
 *
 * Email delivery is deferred — WorkOS / SMTP isn't wired yet. The
 * create response carries the raw `token` so the inviter can copy the
 * accept URL into Slack / email manually. When real email lands, no
 * client-facing API change is needed.
 *
 * Audit log:
 *   member.invite        — on create        (target = invite.id)
 *   member.invite.revoke — on delete invite (target = invite.id)
 *   member.add           — on accept        (target = membership.userId)
 *   member.role_change   — on PATCH         (target = membership.userId,
 *                                            metadata = { from, to })
 *   member.remove        — on DELETE        (target = membership.userId,
 *                                            metadata = { role })
 *
 * Stable error codes (kept in sync with the SPA's mapper):
 *   not_authenticated  invalid_input  forbidden  not_found
 *   already_member               — invitee email is already a member
 *   invite_email_mismatch        — accept by a user whose email != invite.email
 *   invite_expired               — accept after expiresAt
 *   invite_already_accepted      — token already consumed
 *   cannot_demote_last_owner     — PATCH would leave the org with 0 owners
 *   cannot_remove_last_owner     — DELETE would leave the org with 0 owners
 *
 * Owner promotions are NOT done via invite. Owners are minted at signup
 * and otherwise granted via the role-change endpoint (which carries the
 * last-owner-cannot-be-demoted rule).
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma, type Prisma } from "@altium-mcp/db";
import type { AuthProvider, Role } from "@altium-mcp/auth";
import { makeRequireAuth } from "../auth/middleware.js";
import { makeRequireOrgRole } from "../auth/tenant.js";
import { writeAuditLog, clientIp } from "../auth/audit.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { can } from "../auth/can.js";
import { generateInviteToken, inviteExpiry } from "./tokens.js";
import { INVITE_RATE_LIMIT } from "../security/rate-limits.js";
import { csrfOrPassthrough } from "../security/csrf.js";

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

/**
 * Role payload accepted by PATCH /members/:userId. Includes `owner`
 * (unlike invite) — owner promotions are gated inside `can()`.
 */
const ChangeRoleBody = z.object({
  role: z.enum(["owner", "admin", "member", "billing_only"]),
});

/**
 * Counts the owners of an org. Drives the last-owner protection in
 * PATCH/DELETE — when this count is 1 and the action would
 * demote/remove the only owner, the route 409s instead of touching
 * the row. We count owners (not members) to avoid the obvious
 * inefficiency of loading every membership.
 */
async function countOwners(
  client: Prisma.TransactionClient,
  orgId: string
): Promise<number> {
  return client.membership.count({
    where: { orgId, role: "owner" },
  });
}

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
      const rows = await withTenantTx(ctx.org.id, (tx) =>
        tx.membership.findMany({
          where: { orgId: ctx.org.id },
          include: {
            user: { select: { id: true, email: true, createdAt: true } },
          },
          orderBy: { createdAt: "asc" },
        })
      );
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

  // ── PATCH /api/orgs/:orgId/members/:userId ───────────────────────────
  // Change a member's role. Authorization is delegated to `can()` —
  // the route's job is to load the resource snapshot (target's current
  // role + last-owner status) and surface the right error code.
  //
  // Error code resolution order matters:
  //   1. invalid_input (Zod) — bad body
  //   2. not_found          — target isn't a member of this org
  //   3. cannot_demote_last_owner (409) — state, not privilege
  //   4. forbidden (403)    — actor lacks the role / owner-transition gate
  //
  // We check (3) BEFORE (4) so the SPA can show the more specific 409
  // even when the actor would have been forbidden anyway. Owner trying
  // to demote the last-owner gets 409, not 403 — the message "you
  // can't demote yourself, you'd be the only owner" is more useful
  // than "forbidden".
  app.patch(
    "/api/orgs/:orgId/members/:userId",
    { preHandler: [csrfOrPassthrough(app), requireAuth, requireMember] },
    async (req, reply) => {
      const parsed = ChangeRoleBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid_input", detail: parsed.error.flatten() };
      }
      const ctx = req.ctx!;
      const { userId: targetUserId } = req.params as { userId: string };
      const newRole = parsed.data.role;

      const result = await withTenantTx(ctx.org.id, async (tx) => {
        const target = await tx.membership.findUnique({
          where: { orgId_userId: { orgId: ctx.org.id, userId: targetUserId } },
          include: { user: { select: { id: true, email: true } } },
        });
        if (!target) {
          return { kind: "not_found" } as const;
        }

        const currentRole = target.role as Role;
        const isDemotion = currentRole === "owner" && newRole !== "owner";

        // Last-owner state check first — surfaces 409 even when the
        // actor would otherwise have privilege.
        if (isDemotion) {
          const owners = await countOwners(tx, ctx.org.id);
          if (owners <= 1) {
            return { kind: "cannot_demote_last_owner" } as const;
          }
        }

        // Pure role + transition check via can(). Pass isLastOwner:false
        // because the state check above already handled that case; this
        // call focuses can() on the role/transition rules.
        const allowed = can(
          { userId: ctx.user.id, role: ctx.role },
          "member.role_change",
          {
            kind: "member",
            userId: targetUserId,
            currentRole,
            newRole,
            isLastOwner: false,
          }
        );
        if (!allowed) {
          return { kind: "forbidden" } as const;
        }

        const updated = await tx.membership.update({
          where: { orgId_userId: { orgId: ctx.org.id, userId: targetUserId } },
          data: { role: newRole },
        });
        return { kind: "ok", target, updated, currentRole } as const;
      });

      if (result.kind === "not_found") {
        // Target isn't a member of this org. 404 (not 403) — same
        // shape we'd return for an unknown id; cross-tenant probes
        // can't distinguish "member of another org" from "doesn't exist".
        reply.code(404);
        return { error: "not_found" };
      }
      if (result.kind === "cannot_demote_last_owner") {
        reply.code(409);
        return { error: "cannot_demote_last_owner" };
      }
      if (result.kind === "forbidden") {
        reply.code(403);
        return { error: "forbidden" };
      }
      const { target, updated, currentRole } = result;

      await writeAuditLog({
        orgId: ctx.org.id,
        actorUserId: ctx.user.id,
        action: "member.role_change",
        target: targetUserId,
        ip: clientIp(req),
        userAgent: req.headers["user-agent"],
        metadata: { from: currentRole, to: newRole },
      });

      return {
        membership: {
          orgId: updated.orgId,
          userId: updated.userId,
          role: updated.role,
          email: target.user.email,
          joinedAt: updated.createdAt.toISOString(),
        },
      };
    }
  );

  // ── DELETE /api/orgs/:orgId/members/:userId ──────────────────────────
  // Remove a member from the org. Same error-code resolution order as
  // PATCH (last-owner before forbidden). Self-removal is allowed if
  // the actor isn't the last owner; the can() rule covers the
  // privilege side, the count-owners check covers the state side.
  //
  // Note: deleting the Membership cascades NOTHING — the User row
  // stays, their other org memberships stay, their auth session stays
  // (next request just sees 0 memberships in this org and 403s).
  app.delete(
    "/api/orgs/:orgId/members/:userId",
    { preHandler: [csrfOrPassthrough(app), requireAuth, requireMember] },
    async (req, reply) => {
      const ctx = req.ctx!;
      const { userId: targetUserId } = req.params as { userId: string };

      const result = await withTenantTx(ctx.org.id, async (tx) => {
        const target = await tx.membership.findUnique({
          where: { orgId_userId: { orgId: ctx.org.id, userId: targetUserId } },
        });
        if (!target) {
          return { kind: "not_found" } as const;
        }

        const currentRole = target.role as Role;

        if (currentRole === "owner") {
          const owners = await countOwners(tx, ctx.org.id);
          if (owners <= 1) {
            return { kind: "cannot_remove_last_owner" } as const;
          }
        }

        const allowed = can(
          { userId: ctx.user.id, role: ctx.role },
          "member.remove",
          {
            kind: "member",
            userId: targetUserId,
            currentRole,
            isLastOwner: false,
          }
        );
        if (!allowed) {
          return { kind: "forbidden" } as const;
        }

        await tx.membership.delete({
          where: { orgId_userId: { orgId: ctx.org.id, userId: targetUserId } },
        });
        return { kind: "ok", currentRole } as const;
      });

      if (result.kind === "not_found") {
        reply.code(404);
        return { error: "not_found" };
      }
      if (result.kind === "cannot_remove_last_owner") {
        reply.code(409);
        return { error: "cannot_remove_last_owner" };
      }
      if (result.kind === "forbidden") {
        reply.code(403);
        return { error: "forbidden" };
      }
      const { currentRole } = result;

      await writeAuditLog({
        orgId: ctx.org.id,
        actorUserId: ctx.user.id,
        action: "member.remove",
        target: targetUserId,
        ip: clientIp(req),
        userAgent: req.headers["user-agent"],
        metadata: { role: currentRole },
      });

      return { ok: true };
    }
  );

  // ── POST /api/orgs/:orgId/invites ────────────────────────────────────
  // Owner/admin creates an invite for an email + role. Server returns
  // the raw token so the inviter can paste the accept URL anywhere.
  // Real email delivery lands when SMTP / WorkOS is wired.
  app.post(
    "/api/orgs/:orgId/invites",
    {
      preHandler: [csrfOrPassthrough(app), requireAuth, requireAdmin],
      // Rate-limited 10/hour/orgId. Stops a compromised owner/admin
      // (or a runaway script) from spam-inviting hundreds of users.
      config: { rateLimit: INVITE_RATE_LIMIT },
    },
    async (req, reply) => {
      const parsed = CreateInviteBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid_input", detail: parsed.error.flatten() };
      }
      const ctx = req.ctx!;
      const email = parsed.data.email.toLowerCase();
      const role = parsed.data.role;

      const token = generateInviteToken();
      const expiresAt = inviteExpiry();

      const result = await withTenantTx(ctx.org.id, async (tx) => {
        // Reject if the email already belongs to a member of this org.
        // Looking up by user.email is fine because email is unique on
        // the User table; if the user doesn't exist yet, `existingUser`
        // is null and the invite proceeds normally. User has no RLS
        // policy in this sprint — global email lookup is intended.
        const existingUser = await tx.user.findUnique({
          where: { email },
          select: { id: true },
        });
        if (existingUser) {
          const m = await tx.membership.findUnique({
            where: {
              orgId_userId: { orgId: ctx.org.id, userId: existingUser.id },
            },
            select: { id: true },
          });
          if (m) {
            return { kind: "already_member" } as const;
          }
        }

        const invite = await tx.invite.create({
          data: {
            orgId: ctx.org.id,
            email,
            role,
            token,
            expiresAt,
          },
        });
        return { kind: "ok", invite } as const;
      });

      if (result.kind === "already_member") {
        reply.code(409);
        return { error: "already_member" };
      }
      const invite = result.invite;

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
      const rows = await withTenantTx(ctx.org.id, (tx) =>
        tx.invite.findMany({
          where: {
            orgId: ctx.org.id,
            acceptedAt: null,
            expiresAt: { gt: now },
          },
          orderBy: { id: "asc" },
        })
      );
      return { invites: rows.map(serializeInvite) };
    }
  );

  // ── DELETE /api/orgs/:orgId/invites/:inviteId ────────────────────────
  // Owner/admin revokes a pending invite. Already-accepted invites are
  // immutable here — the membership is the thing to revoke at that
  // point, via the member-removal endpoint.
  app.delete(
    "/api/orgs/:orgId/invites/:inviteId",
    { preHandler: [csrfOrPassthrough(app), requireAuth, requireAdmin] },
    async (req, reply) => {
      const ctx = req.ctx!;
      const { inviteId } = req.params as { inviteId: string };

      const result = await withTenantTx(ctx.org.id, async (tx) => {
        const invite = await tx.invite.findUnique({
          where: { id: inviteId },
        });
        // Conflate "doesn't exist" and "belongs to a different org" into
        // a 404 — same defense pattern as workspaces. No invite-id
        // enumeration across tenants.
        if (!invite || invite.orgId !== ctx.org.id) {
          return { kind: "not_found" } as const;
        }
        if (invite.acceptedAt) {
          return { kind: "invite_already_accepted" } as const;
        }
        await tx.invite.delete({ where: { id: inviteId } });
        return { kind: "ok", invite } as const;
      });

      if (result.kind === "not_found") {
        reply.code(404);
        return { error: "not_found" };
      }
      if (result.kind === "invite_already_accepted") {
        reply.code(409);
        return { error: "invite_already_accepted" };
      }
      const invite = result.invite;

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
  app.post(
    "/api/invites/:token/accept",
    { preHandler: [csrfOrPassthrough(app), requireAuth] },
    async (req, reply) => {
    const user = req.user!;
    const { token } = req.params as { token: string };

    // Token lookup runs on admin: the user has no req.ctx (they aren't
    // a member of any org for this token yet), so we can't compute a
    // tenant scope until we read the invite.
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

    // Now that we know the invite's orgId, run the duplicate check +
    // atomic create+update inside a tenant-scoped transaction. RLS
    // on Membership scopes the check to invite.orgId; the writes ride
    // the same transaction so a partial failure can't leave a consumed
    // token row without the membership it represents.
    const result = await withTenantTx(invite.orgId, async (tx) => {
      const existing = await tx.membership.findUnique({
        where: { orgId_userId: { orgId: invite.orgId, userId: user.id } },
        select: { id: true },
      });
      if (existing) {
        return { kind: "already_member" } as const;
      }
      const membership = await tx.membership.create({
        data: {
          orgId: invite.orgId,
          userId: user.id,
          role: invite.role,
        },
      });
      await tx.invite.update({
        where: { id: invite.id },
        data: { acceptedAt: new Date() },
      });
      return { kind: "ok", membership } as const;
    });

    if (result.kind === "already_member") {
      reply.code(409);
      return { error: "already_member" };
    }
    const membership = result.membership;

    await writeAuditLog({
      orgId: invite.orgId,
      actorUserId: user.id,
      action: "member.add",
      target: membership.userId,
      ip: clientIp(req),
      userAgent: req.headers["user-agent"],
      metadata: { via: "invite", inviteId: invite.id, role: membership.role },
    });

    // Org metadata for the response. Run in tenant scope so reads are
    // RLS-correct in production; in tests as admin the result is the
    // same.
    const org = await withTenantTx(invite.orgId, (tx) =>
      tx.organization.findUnique({
        where: { id: invite.orgId },
        select: { id: true, slug: true, name: true },
      })
    );

    return {
      membership: {
        orgId: membership.orgId,
        userId: membership.userId,
        role: membership.role,
        joinedAt: membership.createdAt.toISOString(),
      },
      org,
    };
    }
  );
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
