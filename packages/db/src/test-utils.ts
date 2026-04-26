/**
 * Per-test-file ephemeral Postgres bootstrap.
 *
 * Each test file calls `setupTestDatabase()` in its `before()` hook
 * and `teardown()` in `after()`. The helper:
 *
 *   1. Reads `TEST_DATABASE_URL` (a Postgres connection string the
 *      caller already has — Neon, RDS, docker-compose, whatever).
 *   2. Picks a unique schema name (`t_<random>`) and creates it.
 *   3. Sets `process.env.DATABASE_URL` to the same base URL with
 *      `?schema=t_<random>` appended.
 *   4. Reads the committed migration SQL from `prisma/migrations/`
 *      and applies each file in order against the new schema, on
 *      a single short-lived connection.
 *   5. Returns a teardown that drops the schema CASCADE.
 *
 * Why per-schema instead of per-database:
 *   - `CREATE DATABASE` requires no other connections to the target
 *     and can't run inside a transaction; schemas are cheaper.
 *   - Test files run in parallel via `node --test`; isolated schemas
 *     are the cleanest way to keep their tables apart without each
 *     file owning its own DB.
 *
 * Why apply migration SQL directly instead of `prisma migrate deploy`:
 *   - The CLI takes 3-7s of cold-start per call (binary load, schema
 *     parse, advisory-lock acquire). Across 22 test files that's
 *     a minute of pure overhead.
 *   - More importantly, `prisma migrate deploy` takes a *database-
 *     scope* `pg_advisory_lock`, so 22 concurrent invocations
 *     serialize on it. On free-tier Postgres (Neon) the queue often
 *     blows past the lock timeout. Direct SQL has no advisory lock
 *     and parallelizes freely.
 *
 * Tradeoff: the test schema doesn't get a `_prisma_migrations`
 * history row. That's fine — tests verify behavior, not migration
 * bookkeeping; CI also runs `pnpm -F @altium-mcp/db migrate:deploy`
 * separately to exercise the real migrate path.
 *
 * The helper does NOT touch `CREDENTIAL_ENCRYPTION_KEY` or other
 * env vars — each test sets its own, since some need WorkOS off
 * and others need it on.
 */

import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
// HERE is `packages/db/build/` after compile. The package root is one up.
const PACKAGE_ROOT = join(HERE, "..");
const MIGRATIONS_DIR = join(PACKAGE_ROOT, "prisma", "migrations");

export interface TestDatabaseSetup {
  /** The DATABASE_URL the test should use (already set on process.env). */
  databaseUrl: string;
  /** The unique schema name created for this test file. */
  schema: string;
  /** Drop the schema. Idempotent on the second call. */
  teardown: () => Promise<void>;
}

/** Read every migration's `migration.sql` in lexicographic order. */
function loadMigrationSql(): string[] {
  const entries = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  return entries.map((dir) =>
    readFileSync(join(MIGRATIONS_DIR, dir, "migration.sql"), "utf8")
  );
}

/**
 * Set up an isolated Postgres schema for the calling test file.
 *
 * Side effect: sets `process.env.DATABASE_URL` so any subsequent
 * `import("@altium-mcp/db")` constructs a PrismaClient pointing at
 * the new schema. Tests that need this MUST dynamic-import after
 * calling setupTestDatabase().
 *
 * Throws if `TEST_DATABASE_URL` is unset — there is no implicit
 * default. CI sets it via the Postgres service container; dev sets
 * it via .env.test.
 */
export async function setupTestDatabase(): Promise<TestDatabaseSetup> {
  const baseUrl = process.env.TEST_DATABASE_URL;
  if (!baseUrl) {
    throw new Error(
      "TEST_DATABASE_URL is not set. See docker-compose.yml + .env.example."
    );
  }
  const schema = `t_${randomBytes(6).toString("hex")}`;
  const u = new URL(baseUrl);
  // Connection-string params Prisma understands: schema is the
  // important one. Keep `sslmode` etc. as-is.
  u.searchParams.set("schema", schema);
  const databaseUrl = u.toString();

  const migrations = loadMigrationSql();

  // One short-lived admin connection: create schema, set
  // search_path, apply each migration. The qualified `"public"`
  // search_path entry keeps Postgres's built-in functions reachable
  // (now(), gen_random_uuid(), etc.) — most test schemas don't need
  // them, but it's free and survives migrations that do.
  await withPgClient(baseUrl, async (client) => {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}", public`);
    for (const sql of migrations) {
      // Each migration file is a multi-statement script. node-postgres
      // executes them as one batch when there are no parameters.
      await client.query(sql);
    }
  });

  process.env.DATABASE_URL = databaseUrl;

  let dropped = false;
  return {
    databaseUrl,
    schema,
    teardown: async () => {
      if (dropped) return;
      dropped = true;
      await withPgClient(baseUrl, async (client) => {
        await client.query(`DROP SCHEMA "${schema}" CASCADE`);
      });
    },
  };
}

async function withPgClient(
  connectionString: string,
  fn: (c: pg.Client) => Promise<void>
): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await fn(client);
  } finally {
    await client.end();
  }
}
