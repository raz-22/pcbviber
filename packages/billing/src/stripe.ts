import Stripe from "stripe";
import type {
  BillingProvider,
  CheckoutSessionRequest,
  CheckoutSessionResult,
  PortalSessionRequest,
  PortalSessionResult,
  RecordUsageRequest,
  RecordUsageResult,
  WebhookEvent,
} from "./types.js";
import { WebhookSignatureInvalid } from "./types.js";

/**
 * Stripe-backed implementation. Constructed by `selectBillingProvider`
 * when STRIPE_SECRET_KEY is present.
 *
 * The Stripe API version is pinned at construction time. Bumping it is
 * a deliberate code change so a Stripe-side rollout can't silently
 * shift behavior under a deployed server.
 */
export class StripeBillingProvider implements BillingProvider {
  private readonly stripe: Stripe;
  private readonly webhookSecret: string | null;

  constructor(opts: {
    secretKey: string;
    apiVersion?: Stripe.LatestApiVersion;
    /**
     * Stripe webhook signing secret (`whsec_…`). Required to verify
     * incoming webhook deliveries. When unset, verifyWebhook throws —
     * the dev path is to set STRIPE_WEBHOOK_SECRET alongside
     * STRIPE_SECRET_KEY; production uses a real Stripe-issued secret.
     */
    webhookSecret?: string | null;
  }) {
    this.stripe = new Stripe(opts.secretKey, {
      apiVersion: opts.apiVersion ?? "2025-02-24.acacia",
    });
    this.webhookSecret = opts.webhookSecret ?? null;
  }

  isConfigured(): boolean {
    return true;
  }

  async createCheckoutSession(
    input: CheckoutSessionRequest
  ): Promise<CheckoutSessionResult> {
    const session = await this.stripe.checkout.sessions.create({
      mode: "subscription",
      // line_items.quantity is the seat count. Stripe expects the price
      // to be configured as per_unit so seats line up with billable
      // quantity 1:1.
      line_items: [{ price: input.priceId, quantity: input.seats }],
      // Reuse the customer if we have one; otherwise pre-fill email so
      // Stripe can match an existing customer record by email server-
      // side and we don't double-create.
      customer: input.customerId ?? undefined,
      customer_email: input.customerId ? undefined : input.customerEmail,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      // Server-signed client_reference_id — the webhook will verify it
      // against the same secret rather than trusting any other field.
      client_reference_id: input.clientReferenceId,
      // Subscription-level metadata duplicates the orgId so post-hoc
      // queries (Stripe dashboard search by metadata) can resolve a
      // sub back to a tenant without parsing the client_reference_id.
      subscription_data: {
        metadata: { orgId: input.orgId },
      },
    });

    if (!session.url) {
      // Stripe should always return a URL for a hosted Checkout session.
      // Treat the empty case as a server bug rather than silently
      // returning "" to the SPA.
      throw new Error("stripe_returned_no_url");
    }

    return { url: session.url, sessionId: session.id };
  }

  async createPortalSession(
    input: PortalSessionRequest
  ): Promise<PortalSessionResult> {
    const session = await this.stripe.billingPortal.sessions.create({
      customer: input.customerId,
      return_url: input.returnUrl,
      // Configuration: defaults to the Customer Portal config in the
      // Stripe dashboard for the current account. To pin a specific
      // configuration (e.g. block downgrades over seat cap, per spec
      // §4.1), pass `configuration: <portal_config_id>`. Deferring
      // until we have explicit per-plan rules to enforce.
    });
    if (!session.url) {
      throw new Error("stripe_returned_no_url");
    }
    return { url: session.url };
  }

  verifyWebhook(rawBody: Buffer, signature: string): WebhookEvent {
    if (!this.webhookSecret) {
      // STRIPE_WEBHOOK_SECRET wasn't set even though STRIPE_SECRET_KEY
      // was. Treat as misconfiguration: we don't know what secret to
      // verify against, so we can't trust the body.
      throw new WebhookSignatureInvalid("webhook secret not configured");
    }
    try {
      // Stripe SDK does HMAC verification + timestamp check internally.
      // Tolerance defaults to 5 minutes — enough for clock skew, tight
      // enough that an attacker can't hold a captured payload for hours
      // and replay it.
      return this.stripe.webhooks.constructEvent(
        rawBody,
        signature,
        this.webhookSecret
      );
    } catch (err) {
      // Stripe throws a typed StripeSignatureVerificationError. We
      // rewrap so callers don't depend on the SDK's type hierarchy.
      const reason = err instanceof Error ? err.message : "unknown";
      throw new WebhookSignatureInvalid(reason);
    }
  }

  async recordUsage(input: RecordUsageRequest): Promise<RecordUsageResult> {
    // Stripe's idempotency-key header takes effect server-side — a
    // duplicate key returns the original record's id rather than
    // creating a new one. The meter-push job's "mark these rows
    // pushed" SQL update can therefore safely re-run after a
    // partial-success retry without double-billing.
    const record = await this.stripe.subscriptionItems.createUsageRecord(
      input.subscriptionItemId,
      {
        quantity: input.quantity,
        timestamp: input.timestamp,
        action: "increment",
      },
      { idempotencyKey: input.idempotencyKey }
    );
    return { usageRecordId: record.id };
  }
}
