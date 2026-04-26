/**
 * Member-management subcommands.
 *
 *   addMember(...)     — directly create a Membership for an existing
 *                        user. Bypasses the invite/email-match flow.
 *                        Use case: locked-out org needs a recovery
 *                        admin out of band.
 *
 *   promoteMember(...) — change an existing member's role. Use case:
 *                        all owners left the company; bootstrap a new
 *                        owner from an existing admin.
 *
 * Both write an audit row tagged `admin.<verb>` with `actorUserId
 * null` (system actor) so the trail distinguishes admin-CLI actions
 * from app-driven ones.
 *
 * Org lookup accepts either id (cuid) or slug — slugs are easier
 * to type, ids are stable. Email lookup is exact (case-insensitive
 * via Postgres lower() / Prisma's `mode: "insensitive"` would need
 * a unique-by-(lower(email)) index; we just lowercase the input).
 */

import type { PrismaClient } from "@altium-mcp/db";

export type Role = "owner" | "admin" | "member" | "billing_only";
const KNOWN_ROLES: readonly Role[] = ["owner", "admin", "member", "billing_only"];

function asRole(s: string): Role {
  if ((KNOWN_ROLES as readonly string[]).includes(s)) return s as Role;
  throw new Error(
    `invalid role: ${JSON.stringify(s)} (expected: ${KNOWN_ROLES.join(" | ")})`
  );
}

interface ResolveOrgArgs {
  org: string; // slug-or-id
}

async function resolveOrg(prisma: PrismaClient, args: ResolveOrgArgs) {
  // Try id first (cuids are wider than slugs); fall through to slug
  // on miss. A row matching both is impossible — slug is unique and
  // wouldn't collide with a cuid format.
  const byId = await prisma.organization.findUnique({
    where: { id: args.org },
    select: { id: true, slug: true, deletedAt: true },
  });
  if (byId && !byId.deletedAt) return byId;
  const bySlug = await prisma.organization.findUnique({
    where: { slug: args.org },
    select: { id: true, slug: true, deletedAt: true },
  });
  if (!bySlug || bySlug.deletedAt) {
    throw new Error(`org not found: ${args.org}`);
  }
  return bySlug;
}

async function resolveUser(prisma: PrismaClient, email: string) {
  const lower = email.toLowerCase();
  const user = await prisma.user.findUnique({
    where: { email: lower },
    select: { id: true, email: true },
  });
  if (!user) {
    throw new Error(`user not found: ${email}`);
  }
  return user;
}

// ─── addMember ──────────────────────────────────────────────────────

export interface AddMemberArgs {
  org: string;
  email: string;
  role: string;
}

export interface AddMemberResult {
  orgId: string;
  orgSlug: string;
  userId: string;
  email: string;
  role: Role;
}

export async function addMember(
  prisma: PrismaClient,
  args: AddMemberArgs
): Promise<AddMemberResult> {
  const role = asRole(args.role);
  const org = await resolveOrg(prisma, args);
  const user = await resolveUser(prisma, args.email);

  const existing = await prisma.membership.findUnique({
    where: { orgId_userId: { orgId: org.id, userId: user.id } },
    select: { id: true, role: true },
  });
  if (existing) {
    throw new Error(
      `user ${args.email} is already a ${existing.role} in ${org.slug}; ` +
        `use 'members promote' to change their role`
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.membership.create({
      data: { orgId: org.id, userId: user.id, role },
    });
    await tx.auditLog.create({
      data: {
        orgId: org.id,
        actorUserId: null,
        action: "admin.member.add",
        target: user.id,
        metadata: JSON.stringify({ role, viaAdminCli: true }),
      },
    });
  });

  return {
    orgId: org.id,
    orgSlug: org.slug,
    userId: user.id,
    email: user.email,
    role,
  };
}

// ─── promoteMember ──────────────────────────────────────────────────

export interface PromoteMemberArgs {
  org: string;
  email: string;
  role: string;
}

export interface PromoteMemberResult {
  orgId: string;
  orgSlug: string;
  userId: string;
  email: string;
  from: Role;
  to: Role;
}

export async function promoteMember(
  prisma: PrismaClient,
  args: PromoteMemberArgs
): Promise<PromoteMemberResult> {
  const newRole = asRole(args.role);
  const org = await resolveOrg(prisma, args);
  const user = await resolveUser(prisma, args.email);

  const existing = await prisma.membership.findUnique({
    where: { orgId_userId: { orgId: org.id, userId: user.id } },
    select: { id: true, role: true },
  });
  if (!existing) {
    throw new Error(
      `${args.email} is not a member of ${org.slug}; use 'members add' first`
    );
  }
  const currentRole = existing.role as Role;
  if (currentRole === newRole) {
    throw new Error(
      `${args.email} is already ${newRole} in ${org.slug} — no change`
    );
  }

  // Refuse to demote the last remaining owner — same guard the HTTP
  // /members PATCH route uses (cannot_demote_last_owner). The CLI is
  // an operator tool, not a deliberately-foot-gunny tool. Use case
  // for this CLI is *promoting* into owner; demoting the last owner
  // would silently leave the org without an admin who can manage
  // billing or invite teammates.
  if (currentRole === "owner" && newRole !== "owner") {
    const owners = await prisma.membership.count({
      where: { orgId: org.id, role: "owner" },
    });
    if (owners <= 1) {
      throw new Error(
        `refusing to demote last owner of ${org.slug}: ` +
          `add another owner first via 'members add' or 'members promote'`
      );
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.membership.update({
      where: { orgId_userId: { orgId: org.id, userId: user.id } },
      data: { role: newRole },
    });
    await tx.auditLog.create({
      data: {
        orgId: org.id,
        actorUserId: null,
        action: "admin.member.role_change",
        target: user.id,
        metadata: JSON.stringify({
          from: currentRole,
          to: newRole,
          viaAdminCli: true,
        }),
      },
    });
  });

  return {
    orgId: org.id,
    orgSlug: org.slug,
    userId: user.id,
    email: user.email,
    from: currentRole,
    to: newRole,
  };
}
