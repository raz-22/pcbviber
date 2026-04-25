/**
 * HMAC-SHA256 signing for Stripe Checkout's `client_reference_id`.
 *
 * Why sign at all: Stripe round-trips the `client_reference_id` to the
 * webhook unchanged. Without a signature, an attacker who could replay
 * a Checkout completion webhook (or who could control its body in a
 * test environment) could create a Subscription bound to ANY orgId
 * they pick. Signing the (orgId, priceId, seats) tuple lets the
 * webhook handler verify the claim was server-issued before applying
 * it.
 *
 * Domain separator: every protocol that signs with the same shared
 * secret prepends a domain string before the message. Cross-protocol
 * attacks (where a signature legitimately produced for purpose A is
 * fed to verifier B) are eliminated.
 *
 * Key source: routes derive the signing secret from
 * CREDENTIAL_ENCRYPTION_KEY (already-required env). A dedicated
 * BILLING_SIGNING_KEY would be cleaner key-separation; until that env
 * split lands, the DOMAIN prefix above is what isolates this protocol
 * from any other surface that might reuse the same secret.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const DOMAIN = "billing-checkout";
const FIELD_SEP = "|";

export interface CheckoutClaim {
  orgId: string;
  priceId: string;
  seats: number;
}

export interface BillingSigner {
  /** Returns the wire-format string to put in `client_reference_id`. */
  sign(claim: CheckoutClaim): string;
  /**
   * Returns the verified claim, or null on tamper / bad shape.
   * Constant-time HMAC compare.
   */
  verify(clientRef: string): CheckoutClaim | null;
}

function computeTag(secret: Buffer, claim: CheckoutClaim): string {
  const message = [DOMAIN, claim.orgId, claim.priceId, claim.seats].join(FIELD_SEP);
  return createHmac("sha256", secret).update(message).digest("hex");
}

/**
 * Build a signer bound to `secret`. Routes wire the env-derived secret;
 * tests construct a deterministic signer for round-trip assertions.
 */
export function makeBillingSigner(secret: Buffer): BillingSigner {
  return {
    sign(claim) {
      const tag = computeTag(secret, claim);
      // Wire format: orgId|priceId|seats|tag — separator is FIELD_SEP
      // so each field is unambiguous as long as none contains "|".
      // orgId is a cuid (no "|"), priceId is a Stripe id (no "|"),
      // seats is an int. Safe.
      return [claim.orgId, claim.priceId, claim.seats, tag].join(FIELD_SEP);
    },
    verify(clientRef) {
      const parts = clientRef.split(FIELD_SEP);
      if (parts.length !== 4) return null;
      const [orgId, priceId, seatsStr, tag] = parts;
      if (!orgId || !priceId || !tag) return null;
      const seats = Number.parseInt(seatsStr, 10);
      if (!Number.isFinite(seats) || seats <= 0) return null;
      const expected = computeTag(secret, { orgId, priceId, seats });
      // Compare in constant time — even though we read the tag from
      // an attacker-controlled string, leaking timing info on the
      // mismatch position would let them flip bits one at a time.
      const a = Buffer.from(tag, "hex");
      const b = Buffer.from(expected, "hex");
      if (a.length !== b.length) return null;
      if (!timingSafeEqual(a, b)) return null;
      return { orgId, priceId, seats };
    },
  };
}
