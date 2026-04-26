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

// ─── CSV export ─────────────────────────────────────────────────────

/**
 * Trigger a CSV download of the audit log for `orgId`. The browser
 * receives a `text/csv` body with a `Content-Disposition: attachment`
 * header; we still wrap the response in a Blob + anchor click so the
 * download starts even when the browser would have rendered the CSV
 * inline (Safari's default for `text/csv`).
 *
 * Throws an `ApiError` (or a plain `Error` for network issues) on
 * failure — the caller maps it to a UI message via `auditErrorMessage`.
 */
export async function downloadAuditCsv(
  orgId: string,
  action?: string
): Promise<void> {
  const qs = new URLSearchParams();
  if (action) qs.set("action", action);
  const tail = qs.toString() ? `?${qs}` : "";
  const url = `/api/orgs/${encodeURIComponent(orgId)}/audit/export.csv${tail}`;
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    // Try to mirror the ApiError shape — JSON body if present, else
    // a synthesized message. The audit-error mapper covers both.
    let code: string | null = null;
    let detail: unknown = null;
    try {
      const body = (await res.json()) as { error?: string; detail?: unknown };
      code = typeof body.error === "string" ? body.error : null;
      detail = body.detail ?? null;
    } catch {
      /* non-JSON failure — keep code null */
    }
    throw new ApiError(
      res.status,
      code,
      detail,
      code ?? `${res.status} ${res.statusText}`.trim() ?? "export failed"
    );
  }
  // Filename is provided by Content-Disposition; if browsers strip it,
  // fall back to a sane default. We parse the header for the value.
  const cd = res.headers.get("Content-Disposition") ?? "";
  const filenameMatch = /filename="([^"]+)"/i.exec(cd);
  const filename = filenameMatch?.[1] ?? `audit-${orgId}.csv`;
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

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
 * Auto-format an action verb into a readable label. Examples:
 *   "signup"               → "Signup"
 *   "workspace.add"        → "Workspace · Add"
 *   "member.role_change"   → "Member · Role change"
 *   "billing.checkout_session.create"
 *                          → "Billing · Checkout session · Create"
 *
 * Mechanical: split on `.`, replace `_` with space, capitalize each
 * segment. New actions appear correctly without a code change.
 */
export function formatAuditAction(action: string): string {
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
