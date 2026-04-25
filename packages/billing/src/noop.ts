import {
  BillingNotConfigured,
  type BillingProvider,
  type CheckoutSessionRequest,
  type CheckoutSessionResult,
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
}
