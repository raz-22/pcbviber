/**
 * Stripe webhook handler.
 *
 * `POST /api/billing/webhook` — UNTENANTED (no orgId in path; the org
 * is recovered from the signed `client_reference_id` on
 * `checkout.session.completed`, or by looking up the `customer` on
 * subscription/invoice events). The endpoint is authenticated by
 * Stripe's HMAC signature, NOT by a session cookie or API key.
 *
 * Raw body parsing: Fastify's default JSON parser would auto-decode
 * the body, but Stripe verifies the signature against the EXACT
 * bytes that were transmitted. We register the route inside a child
 * plugin scope and override the JSON content-type parser there to
 * pass the body through as a Buffer — outside that scope, the
 * default JSON parser still applies.
 *
 * Idempotency: every event is keyed on `event.id` in the
 * `WebhookEvent` table. A pre-check fast-paths the common "already
 * seen" case; the actual guarantee is the unique-constraint failure
 * inside the transaction wrapping the apply step. Stripe retries
 * with the same event.id on 5xx, so duplicate deliveries are normal
 * and must be no-ops.
 *
 * Stable error codes:
 *   webhook_signature_invalid (400)  — Stripe HMAC didn't verify
 *   billing_not_configured    (503)  — Noop provider; no secret to
 *                                       verify against
 */

import type { FastifyInstance } from "fastify";
import { prisma } from "@altium-mcp/db";
import {
  type BillingProvider,
  type BillingSigner,
  type WebhookEvent,
  BillingNotConfigured,
  WebhookSignatureInvalid,
} from "@altium-mcp/billing";

export interface WebhookRouteDeps {
  billing: BillingProvider;
  signer: BillingSigner;
}

export async function registerBillingWebhookRoute(
  app: FastifyInstance,
  deps: WebhookRouteDeps
): Promise<void> {
  // Child plugin scope so the buffer-mode content-type parser
  // applies ONLY to /api/billing/webhook. The rest of the app
  // continues to JSON-parse application/json bodies normally.
  await app.register(async (childApp) => {
    childApp.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_req, body, done) => done(null, body)
    );

    childApp.post("/api/billing/webhook", async (req, reply) => {
      const sigHeader = req.headers["stripe-signature"];
      const signature = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
      if (!signature || typeof signature !== "string") {
        reply.code(400);
        return { error: "webhook_signature_invalid" };
      }

      const rawBody = req.body;
      if (!Buffer.isBuffer(rawBody)) {
        // Should never happen with the buffer parser above, but
        // guard so a misregistered route doesn't silently feed a
        // string into Stripe's HMAC check.
        reply.code(400);
        return { error: "webhook_signature_invalid" };
      }

      let event: WebhookEvent;
      try {
        event = deps.billing.verifyWebhook(rawBody, signature);
      } catch (err) {
        if (err instanceof BillingNotConfigured) {
          reply.code(503);
          return { error: "billing_not_configured" };
        }
        if (err instanceof WebhookSignatureInvalid) {
          reply.code(400);
          return { error: "webhook_signature_invalid" };
        }
        throw err;
      }

      // Fast-path: already-seen event. Stripe retries the same
      // event.id on 5xx; duplicates are normal.
      const seen = await prisma.webhookEvent.findUnique({
        where: { stripeEventId: event.id },
      });
      if (seen) {
        return { received: true, idempotent: true };
      }

      // Apply the event AND record the idempotency row in one
      // transaction. Concurrent duplicate deliveries collide on
      // the unique stripeEventId — caught below.
      try {
        await prisma.$transaction(async (tx) => {
          await tx.webhookEvent.create({
            data: {
              stripeEventId: event.id,
              eventType: event.type,
            },
          });
          await applyEvent(tx, event, deps.signer);
        });
      } catch (err) {
        // P2002 = unique-constraint violation. Lost the race; the
        // other transaction has applied the event; we ack.
        if (
          typeof err === "object" &&
          err !== null &&
          "code" in err &&
          (err as { code?: string }).code === "P2002"
        ) {
          return { received: true, idempotent: true };
        }
        throw err;
      }

      return { received: true };
    });
  });
}

// ─── Event handlers ──────────────────────────────────────────────────

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

async function applyEvent(
  tx: Tx,
  event: WebhookEvent,
  signer: BillingSigner
): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed":
      await onCheckoutCompleted(tx, event, signer);
      return;
    case "customer.subscription.updated":
      await onSubscriptionUpdated(tx, event);
      return;
    case "customer.subscription.deleted":
      await onSubscriptionDeleted(tx, event);
      return;
    case "invoice.payment_succeeded":
      await onInvoicePaymentSucceeded(tx, event);
      return;
    case "invoice.payment_failed":
      await onInvoicePaymentFailed(tx, event);
      return;
    default:
      // Unknown event types are acknowledged without action.
      // Stripe sends many events we don't subscribe to (depending on
      // the webhook endpoint config); the safe response is 200 + ack
      // so Stripe doesn't retry forever.
      return;
  }
}

