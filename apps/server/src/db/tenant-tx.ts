/**
 * Per-request tenant-scoped transactions for RLS.
 *
 * Postgres RLS policies on tenant tables filter by
 * `current_setting('app.current_org_id', true)::text`. The setting
 * is request-scoped — set with `set_config(name, value, true)` inside
 * a transaction, where `is_local=true` scopes the value to the
 * transaction. After commit/rollback the setting is gone, so the
 * next request starts with no tenant context.
 *
 * Role split: the singleton Prisma client connects with admin
 * credentials (table owner) so DDL, signup, webhook handlers, and
 * other untrustable-context paths still work. Inside `withTenantTx`
 * we `SET LOCAL ROLE altium_app` for the duration of the transaction
 * — altium_app has no BYPASSRLS, so RLS policies bind. After commit
 * the role reverts. This keeps deployment to a single DATABASE_URL
 * while still getting per-request RLS enforcement; the alternative
 * (separate admin + app DATABASE_URLs) is more invasive.
 *
 * Handlers that touch tenant-scoped tables (Membership / Workspace /
 * ApiKey / Subscription / UsageEvent / Invite / AuditLog /
 * Organization) MUST wrap their DB access in `withTenantTx`. Using
 * the global `prisma` client directly bypasses RLS (queries run as
 * the admin role with no tenant context — visible-but-unfiltered).
 *
 * The application-layer `requireOrgRole` middleware is still the
 * primary tenant gate. RLS is defense in depth: a handler that
 * forgets to filter `where: { orgId: ctx.org.id }` and uses
 * `withTenantTx` no longer leaks other tenants' rows — RLS returns
 * an empty set instead. A handler that ALSO forgets withTenantTx
 * is the same exposure as before this PR; verify both.
 */

import type { Prisma } from "@altium-mcp/db";
import { prisma } from "@altium-mcp/db";

/**
 * Run `fn` inside a Prisma transaction scoped to `orgId`. Inside the
 * transaction:
 *
 *   - `app.current_org_id` is set to `orgId` (RLS policies match on it)
 *   - the role is dropped to `altium_app` (no BYPASSRLS, so RLS binds)
 *
 * Both revert on commit/rollback. Returns whatever `fn` returns; if
 * `fn` throws, the transaction rolls back.
 *
 * `set_config(name, value, is_local)` is a parameterized call (not
 * a literal `SET LOCAL`), so the orgId can never be smuggled via
 * SQL injection — Prisma's tagged-template tag passes `orgId` as a
 * bound parameter.
 */
export async function withTenantTx<T>(
  orgId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  return await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_org_id', ${orgId}, true)`;
    // Drop privileges for the rest of this transaction. Postgres
    // requires the session role to be a member of `altium_app` WITH
    // SET TRUE; the RLS migration handles that. SET LOCAL ROLE is
    // not parameterizable, but `altium_app` is a fixed identifier
    // we control — no injection surface.
    await tx.$executeRawUnsafe("SET LOCAL ROLE altium_app");
    return await fn(tx);
  });
}
