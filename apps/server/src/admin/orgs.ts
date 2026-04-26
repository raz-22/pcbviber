/**
 * `orgs list` subcommand. Returns a row per Organization with a
 * member count. Sorted by createdAt asc (oldest first) — operators
 * usually want chronological context.
 *
 * Soft-deleted orgs (`deletedAt != null`) are excluded; soft-delete
 * is the documented "tenant gone" state. Hard delete is destructive
 * and not handled by this tool.
 */

import type { PrismaClient } from "@altium-mcp/db";

export interface OrgRow {
  id: string;
  slug: string;
  name: string;
  billingStatus: string;
  members: number;
}

export async function listOrgs(prisma: PrismaClient): Promise<OrgRow[]> {
  const rows = await prisma.organization.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      slug: true,
      name: true,
      billingStatus: true,
      _count: { select: { memberships: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    billingStatus: r.billingStatus,
    members: r._count.memberships,
  }));
}
