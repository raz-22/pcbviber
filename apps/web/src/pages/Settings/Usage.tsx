/**
 * Settings → Usage.
 *
 * Renders the org's current-period consumption: per-metric progress
 * bars (used / limit / overage indicator), per-tool breakdown table.
 * The math lives in lib/usage.ts so the React side stays declarative.
 *
 * Permissions: any role with `usage.read` can hit this page —
 * including billing_only (finance teams need budget visibility per
 * spec §3.4). The server returns 403 if the role can't read; the
 * page surfaces that via usageErrorMessage.
 *
 * "Manage billing" CTA reuses the existing /settings/billing flow
 * (Stripe Customer Portal) — no separate Stripe link.
 */

import { useAuth } from "../../lib/auth";
import {
  useUsage,
  usageErrorMessage,
  usagePercent,
  usageRemaining,
  usageSeverity,
  type UsageSeverity,
} from "../../lib/usage";

const METRIC_LABELS: Record<string, string> = {
  bom_lookup: "BOM lookups",
  cost_analysis: "Cost analyses",
  export: "Manufacturing exports",
};

const TOOL_LABELS: Record<string, string> = {
  search_parts: "Search parts",
  check_part_availability: "Check availability",
  find_alternative_parts: "Find alternatives",
  get_project_bom: "Get project BOM",
  analyze_bom_cost: "Analyze BOM cost",
  export_manufacturing_data: "Export manufacturing data",
};

export function UsageSettingsPage() {
  const { me } = useAuth();
  const orgId = me?.orgs[0]?.id;
  const usageQ = useUsage(orgId);

  if (!me || !orgId) {
    return <p className="text-sm text-slate-500">Loading…</p>;
  }

  if (usageQ.isLoading) {
    return <p className="text-sm text-slate-500">Loading usage…</p>;
  }

  if (usageQ.error || !usageQ.data) {
    return (
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Usage</h2>
        <p className="text-sm text-rose-700">
          {usageErrorMessage(usageQ.error)}
        </p>
        <button
          type="button"
          className="text-sm text-slate-700 underline"
          onClick={() => void usageQ.refetch()}
        >
          Retry
        </button>
      </div>
    );
  }

  const report = usageQ.data;
  const periodStart = new Date(report.period.start).toLocaleDateString();
  const periodEnd = new Date(report.period.end).toLocaleDateString();

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Usage</h2>
          <button
            type="button"
            className="text-xs text-slate-600 underline"
            onClick={() => void usageQ.refetch()}
          >
            Refresh
          </button>
        </div>
        <p className="text-sm text-slate-600">
          Current period: <strong>{periodStart}</strong> →{" "}
          <strong>{periodEnd}</strong>. Plan:{" "}
          <strong>{report.plan.name}</strong>
          {report.plan.overageAllowed ? (
            <span className="ml-2 rounded bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">
              overage allowed
            </span>
          ) : (
            <span className="ml-2 rounded bg-amber-50 px-2 py-0.5 text-xs text-amber-800">
              hard quota
            </span>
          )}
        </p>
      </header>

      <section className="space-y-4">
        <h3 className="text-sm font-medium uppercase tracking-wide text-slate-500">
          Metrics
        </h3>
        <ul className="space-y-3">
          {Object.entries(report.metrics).map(([metric, m]) => (
            <li key={metric}>
              <MetricBar
                label={METRIC_LABELS[metric] ?? metric}
                used={m.used}
                limit={m.limit}
                overageAllowed={report.plan.overageAllowed}
              />
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-medium uppercase tracking-wide text-slate-500">
          By tool
        </h3>
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="py-1">Tool</th>
              <th className="py-1 text-right">Calls</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {Object.entries(report.byTool).map(([tool, count]) => (
              <tr key={tool}>
                <td className="py-1.5 text-slate-700">
                  {TOOL_LABELS[tool] ?? tool}
                </td>
                <td className="py-1.5 text-right tabular-nums text-slate-900">
                  {count}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

interface MetricBarProps {
  label: string;
  used: number;
  limit: number | null;
  overageAllowed: boolean;
}

function MetricBar({ label, used, limit, overageAllowed }: MetricBarProps) {
  const pct = usagePercent(used, limit);
  const remaining = usageRemaining(used, limit);
  const severity = usageSeverity(used, limit);
  const barWidthPct = pct === null ? 0 : Math.min(100, Math.round(pct * 100));

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-sm">
        <span className="font-medium text-slate-800">{label}</span>
        <span className="tabular-nums text-slate-600">
          {used.toLocaleString()} /{" "}
          {limit === null ? "∞" : limit.toLocaleString()}
          {limit !== null && (
            <span className="ml-2 text-xs text-slate-500">
              {remaining ?? 0} remaining
            </span>
          )}
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded bg-slate-100">
        {pct !== null && (
          <div
            className={severityClass(severity)}
            style={{ width: `${barWidthPct}%` }}
          />
        )}
      </div>
      {severity === "over" && !overageAllowed && (
        <p className="mt-1 text-xs text-rose-700">
          Quota exhausted — further calls will return 429 until the next
          period or you upgrade.
        </p>
      )}
      {severity === "over" && overageAllowed && (
        <p className="mt-1 text-xs text-amber-700">
          Over included quota — additional calls bill as overage.
        </p>
      )}
    </div>
  );
}

function severityClass(s: UsageSeverity): string {
  // Full-height block; color matches the lib's severity buckets so
  // the page stays in sync with the math without duplicating
  // thresholds.
  const base = "h-full transition-all";
  switch (s) {
    case "ok":
      return `${base} bg-emerald-500`;
    case "warn":
      return `${base} bg-amber-500`;
    case "over":
      return `${base} bg-rose-500`;
  }
}
