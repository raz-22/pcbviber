#!/usr/bin/env bash
# Postgres entrypoint init.
#
# Runs once when the postgres data volume is empty. Creates:
#   - altium_test database (alongside altium_dev, which the entrypoint
#     creates from POSTGRES_DB)
#   - altium_app role: the runtime role for the application. Has no
#     BYPASSRLS, no DDL privileges. The migration in
#     packages/db/prisma/migrations/<ts>_rls_policies/ grants it CRUD
#     on the public schema and creates RLS policies; this script just
#     gets the role into existence so the migration's `GRANT ... TO
#     altium_app` works on first deploy.
#
# Wipe with `docker-compose down -v` to re-trigger this on next up.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE DATABASE altium_test OWNER $POSTGRES_USER;

  -- altium_app: NOLOGIN here — the application role for SET ROLE
  -- usage in tests. For prod deployments where the app connects
  -- DIRECTLY as altium_app (rather than admin + SET ROLE), wire up
  -- LOGIN + a password via your secrets manager and ALTER ROLE
  -- altium_app LOGIN PASSWORD '...'. Dev compose stays NOLOGIN
  -- because dev queries from the host run as $POSTGRES_USER and
  -- SET ROLE for RLS exercises.
  CREATE ROLE altium_app NOLOGIN;

  -- $POSTGRES_USER becomes a member of altium_app WITH SET TRUE so
  -- it can SET ROLE altium_app for ad-hoc psql sessions. Migrations
  -- run as $POSTGRES_USER and re-issue the same grant idempotently.
  GRANT altium_app TO $POSTGRES_USER WITH SET TRUE;
EOSQL
