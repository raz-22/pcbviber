-- Sprint 6 PR 6.6b: Row-Level Security + role split for tenant isolation.
--
-- This migration enables RLS on every tenant-scoped table. The runtime
-- application connects as `altium_app` — a role with no BYPASSRLS, no
-- DDL privileges, just CRUD on tables. The per-request tenant gate is
-- `set_config('app.current_org_id', <orgId>, true)` inside a transaction;
-- RLS policies filter rows by that setting. See `apps/server/src/db/
-- tenant-tx.ts` for the helper handlers wrap their queries with.
--
-- Migrations and admin scripts run as the table-owning role (e.g.
-- `postgres` locally, `neondb_owner` on Neon, whatever PG_ADMIN_USER
-- is on prod). Owners and BYPASSRLS roles are exempt from RLS by
-- definition, so DDL still works.
--
-- Tests: setupTestDatabase() applies migrations as admin (owner) and
-- by default tests run with admin grants — RLS is silently bypassed.
-- A dedicated test file (`apps/server/src/db/rls.test.ts`) connects
-- explicitly as `altium_app` to verify the policies actually block.

-- ── Role + grants (idempotent across re-runs / cluster restarts) ────
-- altium_app must exist as a cluster-wide role. Create it if missing.
-- Idempotent: PG 9.0+ has no IF NOT EXISTS on CREATE ROLE, so use
-- a DO block + pg_roles probe.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'altium_app') THEN
    -- NOLOGIN: tests + dev SET ROLE into it from an admin connection.
    -- Production wires altium_app with LOGIN + a password (or IAM
    -- auth) via an out-of-band step; the runbook in docker-compose.yml
    -- + .env.example documents how.
    CREATE ROLE altium_app NOLOGIN;
  END IF;
END
$$;

-- Grant admin-side membership in altium_app so the runner of this
-- migration can `SET ROLE altium_app` later (tests need this).
-- `WITH SET TRUE` is PG-16-specific and required on Neon: the
-- managed Postgres returns "permission denied to set role" without
-- the explicit option, even though the membership exists. GRANT is
-- idempotent — running it on every migrate is safe.
DO $$
BEGIN
  EXECUTE format('GRANT altium_app TO %I WITH SET TRUE', session_user);
END
$$;

-- Grants on the current schema for altium_app. `current_schema()` is
-- whatever schema this migration runs in (per-test schema in tests,
-- the configured schema in dev/prod). We grant CRUD on existing
-- tables AND set default privileges so future migrations' tables
-- inherit the same grants without a manual GRANT in each one.
DO $$
DECLARE
  s TEXT := current_schema();
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO altium_app', s);
  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO altium_app',
    s
  );
  -- Future tables created by later migrations: same grants by default.
  -- The `FOR ROLE session_user` clause scopes the rule to whatever
  -- role runs migrations; without it, the rule only matches tables
  -- created by the role that ran this DO block.
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES IN SCHEMA %I FOR ROLE %I '
    'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO altium_app',
    s,
    session_user
  );
END
$$;

-- ── RLS on tenant-scoped tables ─────────────────────────────────────
-- Every table that has an `orgId` column gets RLS. Policy: row's
-- orgId must equal the per-request `app.current_org_id` setting,
-- enforced both on read (USING) and on write (WITH CHECK).
--
-- `current_setting(name, missing_ok)` with missing_ok=true returns
-- NULL when the setting isn't defined. Comparing `"orgId" = NULL`
-- yields NULL → falsy in WHERE → rows hidden. Fail-closed by
-- default — a query with no SET LOCAL returns zero rows instead
-- of leaking everything.

-- Organization: keyed on `id` (it IS the tenant), not orgId.
ALTER TABLE "Organization" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Organization"
  USING ("id" = current_setting('app.current_org_id', true)::text)
  WITH CHECK ("id" = current_setting('app.current_org_id', true)::text);

ALTER TABLE "Membership" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Membership"
  USING ("orgId" = current_setting('app.current_org_id', true)::text)
  WITH CHECK ("orgId" = current_setting('app.current_org_id', true)::text);

ALTER TABLE "Workspace" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Workspace"
  USING ("orgId" = current_setting('app.current_org_id', true)::text)
  WITH CHECK ("orgId" = current_setting('app.current_org_id', true)::text);

ALTER TABLE "ApiKey" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ApiKey"
  USING ("orgId" = current_setting('app.current_org_id', true)::text)
  WITH CHECK ("orgId" = current_setting('app.current_org_id', true)::text);

ALTER TABLE "Subscription" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Subscription"
  USING ("orgId" = current_setting('app.current_org_id', true)::text)
  WITH CHECK ("orgId" = current_setting('app.current_org_id', true)::text);

ALTER TABLE "UsageEvent" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "UsageEvent"
  USING ("orgId" = current_setting('app.current_org_id', true)::text)
  WITH CHECK ("orgId" = current_setting('app.current_org_id', true)::text);

ALTER TABLE "Invite" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Invite"
  USING ("orgId" = current_setting('app.current_org_id', true)::text)
  WITH CHECK ("orgId" = current_setting('app.current_org_id', true)::text);

ALTER TABLE "AuditLog" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "AuditLog"
  USING ("orgId" = current_setting('app.current_org_id', true)::text)
  WITH CHECK ("orgId" = current_setting('app.current_org_id', true)::text);

-- Tables WITHOUT RLS in this PR:
--   User         — spans orgs (no orgId column); membership join
--                  would make every read more expensive. App layer
--                  enforces "user can only see themselves and their
--                  orgs' members" today; revisit if a future PR
--                  adds an orgId / Membership-based policy.
--   Plan         — shared resource (system-wide pricing tiers).
--   WebhookEvent — server-internal (Stripe webhooks); no tenant
--                  attribution at write time.
