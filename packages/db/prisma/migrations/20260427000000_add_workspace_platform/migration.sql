-- Sprint 9 PR 9.2: workspace platform model.
--
-- Each workspace targets a single EDA platform. "altium" covers
-- both Altium 365 (cloud) and the Altium Designer relay (local);
-- "easyeda" is added for EasyEDA Pro support. Future EDAs (KiCad,
-- Eagle, Fusion 360) extend the runtime allowlist; no schema change
-- needed. String column with runtime-validated allowlist mirrors
-- Membership.role and Organization.billingStatus.
--
-- Default "altium" backfills every existing workspace correctly:
-- everything in production today is targeting Altium.

ALTER TABLE "Workspace"
  ADD COLUMN "platform" TEXT NOT NULL DEFAULT 'altium';
