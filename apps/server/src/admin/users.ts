/**
 * `users list` subcommand. Returns a row per User with their org
 * membership count. `--email <substr>` filters case-insensitively
 * with `Prisma.contains` — useful for narrowing to one user
 * without typing the full address.
 */

import type { PrismaClient } from "@altium-mcp/db";

export interface UserRow {
  id: string;
  email: string;
  memberships: number;
}

export interface ListUsersOptions {
  emailContains?: string;
}

export async function listUsers(
  prisma: PrismaClient,
  opts: ListUsersOptions = {}
): Promise<UserRow[]> {
  const rows = await prisma.user.findMany({
    where: opts.emailContains
      ? { email: { contains: opts.emailContains, mode: "insensitive" } }
      : undefined,
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      email: true,
      _count: { select: { memberships: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    memberships: r._count.memberships,
  }));
}
