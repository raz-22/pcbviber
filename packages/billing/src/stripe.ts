import Stripe from "stripe";
import type {
  BillingProvider,
  CheckoutSessionRequest,
  CheckoutSessionResult,
} from "./types.js";

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

  constructor(opts: { secretKey: string; apiVersion?: Stripe.LatestApiVersion }) {
    this.stripe = new Stripe(opts.secretKey, {
      apiVersion: opts.apiVersion ?? "2025-02-24.acacia",
    });
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
}
