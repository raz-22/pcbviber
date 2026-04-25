/**
 * Billing routes.
 *
 *   POST /api/orgs/:orgId/billing/checkout-session  — owner only
 *
 * The route validates the priceId against an env-derived allow-list
 * (STRIPE_PRICE_STARTER_SEAT, STRIPE_PRICE_TEAM_SEAT) so an attacker
 * with an authenticated session can't construct a Checkout for an
 * arbitrary Stripe price they discovered out-of-band.
 *
 * The Stripe Checkout session's `client_reference_id` is signed
 * (HMAC-SHA256 over `domain|orgId|priceId|seats`). The webhook
 * handler (PR 4.3) will verify it before binding the resulting
 * Subscription to an org — no other input is trusted for tenant
 * attribution.
 *
 * Stable error codes:
 *   not_authenticated  forbidden  invalid_input
 *   billing_not_configured  — STRIPE_SECRET_KEY isn't set
 *   invalid_price           — body.priceId isn't on the env allow-list
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@altium-mcp/db";
import type { AuthProvider } from "@altium-mcp/auth";
import {
  type BillingProvider,
  type BillingSigner,
  BillingNotConfigured,
} from "@altium-mcp/billing";
import { makeRequireAuth } from "../auth/middleware.js";
import { makeRequireOrgRole } from "../auth/tenant.js";
import { writeAuditLog, clientIp } from "../auth/audit.js";
import { can } from "../auth/can.js";

// ─── Input schemas ────────────────────────────────────────────────────

const CheckoutSessionBody = z.object({
  /**
   * Stripe Price id (e.g. `price_1OXyz…`). Must match one of the
   * env-allow-listed prices below — a route-level allow-list, not
   * a Stripe-side check, because Stripe will happily create a
   * Checkout for any price your account owns.
   */
  priceId: z.string().min(1).max(255),
  seats: z.coerce.number().int().min(1).max(1000),
});

/**
 * Allow-list of price ids the route accepts. Read at handler time
 * so test setup that flips env between cases sees fresh values
 * without a process restart.
 */
function loadAllowedPriceIds(): Set<string> {
  const ids = new Set<string>();
  for (const k of [
    "STRIPE_PRICE_STARTER_SEAT",
    "STRIPE_PRICE_TEAM_SEAT",
    // Enterprise is invoiced (not Checkout) — no env entry.
    // Annual variants land when we add the 20% discount tier.
  ] as const) {
    const v = process.env[k];
    if (v && v.trim().length > 0) ids.add(v.trim());
  }
  return ids;
}

// ─── Registration ─────────────────────────────────────────────────────

export interface BillingRouteDeps {
  billing: BillingProvider;
  signer: BillingSigner;
  /**
   * Where Stripe redirects after checkout. Absolute URL — the SPA's
   * origin in dev (http://localhost:5173) or the deployed app URL in
   * prod (https://app.altium-mcp.com). Falls back to the request's
   * `origin` header when not set.
   */
  appBaseUrl: string;
}

export async function registerBillingRoutes(
  app: FastifyInstance,
  auth: AuthProvider,
  deps: BillingRouteDeps
): Promise<void> {
  const requireAuth = makeRequireAuth(auth);
  const requireMember = makeRequireOrgRole([]);

  app.post(
    "/api/orgs/:orgId/billing/checkout-session",
    { preHandler: [requireAuth, requireMember] },
    async (req, reply) => {
      const ctx = req.ctx!;

      // Authz first — fail fast for non-owners before we even parse
      // the body. Less expensive + the 403 is more informative when
      // it doesn't share a path with 400 invalid_input.
      if (!can({ userId: ctx.user.id, role: ctx.role }, "billing.checkout")) {
        reply.code(403);
        return { error: "forbidden" };
      }

      // Provider-not-configured is a 503: server-side configuration
      // issue, not a client error. SPA's mapper renders "billing isn't
      // configured for this environment" — useful in dev, points at
      // the right person in prod.
      if (!deps.billing.isConfigured()) {
        reply.code(503);
        return { error: "billing_not_configured" };
      }

      const parsed = CheckoutSessionBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid_input", detail: parsed.error.flatten() };
      }

      const allowed = loadAllowedPriceIds();
      if (!allowed.has(parsed.data.priceId)) {
        // Distinct error code from invalid_input — the body shape was
        // valid, the value just wasn't on the allow-list.
        reply.code(400);
        return { error: "invalid_price" };
      }

      const claim = {
        orgId: ctx.org.id,
        priceId: parsed.data.priceId,
        seats: parsed.data.seats,
      };
      const clientReferenceId = deps.signer.sign(claim);

      // Pull existing customer id (if any) so Stripe can reuse the
      // saved cards / billing addresses. Empty on first checkout.
      const org = await prisma.organization.findUnique({
        where: { id: ctx.org.id },
        select: { billingCustomerId: true },
      });

      try {
        const session = await deps.billing.createCheckoutSession({
          orgId: ctx.org.id,
          customerId: org?.billingCustomerId ?? null,
          customerEmail: ctx.user.email,
          priceId: parsed.data.priceId,
          seats: parsed.data.seats,
          successUrl: `${deps.appBaseUrl}/settings/billing?status=success&session_id={CHECKOUT_SESSION_ID}`,
          cancelUrl: `${deps.appBaseUrl}/settings/billing?status=cancel`,
          clientReferenceId,
        });

        await writeAuditLog({
          orgId: ctx.org.id,
          actorUserId: ctx.user.id,
          action: "billing.checkout_session.create",
          target: session.sessionId,
          ip: clientIp(req),
          userAgent: req.headers["user-agent"],
          metadata: {
            priceId: parsed.data.priceId,
            seats: parsed.data.seats,
          },
        });

        return { url: session.url, sessionId: session.sessionId };
      } catch (err) {
        if (err instanceof BillingNotConfigured) {
          // Race: provider was configured at the isConfigured() check
          // and not by the time we called createCheckoutSession. In
          // practice this only happens if someone unsets the env mid-
          // request, which shouldn't be possible — pin it as 503 the
          // same way the up-front check does.
          reply.code(503);
          return { error: "billing_not_configured" };
        }
        throw err;
      }
    }
  );
}
