/**
 * CLI entry: `pnpm -F @altium-mcp/metering seed:plans`.
 *
 * Reads STRIPE_PRICE_* from the env (already loaded by the dotenv
 * wrapper in package.json) and upserts Plan rows. Idempotent —
 * re-running it picks up rotated Stripe Price IDs without resetting
 * existing orgs.
 */

import { prisma } from "@altium-mcp/db";
import { seedPlans } from "./seed.js";

async function main(): Promise<void> {
  const result = await seedPlans(prisma);
  console.log(`seed-plans: upserted ${result.upserted} plan rows`);
}

main()
  .catch((err) => {
    console.error("seed-plans failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
