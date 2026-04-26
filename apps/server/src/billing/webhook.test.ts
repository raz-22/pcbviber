/**
 * Stripe webhook handler tests.
 *
 * The provider's verifyWebhook is stubbed: any signature header
 * value is accepted, and the test sets `capture.event` to whatever
 * event payload it wants the route to receive. Tests exercising the
 * 400 path set `capture.event = "invalid"` so the stub throws.
 *
 * Pins:
 *   - 400 on missing / invalid signature; 503 when provider is Noop
 *   - Idempotency: same event.id replayed → no double effect
 *   - checkout.session.completed: signed clientRef binds org;
 *     tampered or missing clientRef does NOT bind any org
 *   - subscription.updated: status / seats / period mirror to local
 *   - subscription.deleted: org → canceled
 *   - invoice.payment_succeeded: org → active (recovers from past_due)
 *   - invoice.payment_failed: org → past_due
 *   - Unknown event types ack with 200, no DB write beyond the
 *     idempotency row
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { setupTestDatabase } from "@altium-mcp/db/test-utils";

import Fastify, { type FastifyInstance } from "fastify";

import {
  makeBillingSigner,
  BillingNotConfigured,
  WebhookSignatureInvalid,
  type BillingProvider,
  type BillingSigner,
  type WebhookEvent,
} from "@altium-mcp/billing";

const SIGNING_SECRET = randomBytes(32);
const signer: BillingSigner = makeBillingSigner(SIGNING_SECRET);

let app: FastifyInstance;
let teardown: () => Promise<void>;
let testOrgId: string;

const capture: {
  event: WebhookEvent | "invalid" | "not_configured" | null;
  isConfigured: boolean;
} = { event: null, isConfigured: true };

const stubBilling: BillingProvider = {
  isConfigured: () => capture.isConfigured,
  createCheckoutSession: async () => {
    throw new Error("not used by webhook tests");
  },
  createPortalSession: async () => {
    throw new Error("not used by webhook tests");
  },
  verifyWebhook: (_rawBody, _signature) => {
    if (capture.event === "invalid") {
      throw new WebhookSignatureInvalid("test invalid sig");
    }
    if (capture.event === "not_configured") {
      throw new BillingNotConfigured();
    }
    if (!capture.event) {
      throw new Error("test must set capture.event before request");
    }
    return capture.event;
  },
  recordUsage: async () => {
    throw new Error("recordUsage not used by webhook tests");
  },
};

before(async () => {
  ({ teardown } = await setupTestDatabase());
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");

  const { registerBillingWebhookRoute } = await import("./webhook.js");

  app = Fastify({ logger: false });
  await registerBillingWebhookRoute(app, { billing: stubBilling, signer });
  await app.ready();

  // Seed an org we can bind events to. Trial state — webhook should
  // flip it to active on checkout.session.completed.
  const { prisma } = await import("@altium-mcp/db");
  const org = await prisma.organization.create({
    data: {
      name: "Webhook Test Org",
      slug: `webhook-test-${randomBytes(3).toString("hex")}`,
      billingStatus: "trialing",
      trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    },
  });
  testOrgId = org.id;
});

after(async () => {
  if (app) await app.close();
  const { prisma } = await import("@altium-mcp/db");
  await prisma.$disconnect();
  await teardown();
});

function reset(opts: Partial<typeof capture> = {}) {
  capture.event = null;
  capture.isConfigured = true;
  Object.assign(capture, opts);
}

function postWebhook(body: object, signature: string | null = "test-sig") {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (signature !== null) headers["stripe-signature"] = signature;
  return app.inject({
    method: "POST",
    url: "/api/billing/webhook",
    headers,
    payload: JSON.stringify(body),
  });
}

// ═══ Signature / configuration ══════════════════════════════════════════

test("webhook: 400 when stripe-signature header is missing", async () => {
  reset();
  const res = await postWebhook({ id: "evt_x", type: "x" }, null);
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "webhook_signature_invalid");
});

test("webhook: 400 when verifyWebhook throws WebhookSignatureInvalid", async () => {
  reset({ event: "invalid" });
  const res = await postWebhook({ id: "evt_x", type: "x" });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "webhook_signature_invalid");
});

test("webhook: 503 when provider is Noop / verifyWebhook throws BillingNotConfigured", async () => {
  reset({ event: "not_configured" });
  const res = await postWebhook({ id: "evt_x", type: "x" });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error, "billing_not_configured");
});

// ═══ Idempotency ════════════════════════════════════════════════════════

test("webhook: replay of the same event.id returns idempotent ack", async () => {
  reset({
    event: { id: "evt_replay_1", type: "ping.unknown", data: { object: {} } },
  });
  const first = await postWebhook({});
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().received, true);
  // idempotent flag is FALSE on first delivery; the row gets inserted.

  // Replay (same event.id, fresh request).
  reset({
    event: { id: "evt_replay_1", type: "ping.unknown", data: { object: {} } },
  });
  const second = await postWebhook({});
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().idempotent, true);

  // Only one WebhookEvent row exists for that id.
  const { prisma } = await import("@altium-mcp/db");
  const rows = await prisma.webhookEvent.findMany({
    where: { stripeEventId: "evt_replay_1" },
  });
  assert.equal(rows.length, 1);
});

test("webhook: unknown event type acks 200 + records WebhookEvent", async () => {
  // Unknown types are acknowledged so Stripe stops retrying. The
  // idempotency row is still recorded so a second delivery short-
  // circuits.
  reset({
    event: { id: "evt_unknown_1", type: "no.handler.for.this", data: { object: {} } },
  });
  const res = await postWebhook({});
  assert.equal(res.statusCode, 200);
  const { prisma } = await import("@altium-mcp/db");
  const row = await prisma.webhookEvent.findUnique({
    where: { stripeEventId: "evt_unknown_1" },
  });
  assert.ok(row);
  assert.equal(row.eventType, "no.handler.for.this");
});

// ═══ checkout.session.completed ═════════════════════════════════════════

test("webhook checkout.session.completed: signed clientRef binds org → active + sub created", async () => {
  reset();
  const clientRef = signer.sign({
    orgId: testOrgId,
    priceId: "price_team_seat_test",
    seats: 5,
  });
  capture.event = {
    id: "evt_checkout_happy",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_happy",
        client_reference_id: clientRef,
        customer: "cus_happy_123",
        subscription: "sub_happy_123",
      },
    },
  };
  const res = await postWebhook({});
  assert.equal(res.statusCode, 200);

  const { prisma } = await import("@altium-mcp/db");
  const org = await prisma.organization.findUnique({ where: { id: testOrgId } });
  assert.equal(org?.billingStatus, "active");
  assert.equal(org?.billingCustomerId, "cus_happy_123");
  // Trial is over once paid — deadline cleared.
  assert.equal(org?.trialEndsAt, null);

  const sub = await prisma.subscription.findUnique({
    where: { stripeSubId: "sub_happy_123" },
  });
  assert.ok(sub);
  assert.equal(sub.orgId, testOrgId);
  assert.equal(sub.stripePriceId, "price_team_seat_test");
  assert.equal(sub.seats, 5);
  assert.equal(sub.status, "active");
});

test("webhook checkout.session.completed: TAMPERED clientRef does NOT bind any org", async () => {
  // The most important security-side test in this file. An attacker
  // who can replay or forge a webhook payload must NOT be able to
  // bind a Stripe sub to an arbitrary org by editing the
  // client_reference_id. The signature is what gates this.
  const { prisma } = await import("@altium-mcp/db");
  // Spin up a victim org we'd care about not getting bound.
  const victim = await prisma.organization.create({
    data: {
      name: "Victim",
      slug: `victim-${randomBytes(3).toString("hex")}`,
      billingStatus: "trialing",
    },
  });

  // Take a legit signed ref (for testOrgId) and swap the orgId field
  // to the victim's. Without re-signing, the tag won't match.
  const legitRef = signer.sign({
    orgId: testOrgId,
    priceId: "price_x",
    seats: 1,
  });
  const parts = legitRef.split("|");
  parts[0] = victim.id;
  const tampered = parts.join("|");

  reset();
  capture.event = {
    id: "evt_checkout_tampered",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_tampered",
        client_reference_id: tampered,
        customer: "cus_attacker_456",
        subscription: "sub_attacker_456",
      },
    },
  };
  const res = await postWebhook({});
  // Endpoint acks (we record the WebhookEvent for idempotency) but
  // does nothing else.
  assert.equal(res.statusCode, 200);

  // Victim org is UNCHANGED — still trialing, no customerId set.
  const after = await prisma.organization.findUnique({ where: { id: victim.id } });
  assert.equal(after?.billingStatus, "trialing");
  assert.equal(after?.billingCustomerId, null);

  // No subscription row was created for the bogus stripeSubId.
  const sub = await prisma.subscription.findUnique({
    where: { stripeSubId: "sub_attacker_456" },
  });
  assert.equal(sub, null);
});

test("webhook checkout.session.completed: MISSING clientRef is ignored (no org bound)", async () => {
  reset();
  capture.event = {
    id: "evt_checkout_missing",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_missing",
        // client_reference_id intentionally undefined.
        customer: "cus_missing_789",
        subscription: "sub_missing_789",
      },
    },
  };
  const res = await postWebhook({});
  assert.equal(res.statusCode, 200);
  const { prisma } = await import("@altium-mcp/db");
  const sub = await prisma.subscription.findUnique({
    where: { stripeSubId: "sub_missing_789" },
  });
  assert.equal(sub, null);
});

// ═══ customer.subscription.updated ══════════════════════════════════════

test("webhook customer.subscription.updated: status + seats + period mirror to local", async () => {
  // Pre-condition: previous test created sub_happy_123. Update it.
  reset();
  capture.event = {
    id: "evt_sub_updated_1",
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_happy_123",
        status: "past_due",
        items: { data: [{ price: { id: "price_team_seat_test" }, quantity: 7 }] },
        current_period_start: 1735689600, // 2025-01-01T00:00:00Z
        current_period_end: 1738368000, // 2025-02-01T00:00:00Z
      },
    },
  };
  const res = await postWebhook({});
  assert.equal(res.statusCode, 200);

  const { prisma } = await import("@altium-mcp/db");
  const sub = await prisma.subscription.findUnique({
    where: { stripeSubId: "sub_happy_123" },
  });
  assert.equal(sub?.status, "past_due");
  assert.equal(sub?.seats, 7);
  assert.equal(sub?.currentPeriodStart?.toISOString(), "2025-01-01T00:00:00.000Z");
  assert.equal(sub?.currentPeriodEnd?.toISOString(), "2025-02-01T00:00:00.000Z");

  // Org status mirrors.
  const org = await prisma.organization.findUnique({ where: { id: testOrgId } });
  assert.equal(org?.billingStatus, "past_due");
});

test("webhook customer.subscription.updated: ignored when stripeSubId is unknown", async () => {
  reset();
  capture.event = {
    id: "evt_sub_updated_unknown",
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_does_not_exist_in_db",
        status: "active",
        items: { data: [{ price: { id: "x" }, quantity: 1 }] },
      },
    },
  };
  const res = await postWebhook({});
  // Acked — Stripe shouldn't retry. The local view of orgs is
  // unchanged.
  assert.equal(res.statusCode, 200);
});

// ═══ customer.subscription.deleted ══════════════════════════════════════

test("webhook customer.subscription.deleted: org → canceled", async () => {
  reset();
  capture.event = {
    id: "evt_sub_deleted_1",
    type: "customer.subscription.deleted",
    data: { object: { id: "sub_happy_123" } },
  };
  const res = await postWebhook({});
  assert.equal(res.statusCode, 200);

  const { prisma } = await import("@altium-mcp/db");
  const org = await prisma.organization.findUnique({ where: { id: testOrgId } });
  assert.equal(org?.billingStatus, "canceled");
  const sub = await prisma.subscription.findUnique({
    where: { stripeSubId: "sub_happy_123" },
  });
  assert.equal(sub?.status, "canceled");
});

// ═══ invoice.payment_succeeded / .failed ════════════════════════════════

test("webhook invoice.payment_failed: org → past_due via subscription lookup", async () => {
  // Re-create an active subscription for testOrgId to drive the
  // failed-payment path against (the previous test canceled it).
  const { prisma } = await import("@altium-mcp/db");
  await prisma.subscription.upsert({
    where: { stripeSubId: "sub_active_for_invoice" },
    create: {
      orgId: testOrgId,
      stripeSubId: "sub_active_for_invoice",
      stripePriceId: "price_x",
      seats: 1,
      status: "active",
    },
    update: { status: "active" },
  });
  await prisma.organization.update({
    where: { id: testOrgId },
    data: { billingStatus: "active" },
  });

  reset();
  capture.event = {
    id: "evt_invoice_failed_1",
    type: "invoice.payment_failed",
    data: {
      object: {
        id: "in_failed_1",
        subscription: "sub_active_for_invoice",
      },
    },
  };
  const res = await postWebhook({});
  assert.equal(res.statusCode, 200);

  const org = await prisma.organization.findUnique({ where: { id: testOrgId } });
  assert.equal(org?.billingStatus, "past_due");
});

test("webhook invoice.payment_succeeded: org → active (recovers from past_due)", async () => {
  // Previous test left org in past_due. Now a successful retry
  // should clear it.
  reset();
  capture.event = {
    id: "evt_invoice_succeeded_1",
    type: "invoice.payment_succeeded",
    data: {
      object: {
        id: "in_succeeded_1",
        subscription: "sub_active_for_invoice",
      },
    },
  };
  const res = await postWebhook({});
  assert.equal(res.statusCode, 200);

  const { prisma } = await import("@altium-mcp/db");
  const org = await prisma.organization.findUnique({ where: { id: testOrgId } });
  assert.equal(org?.billingStatus, "active");
});

test("webhook invoice with no matching subscription is acked but no-op", async () => {
  reset();
  capture.event = {
    id: "evt_invoice_orphan",
    type: "invoice.payment_failed",
    data: {
      object: {
        id: "in_orphan",
        subscription: "sub_does_not_exist",
        customer: "cus_does_not_exist",
      },
    },
  };
  const res = await postWebhook({});
  assert.equal(res.statusCode, 200);
});

// ═══ meterItemIdsJson population ═════════════════════════════════════════

test("webhook customer.subscription.updated populates meterItemIdsJson when env price IDs match", async () => {
  // Re-create an active subscription so we have something for the
  // updated event to match against.
  const { prisma } = await import("@altium-mcp/db");
  await prisma.subscription.upsert({
    where: { stripeSubId: "sub_meter_test" },
    create: {
      orgId: testOrgId,
      stripeSubId: "sub_meter_test",
      stripePriceId: "price_team_seat_test",
      seats: 1,
      status: "active",
    },
    update: { status: "active", meterItemIdsJson: null },
  });

  // Set the env vars the webhook reads. The match is exact on the
  // env-trimmed string; the webhook ignores items whose price.id
  // doesn't appear in the env map.
  const prevBom = process.env.STRIPE_PRICE_METER_BOM;
  const prevCost = process.env.STRIPE_PRICE_METER_COST;
  process.env.STRIPE_PRICE_METER_BOM = "price_meter_bom";
  process.env.STRIPE_PRICE_METER_COST = "price_meter_cost";

  try {
    reset();
    capture.event = {
      id: "evt_meter_items_1",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_meter_test",
          status: "active",
          items: {
            data: [
              { id: "si_seat", price: { id: "price_team_seat_test" }, quantity: 5 },
              { id: "si_meter_bom", price: { id: "price_meter_bom" } },
              { id: "si_meter_cost", price: { id: "price_meter_cost" } },
            ],
          },
        },
      },
    };
    const res = await postWebhook({});
    assert.equal(res.statusCode, 200);

    const sub = await prisma.subscription.findUnique({
      where: { stripeSubId: "sub_meter_test" },
    });
    assert.ok(sub?.meterItemIdsJson);
    const map = JSON.parse(sub!.meterItemIdsJson!);
    assert.equal(map.bom_lookup, "si_meter_bom");
    assert.equal(map.cost_analysis, "si_meter_cost");
    // export wasn't in the env map, so it doesn't appear here.
    assert.equal(map.export, undefined);
  } finally {
    if (prevBom === undefined) delete process.env.STRIPE_PRICE_METER_BOM;
    else process.env.STRIPE_PRICE_METER_BOM = prevBom;
    if (prevCost === undefined) delete process.env.STRIPE_PRICE_METER_COST;
    else process.env.STRIPE_PRICE_METER_COST = prevCost;
  }
});

test("webhook does not clear existing meterItemIdsJson when env is unset", async () => {
  // Pre-seed a Subscription with a known meterItemIdsJson, then
  // process an updated event with NO STRIPE_PRICE_METER_* env vars.
  // The webhook must preserve the existing map (not overwrite to
  // null) so a partial deploy doesn't blank out the meter map.
  const { prisma } = await import("@altium-mcp/db");
  await prisma.subscription.upsert({
    where: { stripeSubId: "sub_preserve_meter" },
    create: {
      orgId: testOrgId,
      stripeSubId: "sub_preserve_meter",
      stripePriceId: "price_team_seat_test",
      seats: 1,
      status: "active",
      meterItemIdsJson: JSON.stringify({ bom_lookup: "si_existing" }),
    },
    update: {
      status: "active",
      meterItemIdsJson: JSON.stringify({ bom_lookup: "si_existing" }),
    },
  });

  const prevBom = process.env.STRIPE_PRICE_METER_BOM;
  const prevCost = process.env.STRIPE_PRICE_METER_COST;
  const prevExport = process.env.STRIPE_PRICE_METER_EXPORT;
  delete process.env.STRIPE_PRICE_METER_BOM;
  delete process.env.STRIPE_PRICE_METER_COST;
  delete process.env.STRIPE_PRICE_METER_EXPORT;

  try {
    reset();
    capture.event = {
      id: "evt_preserve_meter_1",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_preserve_meter",
          status: "active",
          items: {
            data: [
              { id: "si_seat", price: { id: "price_team_seat_test" }, quantity: 5 },
            ],
          },
        },
      },
    };
    const res = await postWebhook({});
    assert.equal(res.statusCode, 200);

    const sub = await prisma.subscription.findUnique({
      where: { stripeSubId: "sub_preserve_meter" },
    });
    assert.ok(sub?.meterItemIdsJson);
    const map = JSON.parse(sub!.meterItemIdsJson!);
    assert.equal(map.bom_lookup, "si_existing");
  } finally {
    if (prevBom !== undefined) process.env.STRIPE_PRICE_METER_BOM = prevBom;
    if (prevCost !== undefined) process.env.STRIPE_PRICE_METER_COST = prevCost;
    if (prevExport !== undefined) process.env.STRIPE_PRICE_METER_EXPORT = prevExport;
  }
});

test("webhook preserves meterItemIdsJson when items array is empty", async () => {
  // Some Stripe `customer.subscription.updated` deliveries arrive
  // with an empty items.data (e.g. during certain modifications).
  // The webhook must NOT clobber a previously-good map.
  const { prisma } = await import("@altium-mcp/db");
  await prisma.subscription.upsert({
    where: { stripeSubId: "sub_empty_items" },
    create: {
      orgId: testOrgId,
      stripeSubId: "sub_empty_items",
      stripePriceId: "price_team_seat_test",
      seats: 1,
      status: "active",
      meterItemIdsJson: JSON.stringify({ bom_lookup: "si_kept" }),
    },
    update: {
      status: "active",
      meterItemIdsJson: JSON.stringify({ bom_lookup: "si_kept" }),
    },
  });

  reset();
  capture.event = {
    id: "evt_empty_items_1",
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_empty_items",
        status: "active",
        items: { data: [] },
      },
    },
  };
  const res = await postWebhook({});
  assert.equal(res.statusCode, 200);

  const sub = await prisma.subscription.findUnique({
    where: { stripeSubId: "sub_empty_items" },
  });
  const map = JSON.parse(sub!.meterItemIdsJson!);
  assert.equal(map.bom_lookup, "si_kept");
});
