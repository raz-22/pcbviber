-- Sprint 7 PR 7.4: per-org IP allowlist.
--
-- JSON-encoded array of IP / CIDR strings. NULL or empty array
-- means "allowlist disabled" (current behavior — accept any IP).
-- Format mirrors Plan.includedQuotas: stringified JSON for
-- cross-DB portability + stable round-tripping.

ALTER TABLE "Organization" ADD COLUMN "ipAllowlistJson" TEXT;
