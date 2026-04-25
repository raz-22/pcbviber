-- Sprint 5 PR 5.3 — meter-push background job needs to track which
-- UsageEvent rows have already been pushed to Stripe, and which
-- subscription_item id to bill against per metric.

-- AlterTable
ALTER TABLE "UsageEvent" ADD COLUMN "pushedToStripeAt" DATETIME;

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN "meterItemIdsJson" TEXT;

-- CreateIndex (partial-style — SQLite doesn't have partial indexes
-- pre-3.8, but the orgId+pushedToStripeAt composite still helps the
-- meter-push job's `WHERE pushedToStripeAt IS NULL ORDER BY id` sweep)
CREATE INDEX "UsageEvent_orgId_pushedToStripeAt_idx" ON "UsageEvent"("orgId", "pushedToStripeAt");
