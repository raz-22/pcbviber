/**
 * Settings → Audit.
 *
 * Renders an org's audit log: timestamp / actor / action / target /
 * IP. Cursor pagination via useInfiniteQuery + a "Load more" button;
 * action-filter dropdown for the most common audit needs.
 *
 * Permissions: owner | admin only (see audit/routes.ts on the
 * server). The route returns 403 for member / billing_only — the
 * page surfaces that via auditErrorMessage.
 */

import { useState } from "react";
import { useAuth } from "../../lib/auth";
import {
  useAuditLog,
  auditErrorMessage,
  formatActor,
  formatAuditAction,
  formatAuditTimestamp,
} from "../../lib/audit";
import type { AuditLogRow } from "../../lib/api";

// Common verbs for the dropdown. Empty string ("All actions") is
// the default. The list is intentionally short — only the verbs
// admins typically filter on. The route accepts any action string,
// so a power user can construct the URL by hand if they want a
// rare verb; we don't try to enumerate them all in the UI.
const ACTION_FILTERS: Array<{ value: string; label: string }> = [
  { value: "", label: "All actions" },
  { value: "signup", label: "Signups" },
  { value: "login", label: "Logins" },
  { value: "logout", label: "Logouts" },
  { value: "workspace.add", label: "Workspace adds" },
  { value: "workspace.update", label: "Workspace updates" },
  { value: "workspace.delete", label: "Workspace deletes" },
  { value: "api_key.create", label: "API key creates" },
  { value: "api_key.revoke", label: "API key revokes" },
  { value: "member.invite", label: "Member invites" },
  { value: "member.role_change", label: "Member role changes" },
  { value: "member.remove", label: "Member removals" },
];

export function AuditSettingsPage() {
  const { me } = useAuth();
  const orgId = me?.orgs[0]?.id;
  const [actionFilter, setActionFilter] = useState<string>("");
  const auditQ = useAuditLog(orgId, {
    action: actionFilter || undefined,
    pageSize: 50,
  });

  if (!me || !orgId) {
    return <p className="text-sm text-slate-500">Loading…</p>;
  }

  // ── Header (always renders, so the filter survives an error state) ──
  const header = (
    <header className="flex items-center justify-between">
      <div>
        <h2 className="text-lg font-semibold">Audit log</h2>
        <p className="mt-1 text-sm text-slate-600">
          Security-relevant events for this organization. Newest first.
        </p>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <span className="text-slate-600">Filter:</span>
        <select
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          className="rounded border border-slate-300 bg-white px-2 py-1 text-sm"
        >
          {ACTION_FILTERS.map((f) => (
            <option key={f.value || "_all"} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </label>
    </header>
  );

  if (auditQ.isLoading) {
    return (
      <div className="space-y-6">
        {header}
        <p className="text-sm text-slate-500">Loading audit log…</p>
      </div>
    );
  }

  if (auditQ.error || !auditQ.data) {
    return (
      <div className="space-y-6">
        {header}
        <p className="text-sm text-rose-700">
          {auditErrorMessage(auditQ.error)}
        </p>
        <button
          type="button"
          className="text-sm text-slate-700 underline"
          onClick={() => void auditQ.refetch()}
        >
          Retry
        </button>
      </div>
    );
  }

  const rows = auditQ.data.pages.flatMap((p) => p.rows);

  return (
    <div className="space-y-6">
      {header}

      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">
          {actionFilter
            ? "No audit events match this filter."
            : "No audit events yet."}
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="py-1 pr-4">Time</th>
              <th className="py-1 pr-4">Actor</th>
              <th className="py-1 pr-4">Action</th>
              <th className="py-1 pr-4">Target</th>
              <th className="py-1 pr-4">IP</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {rows.map((r) => (
              <AuditRowView key={r.id} row={r} />
            ))}
          </tbody>
        </table>
      )}

      {auditQ.hasNextPage && (
        <div className="flex justify-center">
          <button
            type="button"
            disabled={auditQ.isFetchingNextPage}
            onClick={() => void auditQ.fetchNextPage()}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {auditQ.isFetchingNextPage ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}

interface AuditRowViewProps {
  row: AuditLogRow;
}

function AuditRowView({ row }: AuditRowViewProps) {
  // metadata can be a parsed object, a raw string (corrupt-row
  // fallback), or null. Render an inspector toggle only when it's
  // present — empty/null rows would clutter the table with disabled
  // chevrons.
  const hasMeta = row.metadata !== null && row.metadata !== undefined;

  return (
    <tr className="align-top">
      <td className="whitespace-nowrap py-1.5 pr-4 text-slate-600">
        {formatAuditTimestamp(row.timestamp)}
      </td>
      <td className="py-1.5 pr-4 text-slate-700">{formatActor(row.actor)}</td>
      <td className="py-1.5 pr-4 font-medium text-slate-900">
        {formatAuditAction(row.action)}
        {hasMeta && (
          <details className="mt-1">
            <summary className="cursor-pointer text-xs text-slate-500">
              metadata
            </summary>
            <pre className="mt-1 max-w-md overflow-x-auto rounded bg-slate-50 px-2 py-1 text-[11px] text-slate-700">
              {typeof row.metadata === "string"
                ? row.metadata
                : JSON.stringify(row.metadata, null, 2)}
            </pre>
          </details>
        )}
      </td>
      <td className="py-1.5 pr-4 text-slate-600">
        {row.target ? (
          <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">
            {row.target}
          </code>
        ) : (
          <span className="text-slate-400">—</span>
        )}
      </td>
      <td className="whitespace-nowrap py-1.5 pr-4 text-xs text-slate-500">
        {row.ip ?? "—"}
      </td>
    </tr>
  );
}
