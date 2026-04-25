/**
 * Public types for the billing layer.
 *
 * The interface is provider-agnostic — Stripe is the only concrete
 * implementation today, but the route layer takes a `BillingProvider`
 * and tests pass a stub. Same separation pattern as `AuthProvider`
 * (LocalAuthProvider / WorkosAuthProvider in @altium-mcp/auth).
 */

/**
 * Input to `createCheckoutSession`. The route assembles this from the
 * authenticated context + a validated body; the provider doesn't see
 * Fastify or Prisma.
 */
export interface CheckoutSessionRequest {
  /**
   * The org being billed. Carried through `client_reference_id` so the
   * webhook can attribute the resulting subscription back to the right
   * tenant after the user round-trips through Stripe-hosted Checkout.
   */
  orgId: string;
  /**
   * Stripe customer id from a prior checkout, if any. When set, the
   * Checkout session reuses the customer (preserves saved cards,
   * billing addresses). Null on first checkout — Stripe creates a
   * customer and the webhook pins the id back to Organization.
   */
  customerId?: string | null;
  /** Pre-fills the email field on the Stripe-hosted Checkout page. */
  customerEmail: string;
  /** Stripe Price id (already env-allow-listed by the route). */
  priceId: string;
  /** Number of seats. Validated 1..1000 by the route. */
  seats: number;
  /** Where Stripe redirects on a successful Checkout. Absolute URL. */
  successUrl: string;
  /** Where Stripe redirects when the user cancels. Absolute URL. */
  cancelUrl: string;
  /**
   * Server-signed reference linking this Checkout back to
   * (orgId, priceId, seats). The webhook handler will verify this in
   * a later PR rather than trusting the orgId from anywhere else.
   */
  clientReferenceId: string;
}

export interface CheckoutSessionResult {
  /** Stripe-hosted URL the SPA redirects the user to. */
  url: string;
  /** Stripe Checkout Session id (cs_...). Useful for audit logs. */
  sessionId: string;
}

/**
 * Input to `createPortalSession`. The portal lets the user self-serve
 * everything billing-related (plan switch, seat change, payment-method
 * update, cancellation, invoice download) on Stripe-hosted pages. We
 * just hand them a URL.
 */
export interface PortalSessionRequest {
  /**
   * Stripe customer id from a prior checkout. Required — the portal
   * is for an existing customer; pre-checkout orgs can't reach it.
   */
  customerId: string;
  /** Where Stripe sends the user when they click "Return to <site>". */
  returnUrl: string;
}

export interface PortalSessionResult {
  /** Stripe-hosted URL. Single-use (Stripe expires it after a few min). */
  url: string;
}

/**
 * Provider-agnostic webhook event shape. Mirrors the small subset
 * of `Stripe.Event` the route + handlers actually read; the Stripe
 * implementation passes the SDK's event object through unchanged
 * (which is structurally compatible).
 *
 * `data.object` is intentionally `unknown` — each handler narrows
 * it via the event `type`. Centralizing the narrowing in handlers
 * (rather than baking it into this interface) keeps the abstraction
 * Stripe-agnostic; a different billing provider could feed the same
 * shape with its own event-object structures.
 */
export interface WebhookEvent {
  /** Stripe event id (e.g. `evt_…`). Idempotency key. */
  id: string;
  /** Event type (e.g. `checkout.session.completed`). */
  type: string;
  data: { object: unknown };
}

/**
 * Provider interface. Each method is optional in spirit — a
 * NoopBillingProvider throws BillingNotConfigured for everything; a
 * Stripe-backed provider implements them for real. Routes check
 * `isConfigured()` before calling a method so they can short-circuit
 * with a clean 503 in dev environments without Stripe wired.
 */
export interface BillingProvider {
  /** Cheap synchronous check; routes use it to gate 503s. */
  isConfigured(): boolean;
  createCheckoutSession(input: CheckoutSessionRequest): Promise<CheckoutSessionResult>;
  /**
   * Returns a Stripe-hosted Customer Portal URL for the given
   * customer. The portal handles plan switches, seat changes,
   * payment-method updates, and cancellation; cancellations come
   * back through `customer.subscription.deleted` webhooks.
   */
  createPortalSession(input: PortalSessionRequest): Promise<PortalSessionResult>;
  /**
   * Parses + verifies a webhook delivery. Throws
   * `WebhookSignatureInvalid` on bad signature; the route 400s.
   * Synchronous — Stripe SDK's constructEvent is synchronous and
   * doesn't do I/O. NoopBillingProvider throws BillingNotConfigured
   * (the route 503s).
   */
  verifyWebhook(rawBody: Buffer, signature: string): WebhookEvent;
  /**
   * Pushes a metered-usage batch to Stripe. Called by the meter-push
   * background job. Idempotent on `request.idempotencyKey` — Stripe
   * preserves the original response on a duplicate key, so the job's
   * "mark these UsageEvent rows pushed" SQL update is safe to re-run.
   *
   * NoopBillingProvider throws BillingNotConfigured (the worker logs
   * + skips). Real implementations call
   * `subscription_items.createUsageRecord`.
   */
  recordUsage(request: RecordUsageRequest): Promise<RecordUsageResult>;
}

/**
 * Input to `recordUsage`. The meter-push background job builds one
 * of these per (org, metric) per cycle: it sums pending UsageEvent
 * rows by metric, looks up the matching `subscription_item` id from
 * Subscription.meterItemIdsJson, and calls Stripe.
 *
 * `idempotencyKey` is sha256(orgId|metric|sortedUsageEventIds) — a
 * partial-success retry sees the same key and Stripe returns the
 * already-recorded value rather than double-billing.
 */
export interface RecordUsageRequest {
  /** Stripe `subscription_item` id (e.g. `si_…`). */
  subscriptionItemId: string;
  /** Total billable units for this batch. > 0. */
  quantity: number;
  /**
   * Stripe usage-record timestamp (Unix seconds). Should fall within
   * the subscription's current billing period; the meter-push job
   * uses the latest UsageEvent.timestamp in the batch.
   */
  timestamp: number;
  /**
   * Stripe-side idempotency key. ≤255 chars, hex. Same key on retry
   * → Stripe returns the existing record.
   */
  idempotencyKey: string;
}

export interface RecordUsageResult {
  /** Stripe usage record id (`mbur_…`). Useful for audit logs. */
  usageRecordId: string;
}

/**
 * Thrown by the Noop provider's methods. Routes catch this, return
 * 503 + `{ error: "billing_not_configured" }` so the SPA's mapper
 * shows "billing isn't configured for this environment."
 */
export class BillingNotConfigured extends Error {
  constructor() {
    super("billing_not_configured");
    this.name = "BillingNotConfigured";
  }
}

/**
 * Thrown by `verifyWebhook` when the signature fails. The route
 * catches this and returns 400 — Stripe will retry on 5xx but
 * give up on 4xx, which is what we want for an unverifiable body.
 */
export class WebhookSignatureInvalid extends Error {
  constructor(reason: string) {
    super(`webhook_signature_invalid: ${reason}`);
    this.name = "WebhookSignatureInvalid";
  }
}
