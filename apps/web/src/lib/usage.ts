/**
 * TanStack Query hook + pure helpers for the Settings → Usage page.
 *
 * The hook fetches `/api/orgs/:orgId/usage`. The helpers turn the
 * raw report into UI-friendly numbers (percentages, "remaining"
 * counts, the over-quota indicator) so the React component stays
 * thin and the math gets unit-tested without a DOM.
 */

import { useQuery } from "@tanstack/react-query";
import { api, ApiError, type UsageReport } from "./api";

// ─── Hook ───────────────────────────────────────────────────────────

export function useUsage(orgId: string | undefined) {
  return useQuery({
    enabled: !!orgId,
    queryKey: ["usage", orgId] as const,
    queryFn: async (): Promise<UsageReport> => {
      if (!orgId) throw new Error("usage: orgId required");
      return await api.getUsage(orgId);
    },
    // 30s — short enough that a freshly-burned tool call shows up
    // soon, long enough that a live page doesn't hammer the route.
    staleTime: 30 * 1000,
  });
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * 0..1 fraction of the limit consumed. Returns null when the plan
 * is unlimited (the SPA renders "∞ used" instead of a progress bar).
 *
 * `>= 1` is the "at or over the cap" state. The caller decides how
 * to render it (red bar, banner, etc.).
 */
export function usagePercent(used: number, limit: number | null): number | null {
  if (limit === null) return null; // unlimited
  if (limit <= 0) {
    // No quota allotted (free plan default for some metrics, e.g.
    // export=1 means literally 1; but limit=0 would mean "no
    // allowance at all"). Treat any usage as 100%.
    return used > 0 ? 1 : 0;
  }
  return used / limit;
}

/**
 * "Used N of M" → derived "M − N" remaining, clamped to ≥ 0. Null
 * for unlimited (UI shows "∞ remaining" or hides the field).
 */
export function usageRemaining(
  used: number,
  limit: number | null
): number | null {
  if (limit === null) return null;
  return Math.max(0, limit - used);
}

/**
 * Severity buckets for progress-bar styling. Unlimited never goes
 * into a warning state; finite limits cross thresholds at 75% / 100%.
 *
 * "over" is reachable on overage-allowed plans (Team / Starter /
 * Enterprise) — the customer can keep going past the cap and pay
 * per-unit. On hard-walled plans (free / trialing) the gate refuses
 * the call before it ever reaches recordUsage, so `used` stays at
 * `limit`. Either way the UI surface is the same red-bar treatment.
 */
export type UsageSeverity = "ok" | "warn" | "over";

export function usageSeverity(
  used: number,
  limit: number | null
): UsageSeverity {
  const pct = usagePercent(used, limit);
  if (pct === null) return "ok";
  if (pct >= 1) return "over";
  if (pct >= 0.75) return "warn";
  return "ok";
}

// ─── Error message mapper ───────────────────────────────────────────

export function usageErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "forbidden":
        return "You don't have permission to view usage for this organization.";
      case "not_found":
        return "This organization no longer exists.";
      case "not_authenticated":
        return "Your session has expired. Please log in again.";
      default:
        return err.message || "Could not load usage. Please try again.";
    }
  }
  return "Network error. Please check your connection and retry.";
}
