/**
 * Factory tests — selectBillingProvider returns the right provider
 * based on STRIPE_SECRET_KEY env presence.
 *
 * The cache reset (__resetBillingProviderCacheForTests) is the same
 * pattern @altium-mcp/auth uses; flipping env at runtime requires
 * dropping the cache because the factory memoizes on first call.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  __resetBillingProviderCacheForTests,
  selectBillingProvider,
} from "./factory.js";
import { NoopBillingProvider } from "./noop.js";
import { StripeBillingProvider } from "./stripe.js";

function withEnv(key: string, value: string | undefined, fn: () => void) {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

test("returns NoopBillingProvider when STRIPE_SECRET_KEY is unset", () => {
  withEnv("STRIPE_SECRET_KEY", undefined, () => {
    __resetBillingProviderCacheForTests();
    const p = selectBillingProvider();
    assert.ok(p instanceof NoopBillingProvider);
    assert.equal(p.isConfigured(), false);
  });
});

test("returns NoopBillingProvider when STRIPE_SECRET_KEY is empty/whitespace", () => {
  // A blank env line ("STRIPE_SECRET_KEY=") shouldn't fool us into
  // thinking Stripe is configured. Same for whitespace-only.
  for (const v of ["", "   ", "\n"]) {
    withEnv("STRIPE_SECRET_KEY", v, () => {
      __resetBillingProviderCacheForTests();
      const p = selectBillingProvider();
      assert.ok(
        p instanceof NoopBillingProvider,
        `expected Noop for ${JSON.stringify(v)}`
      );
    });
  }
});

test("returns StripeBillingProvider when STRIPE_SECRET_KEY is set", () => {
  // Constructing a Stripe instance with a fake key is fine — the
  // SDK doesn't make a network call until you invoke an API method.
  // We use a placeholder test-mode-shaped key so the constructor's
  // length check (if any future SDK adds one) is satisfied.
  withEnv("STRIPE_SECRET_KEY", "sk_test_placeholder_for_factory_test", () => {
    __resetBillingProviderCacheForTests();
    const p = selectBillingProvider();
    assert.ok(p instanceof StripeBillingProvider);
    assert.equal(p.isConfigured(), true);
  });
});

test("memoizes — repeated calls return the same instance", () => {
  withEnv("STRIPE_SECRET_KEY", undefined, () => {
    __resetBillingProviderCacheForTests();
    const p1 = selectBillingProvider();
    const p2 = selectBillingProvider();
    assert.equal(p1, p2);
  });
});

test("__resetBillingProviderCacheForTests forces re-read of env", () => {
  withEnv("STRIPE_SECRET_KEY", undefined, () => {
    __resetBillingProviderCacheForTests();
    const a = selectBillingProvider();
    assert.ok(a instanceof NoopBillingProvider);
  });
  // Now flip env without resetting — should still return cached Noop
  // because we never called the reset.
  withEnv("STRIPE_SECRET_KEY", "sk_test_after_noop", () => {
    const stillNoop = selectBillingProvider();
    assert.ok(stillNoop instanceof NoopBillingProvider);
    // Reset, re-read, now we get Stripe.
    __resetBillingProviderCacheForTests();
    const nowStripe = selectBillingProvider();
    assert.ok(nowStripe instanceof StripeBillingProvider);
  });
});
