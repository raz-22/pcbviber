/**
 * Billing routes.
 *
 *   POST /api/orgs/:orgId/billing/checkout-session  — owner only
 *   POST /api/orgs/:orgId/billing/portal-session    — owner only
 *
 * checkout-session: validates priceId against an env-derived allow-list
 * and signs the Stripe `client_reference_id` so the webhook can verify
 * tenant attribution.
 *
 * portal-session: hands the user a Stripe-hosted Customer Portal URL
 * for plan switches, seat changes, payment-method updates, and
 * cancellation. Cancellations come back through the webhook handler
 * (`customer.subscription.deleted`) — the loop closes itself.
 *
 * Stable error codes:
 *   not_authenticated  forbidden  invalid_input
 *   billing_not_configured  — STRIPE_SECRET_KEY isn't set
 *   invalid_price           — body.priceId isn't on the env allow-list
 *   not_yet_subscribed      — portal-session called on an org with no
 *                              billingCustomerId (never completed a
 *                              checkout). The SPA should route the
 *                              user to checkout-session instead.
 *   billing_upstream_error  — Stripe's API errored (network, declined,
 *                              rate-limited, etc). Detail is logged
 *                              server-side; not included in the body
 *                              because Stripe error messages can echo
 *                              customer + payment context.
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
        // Generic Stripe failure: network glitch, rate limit, declined
        // card, invalid price metadata, etc. Log server-side; surface
        // a stable code without echoing Stripe's message — those can
        // include customer + payment-method context that doesn't
        // belong on the wire to a SPA.
        req.log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "billing checkout-session upstream error"
        );
        reply.code(502);
        return { error: "billing_upstream_error" };
      }
    }
  );

  // ── POST /api/orgs/:orgId/billing/portal-session ─────────────────────
  app.post(
    "/api/orgs/:orgId/billing/portal-session",
    { preHandler: [requireAuth, requireMember] },
    async (req, reply) => {
      const ctx = req.ctx!;

      if (!can({ userId: ctx.user.id, role: ctx.role }, "billing.portal_manage")) {
        reply.code(403);
        return { error: "forbidden" };
      }

      if (!deps.billing.isConfigured()) {
        reply.code(503);
        return { error: "billing_not_configured" };
      }

      // The Customer Portal is for an existing customer — the org's
      // billingCustomerId gets set by the webhook handler when their
      // first Checkout completes. Pre-checkout orgs have no customer
      // record on Stripe's side, so the portal call would fail; we
      // return a distinct 409 the SPA can map to "Subscribe first".
      const org = await prisma.organization.findUnique({
        where: { id: ctx.org.id },
        select: { billingCustomerId: true },
      });
      if (!org?.billingCustomerId) {
        reply.code(409);
        return { error: "not_yet_subscribed" };
      }

      try {
        const session = await deps.billing.createPortalSession({
          customerId: org.billingCustomerId,
          // Where the user lands when they click "Return to <site>".
          // Settings → Billing is the natural home; the SPA refetches
          // /me on mount, picking up any status changes the user made
          // in the portal (cancellation surfaces via the webhook a
          // moment later, but the page render is independent).
          returnUrl: `${deps.appBaseUrl}/settings/billing`,
        });

        await writeAuditLog({
          orgId: ctx.org.id,
          actorUserId: ctx.user.id,
          action: "billing.portal_session.create",
          ip: clientIp(req),
          userAgent: req.headers["user-agent"],
          metadata: { customerId: org.billingCustomerId },
        });

        return { url: session.url };
      } catch (err) {
        if (err instanceof BillingNotConfigured) {
          reply.code(503);
          return { error: "billing_not_configured" };
        }
        req.log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "billing portal-session upstream error"
        );
        reply.code(502);
        return { error: "billing_upstream_error" };
      }
    }
  );
}
