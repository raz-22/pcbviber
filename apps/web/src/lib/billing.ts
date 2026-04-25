/**
 * TanStack Query hooks for /api/billing/*.
 *
 * The SPA flow:
 *   1. Settings → Billing page (or banner CTA) calls
 *      useCreateCheckoutSession or useCreatePortalSession
 *   2. Server returns a Stripe-hosted URL
 *   3. SPA does `window.location.href = url` — the user lands on
 *      Stripe's domain. After they're done, Stripe redirects them
 *      back to /settings/billing where /me re-fetches and the new
 *      billingStatus surfaces.
 */

import {
  useMutation,
  useQuery,
} from "@tanstack/react-query";
import {
  api,
  ApiError,
  type BillingPlan,
  type CheckoutSessionInput,
} from "./api";

// ─── Queries ─────────────────────────────────────────────────────────

export function useBillingPlans() {
  return useQuery({
    queryKey: ["billing", "plans"] as const,
    queryFn: async (): Promise<BillingPlan[]> => {
      const res = await api.listBillingPlans();
      return res.plans;
    },
    // Plans change rarely; long staleTime saves redundant calls.
    staleTime: 10 * 60 * 1000,
  });
}

// ─── Mutations ───────────────────────────────────────────────────────

export function useCreateCheckoutSession(orgId: string) {
  return useMutation({
    mutationFn: (input: CheckoutSessionInput) =>
      api.createCheckoutSession(orgId, input),
  });
}

export function useCreatePortalSession(orgId: string) {
  return useMutation({
    mutationFn: () => api.createPortalSession(orgId),
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Number of whole days between now and `trialEndsAt`. Negative if the
 * deadline is in the past. Used by the banner countdown.
 *
 * Pure function — testable without fixing system time. Tests pass
 * `now` explicitly.
 */
export function trialDaysLeft(
  trialEndsAt: string | null,
  now: Date = new Date()
): number | null {
  if (!trialEndsAt) return null;
  const end = new Date(trialEndsAt).getTime();
  if (!Number.isFinite(end)) return null;
  // Round UP — if 12 hours remain, "1 day left" is the friendlier
  // surface than "0 days left". When it goes negative the banner
  // switches to a different state anyway.
  const ms = end - now.getTime();
  return Math.ceil(ms / (24 * 60 * 60 * 1000));
}

/**
 * Returns the "severity" of a billing status for banner styling.
 * Keeps the per-status copy + colors consolidated in one place so
 * BillingBanner doesn't have to know the policy.
 */
export type BillingSeverity = "none" | "info" | "warning" | "critical";

export function billingSeverity(billingStatus: string): BillingSeverity {
  switch (billingStatus) {
    case "active":
    case "free":
      return "none";
    case "trialing":
      return "info";
    case "past_due":
      return "warning";
    case "suspended":
    case "canceled":
      return "critical";
    default:
      // Unknown statuses get info-level treatment so an SPA running
      // older code than the server doesn't accidentally hide them.
      return "info";
  }
}

// ─── Error message mapper ────────────────────────────────────────────

export function billingErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "billing_not_configured":
        return "Billing isn't configured for this environment.";
      case "billing_upstream_error":
        return "Stripe is temporarily unavailable. Please try again in a moment.";
      case "invalid_price":
        return "That plan isn't available. Pick a different one.";
      case "not_yet_subscribed":
        return "Subscribe first — there's no billing to manage yet.";
      case "billing_inactive":
        return "Your subscription is paused. Update payment to restore access.";
      case "forbidden":
        return "Only the org owner can change billing.";
      case "not_authenticated":
        return "Your session has expired. Please log in again.";
      case "invalid_input":
        return "Some fields are invalid. Check the form and try again.";
      default:
        return err.message || "Something went wrong. Please try again.";
    }
  }
  return "Network error. Please check your connection and retry.";
}
