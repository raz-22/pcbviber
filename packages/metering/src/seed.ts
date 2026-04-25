/**
 * Plan-row seeder. Writes the three canonical plans (starter, team,
 * enterprise) with quotas drawn from PLAN_DEFAULTS so prod / staging
 * rows stay byte-identical to the in-code fallback.
 *
 * Idempotent: each row is upserted by `name` (the unique column).
 * Re-running it is safe and is the intended deploy step — Stripe
 * Price IDs are pulled from env at upsert time so price rotations
 * propagate without code changes.
 *
 * "free" and "trialing" are NOT seeded as Plan rows — they're
 * billingStatus values, not subscription targets. The resolver
 * falls back to PLAN_DEFAULTS["free"] / ["trialing"] when an org
 * has no Subscription row.
 */

import type { PrismaClient } from "@altium-mcp/db";
import { PLAN_DEFAULTS } from "./plan-resolver.js";

export interface SeedPlansEnv {
  STRIPE_PRICE_STARTER_SEAT?: string;
  STRIPE_PRICE_TEAM_SEAT?: string;
  STRIPE_PRICE_METER_BOM?: string;
  STRIPE_PRICE_METER_COST?: string;
  STRIPE_PRICE_METER_EXPORT?: string;
}

const PLANS_TO_SEED: ReadonlyArray<{
  name: string;
  seatPriceEnvVar: keyof SeedPlansEnv | null;
  seatLimit: number;
}> = [
  { name: "starter", seatPriceEnvVar: "STRIPE_PRICE_STARTER_SEAT", seatLimit: 3 },
  { name: "team", seatPriceEnvVar: "STRIPE_PRICE_TEAM_SEAT", seatLimit: 20 },
  // Enterprise has custom pricing — no env-mapped seat price; seed
  // a Plan row anyway so admin tooling can pin orgs to it manually.
  { name: "enterprise", seatPriceEnvVar: null, seatLimit: 0 },
];

export async function seedPlans(
  client: PrismaClient,
  env: SeedPlansEnv = process.env as SeedPlansEnv
): Promise<{ upserted: number }> {
  let upserted = 0;
  for (const spec of PLANS_TO_SEED) {
    const defaults = PLAN_DEFAULTS[spec.name];
    if (!defaults) {
      throw new Error(`seedPlans: missing PLAN_DEFAULTS["${spec.name}"]`);
    }
    const seatPriceId =
      spec.seatPriceEnvVar && env[spec.seatPriceEnvVar]?.trim()
        ? env[spec.seatPriceEnvVar]!.trim()
        : null;
    const meterBomPriceId = env.STRIPE_PRICE_METER_BOM?.trim() || null;
    const meterCostPriceId = env.STRIPE_PRICE_METER_COST?.trim() || null;
    const meterExportPriceId = env.STRIPE_PRICE_METER_EXPORT?.trim() || null;

    await client.plan.upsert({
      where: { name: spec.name },
      update: {
        seatPriceId,
        meterBomPriceId,
        meterCostPriceId,
        meterExportPriceId,
        includedQuotas: JSON.stringify(defaults.quotas),
        seatLimit: spec.seatLimit,
      },
      create: {
        name: spec.name,
        seatPriceId,
        meterBomPriceId,
        meterCostPriceId,
        meterExportPriceId,
        includedQuotas: JSON.stringify(defaults.quotas),
        seatLimit: spec.seatLimit,
      },
    });
    upserted += 1;
  }
  return { upserted };
}