interface StripeCheckoutSession {
  id?: string;
  client_reference_id?: string | null;
  customer?: string | null;
  subscription?: string | null;
  /** seats × seat-price = total; Stripe's Subscription is the source of truth for current period */
  amount_total?: number | null;
}

async function onCheckoutCompleted(
  tx: Tx,
  event: WebhookEvent,
  signer: BillingSigner
): Promise<void> {
  const obj = event.data.object as StripeCheckoutSession;
  if (!obj.client_reference_id) {
    // Defensive: a checkout session WE created always has a
    // signed client_reference_id. A session without one is either
    // not ours or a broken Stripe integration; either way, ignore.
    return;
  }
  const claim = signer.verify(obj.client_reference_id);
  if (!claim) {
    // Tampered or unsigned client_reference_id — DO NOT bind any
    // org. This is the only place we trust the org attribution from
    // the webhook payload, and it must be cryptographically signed.
    return;
  }

  const stripeCustomerId = typeof obj.customer === "string" ? obj.customer : null;
  const stripeSubId = typeof obj.subscription === "string" ? obj.subscription : null;

  // Reflect Stripe customer + active state onto Organization. This
  // is the moment the trial ends and the org goes paid.
  await tx.organization.update({
    where: { id: claim.orgId },
    data: {
      billingCustomerId: stripeCustomerId ?? undefined,
      billingStatus: "active",
      // Trial deadline is no longer meaningful once paid.
      trialEndsAt: null,
    },
  });

  // Upsert a Subscription row. planId stays null until Plan rows
  // are seeded; stripePriceId carries the actual product reference.
  if (stripeSubId) {
    await tx.subscription.upsert({
      where: { stripeSubId },
      create: {
        orgId: claim.orgId,
        stripeSubId,
        stripePriceId: claim.priceId,
        seats: claim.seats,
        status: "active",
      },
      update: {
        stripePriceId: claim.priceId,
        seats: claim.seats,
        status: "active",
      },
    });
  }

  // No audit-log write here despite spec §3.5 listing "subscription
  // change" as audit-loggable. SQLite serializes writes; calling
  // writeAuditLog (which uses the global prisma client) inside an
  // open transaction deadlocks. The clean fix is to return audit
  // metadata from each handler and write it AFTER the transaction
  // commits — small process-crash window where state changes but
  // no audit row, acceptable trade-off. Deferred to a focused
  // audit-billing-events PR. The WebhookEvent row + the org/sub
  // mutations are queryable in the meantime.
}

interface StripeSubscriptionItem {
  /** Stripe subscription_item id (`si_…`). */
  id?: string;
  price?: { id?: string };
  quantity?: number;
}

interface StripeSubscription {
  id?: string;
  customer?: string | null;
  status?: string;
  items?: { data: StripeSubscriptionItem[] };
  current_period_start?: number;
  current_period_end?: number;
}

async function onSubscriptionUpdated(
  tx: Tx,
  event: WebhookEvent
): Promise<void> {
  const obj = event.data.object as StripeSubscription;
  if (!obj.id) return;
  const stripeSubId = obj.id;
  const sub = await tx.subscription.findUnique({ where: { stripeSubId } });
  if (!sub) {
    // Update for a sub we don't have. Could be a race with
    // checkout.session.completed; ignore — the next `updated` event
    // (or a re-fetched sub) will reconcile.
    return;
  }
  const status = obj.status ?? sub.status;
  const items = obj.items?.data ?? [];
  // Seat-priced item is the one whose quantity is set; metered items
  // ship without `quantity` (their billable quantity comes from
  // usage records). For the seats column we look at the seat item.
  const seatItem = items.find((it) => typeof it.quantity === "number");
  const seats = typeof seatItem?.quantity === "number" ? seatItem.quantity : sub.seats;
  const stripePriceId = seatItem?.price?.id ?? sub.stripePriceId;
  const currentPeriodStart =
    typeof obj.current_period_start === "number"
      ? new Date(obj.current_period_start * 1000)
      : sub.currentPeriodStart;
  const currentPeriodEnd =
    typeof obj.current_period_end === "number"
      ? new Date(obj.current_period_end * 1000)
      : sub.currentPeriodEnd;
  // Metered subscription items: match each item's price.id against the
  // STRIPE_PRICE_METER_* env vars and persist the {metric → si_…} map.
  // The meter-push job reads this on every tick — without it we have
  // no way to know which subscription_item to charge for which metric.
  const meterItemIdsJson = buildMeterItemIdsJson(items, sub.meterItemIdsJson);

  await tx.subscription.update({
    where: { stripeSubId },
    data: {
      status,
      seats,
      stripePriceId,
      currentPeriodStart,
      currentPeriodEnd,
      meterItemIdsJson,
    },
  });

  // Mirror Stripe-side status onto Organization for the SPA's
  // banner / tool gating. Stripe vocab maps directly to ours
  // except `trialing` → keep org "trialing" (we manage trial state
  // explicitly).
  const orgStatus = mapStripeStatus(status);
  if (orgStatus) {
    await tx.organization.update({
      where: { id: sub.orgId },
      data: { billingStatus: orgStatus },
    });
  }
}

