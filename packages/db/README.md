# @altium-mcp/db

Database schema, Prisma client, and credential encryption for the
Altium-MCP SaaS.

## What lives here

- `prisma/schema.prisma` — full tenant + billing schema (per
  the internal design spec §2.4).
- `src/index.ts` — singleton `PrismaClient` export plus re-exports of
  generated types.
- `src/encryption.ts` — AES-256-GCM helpers for workspace credentials
  at rest. Key source: `CREDENTIAL_ENCRYPTION_KEY` env var.
- `src/encryption.test.ts` — Node test-runner smoke tests. Run with
  `pnpm -F @altium-mcp/db test`.

## Quickstart (local dev, SQLite — no external services)

```bash
# 1. Generate a master encryption key and add it to the repo-root .env
node -e "console.log('CREDENTIAL_ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('base64'))" \
  >> .env

# 2. Point DATABASE_URL at a local SQLite file
echo "DATABASE_URL=file:./altium-mcp.dev.db" >> .env

# 3. Generate the Prisma client + run the first migration
pnpm -F @altium-mcp/db generate
pnpm -F @altium-mcp/db migrate:dev --name sprint-1-foundations

# 4. Inspect with Prisma Studio
pnpm -F @altium-mcp/db studio
```

## Production (Postgres 16)

Switch the datasource in `schema.prisma`:

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

Then:

```bash
DATABASE_URL=postgresql://...  pnpm -F @altium-mcp/db migrate:deploy
```

The schema is written to be provider-agnostic: no SQLite-specific types,
no Postgres-specific types in column definitions. `includedQuotas` is a
`String` today (JSON-in-string) so SQLite can hold it; switch to `Json`
in the same migration when moving to Postgres and re-run `migrate deploy`.

## Row-Level Security

Sprint 2 adds a migration that enables Postgres RLS on every table with
an `orgId` column. RLS is the second line of defense — the primary
tenant scoping is enforced by middleware in `packages/auth` (Sprint 2).

## Encryption

```ts
import { encryptCredential, decryptCredential } from "@altium-mcp/db";

const blob = encryptCredential("nexar-secret");  // stored in DB
const plain = decryptCredential(blob);            // in-memory only
```

- Never log decrypted values.
- Never return decrypted values from any API handler.
- Decryption only happens at the Nexar call site (see §5.1 of the
  instructions).
- Rotate the master key via the `v1` → `v2` version prefix path: ship a
  migration that decrypts with `v1`, re-encrypts with `v2`, retire `v1`
  after a grace period.

## Commands

```bash
pnpm -F @altium-mcp/db build          # prisma generate + tsc
pnpm -F @altium-mcp/db validate       # schema-only check (no DB needed)
pnpm -F @altium-mcp/db generate       # (re)generate the Prisma client
pnpm -F @altium-mcp/db migrate:dev    # apply new migrations in dev
pnpm -F @altium-mcp/db migrate:deploy # apply pending migrations in prod
pnpm -F @altium-mcp/db studio         # open Prisma Studio
pnpm -F @altium-mcp/db test           # encryption round-trip tests
```
