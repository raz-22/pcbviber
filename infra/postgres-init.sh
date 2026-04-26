#!/usr/bin/env bash
# Postgres entrypoint init: create the second database used by tests.
# The default db (altium_dev) is created by Postgres's own entrypoint
# from POSTGRES_DB=altium_dev; this script just adds altium_test.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE DATABASE altium_test OWNER $POSTGRES_USER;
EOSQL