async function onSubscriptionDeleted(
  tx: Tx,
  event: WebhookEvent
): Promise<void> {
  const obj = event.data.object as StripeSubscription;
  if (!obj.id) return;
  const sub = await tx.subscription.findUnique({ where: { stripeSubId: obj.id } });
  if (!sub) return;
  await tx.subscription.update({
    where: { stripeSubId: obj.id },
    data: { status: "canceled" },
  });
  await tx.organization.update({
    where: { id: sub.orgId },
    data: { billingStatus: "canceled" },
  });
}

interface StripeInvoice {
  id?: string;
  customer?: string | null;
  subscription?: string | null;
}

async function onInvoicePaymentSucceeded(
  tx: Tx,
  event: WebhookEvent
): Promise<void> {
  const obj = event.data.object as StripeInvoice;
  const orgId = await orgIdFromInvoice(tx, obj);
  if (!orgId) return;
  // Successful payment confirms (or restores) active state. If the
  // org was in past_due from a prior failed invoice, this clears it.
  await tx.organization.update({
    where: { id: orgId },
    data: { billingStatus: "active" },
  });
}

async function onInvoicePaymentFailed(
  tx: Tx,
  event: WebhookEvent
): Promise<void> {
  const obj = event.data.object as StripeInvoice;
  const orgId = await orgIdFromInvoice(tx, obj);
  if (!orgId) return;
  // Stripe Smart Retries handles the retry schedule; we just reflect
  // the org as past_due so the SPA can render a banner and the
  // metering layer (Sprint 5) knows to soft-degrade.
  await tx.organization.update({
    where: { id: orgId },
    data: { billingStatus: "past_due" },
  });
}

/**
 * Look up the local Organization for a Stripe invoice. Tries the
 * subscription id first (most reliable — bound at checkout-completion)
 * then falls back to the customer id (for invoices not tied to a sub).
 */
async function orgIdFromInvoice(
  tx: Tx,
  obj: StripeInvoice
): Promise<string | null> {
  if (typeof obj.subscription === "string") {
    const sub = await tx.subscription.findUnique({
      where: { stripeSubId: obj.subscription },
    });
    if (sub) return sub.orgId;
  }
  if (typeof obj.customer === "string") {
    const org = await tx.organization.findFirst({
      where: { billingCustomerId: obj.customer },
      select: { id: true },
    });
    if (org) return org.id;
  }
  return null;
}

/**
 * Walks the Stripe subscription's items, matches each item's
 * price.id against `STRIPE_PRICE_METER_BOM/COST/EXPORT` env vars,
 * and returns a `{metric: subscription_item_id}` JSON-string. When
 * none match, returns the existing `meterItemIdsJson` so a partial
 * webhook doesn't clear a previously-correct map (Stripe sometimes
 * sends `customer.subscription.updated` events whose `items.data`
 * is empty during certain modifications).
 */
function buildMeterItemIdsJson(
  items: StripeSubscriptionItem[],
  existingJson: string | null
): string | null {
  if (items.length === 0) return existingJson;
  const env = process.env;
  const priceToMetric: Record<string, string> = {};
  if (env.STRIPE_PRICE_METER_BOM?.trim()) {
    priceToMetric[env.STRIPE_PRICE_METER_BOM.trim()] = "bom_lookup";
  }
  if (env.STRIPE_PRICE_METER_COST?.trim()) {
    priceToMetric[env.STRIPE_PRICE_METER_COST.trim()] = "cost_analysis";
  }
  if (env.STRIPE_PRICE_METER_EXPORT?.trim()) {
    priceToMetric[env.STRIPE_PRICE_METER_EXPORT.trim()] = "export";
  }
  if (Object.keys(priceToMetric).length === 0) {
    // No metered prices in env (yet). Don't clear an existing map.
    return existingJson;
  }
  const meterItems: Record<string, string> = {};
  for (const item of items) {
    const itemId = item.id;
    const priceId = item.price?.id;
    if (!itemId || !priceId) continue;
    const metric = priceToMetric[priceId];
    if (metric) meterItems[metric] = itemId;
  }
  if (Object.keys(meterItems).length === 0) {
    // No metered items in this delivery. Don't overwrite a prior
    // good map with `null` — the seat item without metered items is
    // a valid Stripe state during e.g. a plan downgrade.
    return existingJson;
  }
  return JSON.stringify(meterItems);
}

/**
 * Translate Stripe's subscription `status` to the local
 * `Organization.billingStatus` vocabulary. `trialing` is local-only
 * here — once a sub exists in Stripe, our trial is over and the org
 * is on a paid (or actively-failing) plan.
 */
function mapStripeStatus(stripeStatus: string): string | null {
  switch (stripeStatus) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
      return "past_due";
    case "canceled":
      return "canceled";
    case "unpaid":
    case "incomplete_expired":
      return "suspended";
    case "incomplete":
    case "paused":
      // Don't change org status from these intermediate Stripe
      // states; the next event will resolve.
      return null;
    default:
      return null;
  }
}
