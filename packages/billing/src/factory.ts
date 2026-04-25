/**
 * Env-gated billing-provider selection.
 *
 * Same pattern as `selectAuthProvider` in @altium-mcp/auth — tests
 * import the cache reset function and call it in `before()` so a
 * stale provider from another test file doesn't leak state.
 */

import { NoopBillingProvider } from "./noop.js";
import { StripeBillingProvider } from "./stripe.js";
import type { BillingProvider } from "./types.js";

let cached: BillingProvider | null = null;

export function selectBillingProvider(): BillingProvider {
  if (cached) return cached;
  const key = process.env.STRIPE_SECRET_KEY;
  if (key && key.trim().length > 0) {
    cached = new StripeBillingProvider({ secretKey: key });
  } else {
    cached = new NoopBillingProvider();
  }
  return cached;
}

/**
 * Test-only: drop the cached provider so the next selectBillingProvider()
 * re-reads env. Tests that toggle STRIPE_SECRET_KEY in their `before()`
 * MUST call this — otherwise the previous test's choice sticks.
 */
export function __resetBillingProviderCacheForTests(): void {
  cached = null;
}
