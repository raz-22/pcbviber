/**
 * Signing/verification tests. The contract is the stable surface
 * between the route layer (which signs at checkout-session creation)
 * and the webhook handler (which verifies on `checkout.session.completed`)
 * — break either side without breaking the test and the bond between
 * a Stripe Checkout and an org silently goes away.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { makeBillingSigner } from "./signing.js";

const SECRET = randomBytes(32);
const SECRET_2 = randomBytes(32);

test("sign + verify round-trip preserves the claim", () => {
  const signer = makeBillingSigner(SECRET);
  const claim = { orgId: "org_abc", priceId: "price_team_seat", seats: 5 };
  const ref = signer.sign(claim);
  const back = signer.verify(ref);
  assert.deepEqual(back, claim);
});

test("sign produces 4 pipe-separated fields", () => {
  const signer = makeBillingSigner(SECRET);
  const ref = signer.sign({ orgId: "o", priceId: "p", seats: 1 });
  const parts = ref.split("|");
  assert.equal(parts.length, 4);
  // Last field is the tag — 64 hex chars (SHA-256).
  assert.match(parts[3], /^[a-f0-9]{64}$/);
});

test("verify rejects a tampered orgId (bit-flipped after signing)", () => {
  const signer = makeBillingSigner(SECRET);
  const ref = signer.sign({ orgId: "org_real", priceId: "p", seats: 1 });
  // Replace the orgId field. Without re-signing, the tag won't match.
  const parts = ref.split("|");
  parts[0] = "org_attacker";
  assert.equal(signer.verify(parts.join("|")), null);
});

test("verify rejects a tampered priceId", () => {
  const signer = makeBillingSigner(SECRET);
  const ref = signer.sign({ orgId: "o", priceId: "price_team_seat", seats: 1 });
  const parts = ref.split("|");
  // Swap to a fancier (more expensive?) price.
  parts[1] = "price_enterprise_seat";
  assert.equal(signer.verify(parts.join("|")), null);
});

test("verify rejects a tampered seats count", () => {
  const signer = makeBillingSigner(SECRET);
  const ref = signer.sign({ orgId: "o", priceId: "p", seats: 1 });
  const parts = ref.split("|");
  // 999 seats for the price of 1 — exactly the kind of attack the
  // signature exists to prevent.
  parts[2] = "999";
  assert.equal(signer.verify(parts.join("|")), null);
});

test("verify rejects a corrupted tag", () => {
  const signer = makeBillingSigner(SECRET);
  const ref = signer.sign({ orgId: "o", priceId: "p", seats: 1 });
  const parts = ref.split("|");
  // Flip the last hex char. timingSafeEqual rejects.
  parts[3] = parts[3].slice(0, -1) + (parts[3].endsWith("0") ? "1" : "0");
  assert.equal(signer.verify(parts.join("|")), null);
});

test("verify rejects a ref signed with a different secret (key separation)", () => {
  const a = makeBillingSigner(SECRET);
  const b = makeBillingSigner(SECRET_2);
  const ref = a.sign({ orgId: "o", priceId: "p", seats: 1 });
  // b's verify can't validate a's signature — domain isolation works
  // even if the wire formats happen to overlap.
  assert.equal(b.verify(ref), null);
});

test("verify rejects malformed shapes (wrong field count, non-numeric seats)", () => {
  const signer = makeBillingSigner(SECRET);
  // Too few fields.
  assert.equal(signer.verify("orgid|priceid|tag"), null);
  // Too many fields.
  assert.equal(signer.verify("orgid|priceid|seats|tag|extra"), null);
  // Non-numeric seats.
  assert.equal(signer.verify("orgid|priceid|abc|" + "0".repeat(64)), null);
  // Zero seats — disallowed.
  assert.equal(signer.verify("orgid|priceid|0|" + "0".repeat(64)), null);
  // Negative seats.
  assert.equal(signer.verify("orgid|priceid|-5|" + "0".repeat(64)), null);
});

test("verify rejects empty fields (defense against \"|||tag\" submissions)", () => {
  const signer = makeBillingSigner(SECRET);
  assert.equal(signer.verify("|priceid|1|" + "0".repeat(64)), null);
  assert.equal(signer.verify("orgid||1|" + "0".repeat(64)), null);
  // Empty tag.
  assert.equal(signer.verify("orgid|priceid|1|"), null);
});

test("DOMAIN separator prevents cross-protocol replay", () => {
  // If a future protocol uses the same secret to sign messages of the
  // form "orgId|priceId|seats" (e.g. for some other API), an attacker
  // who got such a signature shouldn't be able to feed it to the
  // billing verifier and have it pass. The DOMAIN prefix in computeTag
  // makes that impossible — sign() doesn't expose the underlying HMAC,
  // so the only way to produce a valid tag is through the billing
  // signer with the same domain.
  //
  // Pinning this behavior: a tag that's the HMAC of just
  // "orgId|priceId|seats" (without the domain) must NOT verify.
  const claim = { orgId: "o", priceId: "p", seats: 1 };
  const messageWithoutDomain = `${claim.orgId}|${claim.priceId}|${claim.seats}`;
  const tag = createHmac("sha256", SECRET).update(messageWithoutDomain).digest("hex");
  const ref = `${claim.orgId}|${claim.priceId}|${claim.seats}|${tag}`;
  const signer = makeBillingSigner(SECRET);
  assert.equal(signer.verify(ref), null);
});
