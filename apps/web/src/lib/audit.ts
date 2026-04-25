/**
 * TanStack Query hook + pure helpers for the Settings → Audit page.
 *
 * The hook fetches `/api/orgs/:orgId/audit` paginated. Helpers turn
 * raw rows into UI-friendly strings (action label, actor display,
 * timestamp). The math / formatting lives here so the React side
 * stays declarative + the formatters get unit-tested without a DOM.
 */

import { useInfiniteQuery } from "@tanstack/react-query";
import { api, ApiError, type AuditLogResponse, type AuditLogRow } from "./api";

// ─── Hook ───────────────────────────────────────────────────────────

export function useAuditLog(
  orgId: string | undefined,
  opts: { action?: string; pageSize?: number } = {}
) {
  // Action filter is part of the cache key so a filter change
  // refetches (rather than mixing pages from different filters).
  return useInfiniteQuery({
    enabled: !!orgId,
    queryKey: ["audit", orgId, opts.action ?? null, opts.pageSize ?? 50] as const,
    queryFn: async ({ pageParam }: { pageParam: string | null }) => {
      if (!orgId) throw new Error("audit: orgId required");
      return await api.getAuditLog(orgId, {
        cursor: pageParam ?? undefined,
        action: opts.action,
        limit: opts.pageSize ?? 50,
      });
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last: AuditLogResponse) => last.nextCursor ?? null,
    // 15s — audit rows are append-only and not high-frequency; a
    // short stale window keeps the page responsive without
    // hammering the route.
    staleTime: 15 * 1000,
  });
}

// ─── Action label ───────────────────────────────────────────────────

/**
 * Auto-format an action verb into a readable label without a fixed
 * lookup table. Examples:
 *   "signup"               → "Signup"
 *   "workspace.add"        → "Workspace · Add"
 *   "member.role_change"   → "Member · Role change"
 *   "billing.checkout_session.create"
 *                          → "Billing · Checkout session · Create"
 *
 * No code change needed when a new action verb appears in the audit
 * log — the formatting is mechanical. If a specific verb deserves a
 * customized label later, add it to the labels map below; otherwise
 * the auto-formatter is the fallback.
 */
const ACTION_LABEL_OVERRIDES: Record<string, string> = {
  // Reserved — empty for now. Add only when the auto-format is
  // genuinely confusing for end users.
};

export function formatAuditAction(action: string): string {
  const override = ACTION_LABEL_OVERRIDES[action];
  if (override) return override;
  return action
    .split(".")
    .map((segment) => {
      const spaced = segment.replace(/_/g, " ");
      return spaced.length > 0
        ? spaced[0]!.toUpperCase() + spaced.slice(1)
        : spaced;
    })
    .join(" · ");
}

// ─── Actor display ──────────────────────────────────────────────────

/**
 * Render the actor as text. "System" when the actor is null —
 * either because the user was deleted (FK SetNull) or because the
 * action was performed by the server itself (e.g. a Stripe webhook
 * tripping a billing-status update).
 */
export function formatActor(actor: AuditLogRow["actor"]): string {
  if (!actor) return "System";
  return actor.email;
}

// ─── Timestamp ──────────────────────────────────────────────────────

/**
 * Locale-aware human-readable timestamp. Falls back to the raw ISO
 * string if the input is unparseable — defense against bad data
 * without breaking the row's other fields.
 */
export function formatAuditTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // Default locale + time zone — the user is reading their own data
  // from their own browser, so date-fns / luxon would just bloat the
  // bundle without adding value here.
  return d.toLocaleString();
}

// ─── Error message mapper ──────────────────────────────────────────

export function auditErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "forbidden":
        return "Only admins and owners can view the audit log.";
      case "not_found":
        return "This organization no longer exists.";
      case "not_authenticated":
        return "Your session has expired. Please log in again.";
      default:
        return err.message || "Could not load audit log. Please try again.";
    }
  }
  return "Network error. Please check your connection and retry.";
}
