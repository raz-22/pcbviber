import {
  BillingNotConfigured,
  type BillingProvider,
  type CheckoutSessionRequest,
  type CheckoutSessionResult,
  type PortalSessionRequest,
  type PortalSessionResult,
  type RecordUsageRequest,
  type RecordUsageResult,
  type WebhookEvent,
} from "./types.js";

/**
 * Provider used when STRIPE_SECRET_KEY isn't set. Mirrors the
 * "configured-or-not" pattern of LocalAuthProvider in @altium-mcp/auth:
 * the server boots cleanly without Stripe so dev work continues; routes
 * that need Stripe surface a 503 with `error: "billing_not_configured"`.
 */
export class NoopBillingProvider implements BillingProvider {
  isConfigured(): boolean {
    return false;
  }

  async createCheckoutSession(
    _input: CheckoutSessionRequest
  ): Promise<CheckoutSessionResult> {
    throw new BillingNotConfigured();
  }

  async createPortalSession(
    _input: PortalSessionRequest
  ): Promise<PortalSessionResult> {
    throw new BillingNotConfigured();
  }

  verifyWebhook(_rawBody: Buffer, _signature: string): WebhookEvent {
    // No secret to verify against; reject everything. Webhook route
    // 503s on this — Stripe retries 5xx but in a no-Stripe env there
    // shouldn't be any incoming webhooks anyway.
    throw new BillingNotConfigured();
  }

  async recordUsage(_input: RecordUsageRequest): Promise<RecordUsageResult> {
    // Meter-push job catches BillingNotConfigured and skips the
    // batch with a log line. UsageEvent rows stay un-pushed (no
    // pushedToStripeAt set) so they get retried once Stripe is
    // wired — meter accounting stays consistent across env changes.
    throw new BillingNotConfigured();
  }
}
