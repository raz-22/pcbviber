-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Organization" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "billingCustomerId" TEXT,
    "planId" TEXT,
    "billingStatus" TEXT NOT NULL DEFAULT 'free',
    "trialEndsAt" DATETIME,
    "billingMode" TEXT NOT NULL DEFAULT 'checkout',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" DATETIME,
    CONSTRAINT "Organization_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Organization" ("billingCustomerId", "createdAt", "deletedAt", "id", "name", "planId", "slug") SELECT "billingCustomerId", "createdAt", "deletedAt", "id", "name", "planId", "slug" FROM "Organization";
DROP TABLE "Organization";
ALTER TABLE "new_Organization" RENAME TO "Organization";
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");
CREATE INDEX "Organization_slug_idx" ON "Organization"("slug");
CREATE INDEX "Organization_createdAt_idx" ON "Organization"("createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
