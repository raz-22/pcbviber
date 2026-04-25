/**
 * Tests for resolveQuotaForOrg — the four-step chain that turns an
 * org snapshot + optional subscription + env price map into a
 * PlanSnapshot + Period.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PLAN_DEFAULTS,
  priceMapFromEnv,
  resolveQuotaForOrg,
  UNLIMITED,
} from "./plan-resolver.js";

const NOW = new Date("2026-04-15T00:00:00Z");

const ORG = {
  id: "org-1",
  createdAt: new Date("2026-01-15T00:00:00Z"),
  billingStatus: "free",
};

test("uses the linked Plan row when subscription has one", async () => {
  const result = await resolveQuotaForOrg({
    org: ORG,
    subscription: {
      planId: "plan-team",
      stripePriceId: null,
      status: "active",
      currentPeriodStart: new Date("2026-04-01T00:00:00Z"),
      currentPeriodEnd: new Date("2026-05-01T00:00:00Z"),
      plan: {
        name: "team",
        includedQuotas: JSON.stringify({
          bom_lookup: 5_000,
          cost_analysis: 500,
          export: 100,
        }),
      },
    },
    findPlanByName: async () => null,
    priceMap: {},
    now: NOW,
  });
  assert.equal(result.plan.name, "team");
  assert.equal(result.plan.quotas.bom_lookup, 5_000);
  assert.equal(result.plan.overageAllowed, true);
  // Period comes from the Stripe window, not the synthesized monthly.
  assert.equal(result.period.start.toISOString(), "2026-04-01T00:00:00.000Z");
});

test("falls back to env price map when subscription has stripePriceId only", async () => {
  // No planId, no plan relation, but stripePriceId matches the
  // STRIPE_PRICE_TEAM_SEAT env variable. Resolver looks up the row
  // by name; here findPlanByName returns the seeded row.
  const result = await resolveQuotaForOrg({
    org: ORG,
    subscription: {
      planId: null,
      stripePriceId: "price_team_xyz",
      status: "active",
      currentPeriodStart: new Date("2026-04-01T00:00:00Z"),
      currentPeriodEnd: new Date("2026-05-01T00:00:00Z"),
      plan: null,
    },
    findPlanByName: async (name) =>
      name === "team"
        ? {
            name: "team",
            includedQuotas: JSON.stringify({
              bom_lookup: 5_000,
              cost_analysis: 500,
              export: 100,
            }),
          }
        : null,
    priceMap: { price_team_xyz: "team" },
    now: NOW,
  });
  assert.equal(result.plan.name, "team");
  assert.equal(result.plan.quotas.bom_lookup, 5_000);
});

test("env mapping falls through to PLAN_DEFAULTS when row not seeded", async () => {
  // Production seeds Plan rows on deploy, but a fresh staging env
  // may not have them yet. Resolver returns the hardcoded snapshot
  // so metering keeps working.
  const result = await resolveQuotaForOrg({
    org: ORG,
    subscription: {
      planId: null,
      stripePriceId: "price_starter_abc",
      status: "active",
      currentPeriodStart: null,
      currentPeriodEnd: null,
      plan: null,
    },
    findPlanByName: async () => null, // not seeded
    priceMap: { price_starter_abc: "starter" },
    now: NOW,
  });
  assert.equal(result.plan.name, "starter");
  assert.equal(result.plan.quotas.bom_lookup, 500);
  assert.equal(result.plan.overageAllowed, true);
});

test("trialing org with no subscription gets team-equivalent quotas", async () => {
  const result = await resolveQuotaForOrg({
    org: { ...ORG, billingStatus: "trialing" },
    subscription: null,
    findPlanByName: async () => null,
    priceMap: {},
    now: NOW,
  });
  assert.equal(result.plan.name, "trialing");
  assert.equal(result.plan.quotas.bom_lookup, 5_000);
  assert.equal(result.plan.overageAllowed, false);
});

test("free org with no subscription gets the free defaults", async () => {
  const result = await resolveQuotaForOrg({
    org: { ...ORG, billingStatus: "free" },
    subscription: null,
    findPlanByName: async () => null,
    priceMap: {},
    now: NOW,
  });
  assert.equal(result.plan.name, "free");
  assert.equal(result.plan.quotas.bom_lookup, 100);
  assert.equal(result.plan.overageAllowed, false);
});

test("synthesizes a monthly period from org.createdAt when no subscription window", async () => {
  // Org created Jan 15; "now" is Apr 15 → window is Apr 15 → May 15.
  const result = await resolveQuotaForOrg({
    org: ORG,
    subscription: null,
    findPlanByName: async () => null,
    priceMap: {},
    now: NOW,
  });
  assert.equal(result.period.start.toISOString(), "2026-04-15T00:00:00.000Z");
  assert.equal(result.period.end.toISOString(), "2026-05-15T00:00:00.000Z");
});

test("malformed includedQuotas JSON falls back to PLAN_DEFAULTS", async () => {
  // Defense in depth: a corrupt JSON string in the DB must not
  // bypass quota or crash the request. Resolver returns the
  // hardcoded snapshot keyed on the plan row's name.
  const result = await resolveQuotaForOrg({
    org: ORG,
    subscription: {
      planId: "plan-corrupt",
      stripePriceId: null,
      status: "active",
      currentPeriodStart: null,
      currentPeriodEnd: null,
      plan: { name: "team", includedQuotas: "{not valid json" },
    },
    findPlanByName: async () => null,
    priceMap: {},
    now: NOW,
  });
  // Plan row was rejected; chain falls through to billingStatus
  // default ("free" since org.billingStatus === "free").
  assert.equal(result.plan.name, "free");
});

test("includedQuotas missing required keys falls back", async () => {
  const result = await resolveQuotaForOrg({
    org: ORG,
    subscription: {
      planId: "plan-partial",
      stripePriceId: null,
      status: "active",
      currentPeriodStart: null,
      currentPeriodEnd: null,
      plan: {
        name: "starter",
        includedQuotas: JSON.stringify({ bom_lookup: 100 }), // missing cost/export
      },
    },
    findPlanByName: async () => null,
    priceMap: {},
    now: NOW,
  });
  assert.equal(result.plan.name, "free");
});

test("PLAN_DEFAULTS values match spec §1 quotas", () => {
  assert.equal(PLAN_DEFAULTS.starter!.quotas.bom_lookup, 500);
  assert.equal(PLAN_DEFAULTS.starter!.quotas.cost_analysis, 50);
  assert.equal(PLAN_DEFAULTS.starter!.quotas.export, 10);
  assert.equal(PLAN_DEFAULTS.team!.quotas.bom_lookup, 5_000);
  assert.equal(PLAN_DEFAULTS.team!.quotas.cost_analysis, 500);
  assert.equal(PLAN_DEFAULTS.team!.quotas.export, 100);
  // Enterprise = unlimited sentinel.
  assert.equal(PLAN_DEFAULTS.enterprise!.quotas.bom_lookup, UNLIMITED);
});

test("free + trialing have overageAllowed=false; paid plans true", () => {
  assert.equal(PLAN_DEFAULTS.free!.overageAllowed, false);
  assert.equal(PLAN_DEFAULTS.trialing!.overageAllowed, false);
  assert.equal(PLAN_DEFAULTS.starter!.overageAllowed, true);
  assert.equal(PLAN_DEFAULTS.team!.overageAllowed, true);
  assert.equal(PLAN_DEFAULTS.enterprise!.overageAllowed, true);
});

test("priceMapFromEnv reads STRIPE_PRICE_STARTER_SEAT and STRIPE_PRICE_TEAM_SEAT", () => {
  const map = priceMapFromEnv({
    STRIPE_PRICE_STARTER_SEAT: "price_starter",
    STRIPE_PRICE_TEAM_SEAT: "price_team",
    OTHER: "ignored",
  } as NodeJS.ProcessEnv);
  assert.equal(map.price_starter, "starter");
  assert.equal(map.price_team, "team");
  assert.equal(Object.keys(map).length, 2);
});

test("priceMapFromEnv skips empty / whitespace-only values", () => {
  // Same env-blank handling as selectBillingProvider — a literally
  // empty STRIPE_PRICE_TEAM_SEAT= line in .env shouldn't poison the
  // resolver into mapping "" → "team".
  const map = priceMapFromEnv({
    STRIPE_PRICE_STARTER_SEAT: "",
    STRIPE_PRICE_TEAM_SEAT: "   ",
  } as NodeJS.ProcessEnv);
  assert.equal(Object.keys(map).length, 0);
});
