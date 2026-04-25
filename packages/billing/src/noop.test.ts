/**
 * NoopBillingProvider tests — every method must throw
 * BillingNotConfigured so the routes / worker can map it cleanly
 * to a 503 / "skip with log" path. The dev experience hinges on
 * this: forgetting to wire Stripe shouldn't crash the server, just
 * gate the billing-dependent surface.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { NoopBillingProvider } from "./noop.js";
import { BillingNotConfigured } from "./types.js";

test("isConfigured() returns false", () => {
  const p = new NoopBillingProvider();
  assert.equal(p.isConfigured(), false);
});

test("createCheckoutSession throws BillingNotConfigured", async () => {
  const p = new NoopBillingProvider();
  await assert.rejects(
    () =>
      p.createCheckoutSession({
        orgId: "org",
        customerEmail: "x@example.com",
        priceId: "price_x",
        seats: 1,
        successUrl: "https://x",
        cancelUrl: "https://x",
        clientReferenceId: "x",
      }),
    BillingNotConfigured
  );
});

test("createPortalSession throws BillingNotConfigured", async () => {
  const p = new NoopBillingProvider();
  await assert.rejects(
    () => p.createPortalSession({ customerId: "cus_x", returnUrl: "https://x" }),
    BillingNotConfigured
  );
});

test("verifyWebhook throws BillingNotConfigured", () => {
  const p = new NoopBillingProvider();
  assert.throws(
    () => p.verifyWebhook(Buffer.from(""), "sig"),
    BillingNotConfigured
  );
});

test("recordUsage throws BillingNotConfigured — meter-push job catches + skips", async () => {
  // The meter-push job specifically catches BillingNotConfigured to
  // mark a batch as "skipped, no billing" and leave UsageEvent rows
  // pending. If this contract changes, the worker would either crash
  // or double-bill. Pin it.
  const p = new NoopBillingProvider();
  await assert.rejects(
    () =>
      p.recordUsage({
        subscriptionItemId: "si_x",
        quantity: 1,
        timestamp: 1735689600,
        idempotencyKey: "abc",
      }),
    BillingNotConfigured
  );
});
