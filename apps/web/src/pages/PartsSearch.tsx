/**
 * Parts Search — rewritten in PR 2.4 to run against a tenant-scoped
 * workspace (PR 2.3 routes). The workspace selector at the top is the
 * single source of truth; all subsequent queries key off the chosen
 * workspaceId so switching workspaces doesn't show stale results.
 *
 * Empty / pre-config states:
 *   - no workspaces in the org    → CTA to Settings
 *   - selected workspace has no
 *     Nexar creds                 → inline warning, query disabled
 */

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { PartSearchResult } from "@altium-mcp/shared";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useWorkspaces, workspaceErrorMessage } from "../lib/workspaces";

export function PartsSearch() {
  const { me } = useAuth();
  const orgId = me?.orgs[0]?.id;
  const wsQ = useWorkspaces(orgId);

  const [workspaceId, setWorkspaceId] = useState<string | null>(null);

  // Auto-select the first configured workspace once the list loads.
  // Prefer one with Nexar creds — otherwise the user lands on a 503 by
  // default. Falls back to the first if none are configured (so the
  // selector still shows something to switch from).
  useEffect(() => {
    if (workspaceId) return;
    const list = wsQ.data;
    if (!list || list.length === 0) return;
    const configured = list.find((w) => w.hasNexarCredentials);
    setWorkspaceId(configured?.id ?? list[0].id);
  }, [wsQ.data, workspaceId]);

  const selected = wsQ.data?.find((w) => w.id === workspaceId) ?? null;
  const canQuery = !!orgId && !!selected && selected.hasNexarCredentials;

  const [searchInput, setSearchInput] = useState("");
  const [activeQuery, setActiveQuery] = useState<string | null>(null);
  const [expandedMpn, setExpandedMpn] = useState<string | null>(null);

  const [mpnInput, setMpnInput] = useState("");
  const [activeMpn, setActiveMpn] = useState<string | null>(null);

  const searchQ = useQuery({
    queryKey: ["search", orgId, workspaceId, activeQuery],
    queryFn: () => api.searchParts(orgId!, workspaceId!, activeQuery!, 10),
    enabled: !!activeQuery && canQuery,
  });

  const availQ = useQuery({
    queryKey: ["availability", orgId, workspaceId, activeMpn],
    queryFn: () => api.checkAvailability(orgId!, workspaceId!, activeMpn!),
    enabled: !!activeMpn && canQuery,
  });

  if (!me || !orgId) return null;

  return (
    <div className="space-y-8">
      <WorkspacePicker
        wsQ={wsQ}
        workspaceId={workspaceId}
        onChange={(id) => {
          setWorkspaceId(id);
          // Clear active queries — they were keyed to the old workspace.
          setActiveQuery(null);
          setActiveMpn(null);
          setExpandedMpn(null);
        }}
      />

      {wsQ.data && wsQ.data.length === 0 && (
        <EmptyWorkspacesNotice />
      )}

      {selected && !selected.hasNexarCredentials && (
        <NotConfiguredNotice />
      )}

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-600 mb-3">
          Search parts
        </h2>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setActiveQuery(searchInput.trim() || null);
            setExpandedMpn(null);
          }}
        >
          <input
            className="flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 disabled:bg-slate-50"
            placeholder="e.g. 100uF 25V MLCC, STM32F407, LM358"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            disabled={!canQuery}
          />
          <button
            type="submit"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
            disabled={!searchInput.trim() || !canQuery}
          >
            Search
          </button>
        </form>

        <div className="mt-5">
          {searchQ.isLoading && <p className="text-sm text-slate-500">Searching…</p>}
          {searchQ.error && (
            <p className="text-sm text-red-600">
              {workspaceErrorMessage(searchQ.error)}
            </p>
          )}
          {searchQ.data && searchQ.data.length > 0 && (
            <ResultsTable
              results={searchQ.data}
              expandedMpn={expandedMpn}
              onToggle={(mpn) => setExpandedMpn(expandedMpn === mpn ? null : mpn)}
            />
          )}
          {searchQ.data && searchQ.data.length === 0 && (
            <p className="text-sm text-slate-500">No results.</p>
          )}
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-600 mb-3">
          Check availability by MPN
        </h2>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setActiveMpn(mpnInput.trim() || null);
          }}
        >
          <input
            className="flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 disabled:bg-slate-50"
            placeholder="Exact MPN, e.g. STM32F407VGT6"
            value={mpnInput}
            onChange={(e) => setMpnInput(e.target.value)}
            disabled={!canQuery}
          />
          <button
            type="submit"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
            disabled={!mpnInput.trim() || !canQuery}
          >
            Check
          </button>
        </form>

        <div className="mt-5">
          {availQ.isLoading && <p className="text-sm text-slate-500">Checking…</p>}
          {availQ.error && (
            <p className="text-sm text-red-600">
              {workspaceErrorMessage(availQ.error)}
            </p>
          )}
          {availQ.data && "notFound" in availQ.data && (
            <p className="text-sm text-slate-500">
              No data for <code className="font-mono">{availQ.data.mpn}</code>.
            </p>
          )}
          {availQ.data && !("notFound" in availQ.data) && (
            <AvailabilityCard data={availQ.data} />
          )}
        </div>
      </section>
    </div>
  );
}

// ─── Workspace picker + notices ──────────────────────────────────────

function WorkspacePicker({
  wsQ,
  workspaceId,
  onChange,
}: {
  wsQ: ReturnType<typeof useWorkspaces>;
  workspaceId: string | null;
  onChange: (id: string) => void;
}) {
  if (wsQ.isLoading) {
    return <p className="text-sm text-slate-500">Loading workspaces…</p>;
  }
  if (wsQ.error) {
    return (
      <p className="text-sm text-red-600">{workspaceErrorMessage(wsQ.error)}</p>
    );
  }
  if (!wsQ.data || wsQ.data.length === 0) return null;

  return (
    <div className="flex items-center gap-3">
      <label className="text-sm text-slate-700">Workspace</label>
      <select
        className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
        value={workspaceId ?? ""}
        onChange={(e) => onChange(e.target.value)}
      >
        {wsQ.data.map((w) => (
          <option key={w.id} value={w.id}>
            {w.altiumWorkspaceUrl ?? w.id}
            {w.hasNexarCredentials ? "" : " (not configured)"}
          </option>
        ))}
      </select>
      <Link to="/settings/workspaces" className="text-xs text-blue-600 hover:underline">
        Manage…
      </Link>
    </div>
  );
}

function EmptyWorkspacesNotice() {
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-5 text-sm text-amber-900">
      <p className="font-medium">No workspaces yet</p>
      <p className="mt-1">
        Parts Search needs a workspace with Nexar credentials.{" "}
        <Link
          to="/settings/workspaces"
          className="font-medium text-amber-900 underline"
        >
          Create one in Settings
        </Link>
        .
      </p>
    </div>
  );
}

function NotConfiguredNotice() {
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-5 text-sm text-amber-900">
      <p>
        This workspace has no Nexar credentials.{" "}
        <Link
          to="/settings/workspaces"
          className="font-medium text-amber-900 underline"
        >
          Add them in Settings
        </Link>
        .
      </p>
    </div>
  );
}

// ─── Result + availability tables (unchanged from prior version) ─────

function ResultsTable({
  results,
  expandedMpn,
  onToggle,
}: {
  results: PartSearchResult[];
  expandedMpn: string | null;
  onToggle: (mpn: string) => void;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-slate-600">
          <tr>
            <th className="px-4 py-2 text-left font-medium">MPN</th>
            <th className="px-4 py-2 text-left font-medium">Manufacturer</th>
            <th className="px-4 py-2 text-left font-medium">Description</th>
            <th className="px-4 py-2 text-right font-medium">Best price</th>
            <th className="px-4 py-2 text-right font-medium">Total stock</th>
            <th className="px-4 py-2 text-left font-medium">Datasheet</th>
          </tr>
        </thead>
        <tbody>
          {results.map((part) => {
            const totalStock = part.offers.reduce((s, o) => s + o.stock, 0);
            const best = bestOffer(part);
            const isOpen = expandedMpn === part.mpn;
            return (
              <>
                <tr
                  key={part.mpn}
                  onClick={() => onToggle(part.mpn)}
                  className="cursor-pointer border-t border-slate-100 hover:bg-slate-50"
                >
                  <td className="px-4 py-2 font-mono text-xs">{part.mpn}</td>
                  <td className="px-4 py-2">{part.manufacturer}</td>
                  <td className="px-4 py-2 text-slate-600">{part.description}</td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {best ? `${best.currency} ${best.price.toFixed(4)}` : "—"}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {totalStock.toLocaleString()}
                  </td>
                  <td className="px-4 py-2">
                    {part.datasheetUrl ? (
                      <a
                        href={part.datasheetUrl}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="text-blue-600 hover:underline"
                      >
                        PDF
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
                {isOpen && (
                  <tr key={part.mpn + "-expanded"} className="bg-slate-50">
                    <td colSpan={6} className="px-4 py-3">
                      <OffersTable offers={part.offers} />
                    </td>
                  </tr>
                )}
              </>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function OffersTable({ offers }: { offers: PartSearchResult["offers"] }) {
  if (offers.length === 0) {
    return <p className="text-xs text-slate-500">No supplier offers.</p>;
  }
  return (
    <table className="w-full text-xs">
      <thead className="text-slate-500">
        <tr>
          <th className="px-2 py-1 text-left font-medium">Supplier</th>
          <th className="px-2 py-1 text-left font-medium">SKU</th>
          <th className="px-2 py-1 text-right font-medium">Stock</th>
          <th className="px-2 py-1 text-right font-medium">MOQ</th>
          <th className="px-2 py-1 text-right font-medium">Lead (days)</th>
          <th className="px-2 py-1 text-left font-medium">Price tiers</th>
        </tr>
      </thead>
      <tbody>
        {offers.map((o, i) => (
          <tr key={o.supplier + o.sku + i} className="border-t border-slate-200">
            <td className="px-2 py-1">{o.supplier}</td>
            <td className="px-2 py-1 font-mono">{o.sku}</td>
            <td className="px-2 py-1 text-right tabular-nums">
              {o.stock.toLocaleString()}
            </td>
            <td className="px-2 py-1 text-right tabular-nums">{o.moq}</td>
            <td className="px-2 py-1 text-right tabular-nums">
              {o.leadTimeDays ?? "—"}
            </td>
            <td className="px-2 py-1">
              {o.prices
                .slice(0, 3)
                .map((p) => `${p.quantity}+: ${p.currency} ${p.price.toFixed(4)}`)
                .join("  ·  ") || "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AvailabilityCard({
  data,
}: {
  data: Extract<
    Awaited<ReturnType<typeof api.checkAvailability>>,
    { mpn: string; suppliers: unknown[] }
  >;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="font-mono text-base">{data.mpn}</h3>
          <p className="text-sm text-slate-600">
            {data.manufacturer} — {data.description}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Lifecycle: {data.lifecycle} · Total stock:{" "}
            <span className="tabular-nums">{data.totalStock.toLocaleString()}</span>
          </p>
        </div>
        {data.datasheetUrl && (
          <a
            href={data.datasheetUrl}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-blue-600 hover:underline"
          >
            Datasheet
          </a>
        )}
      </div>
      <div className="mt-4 overflow-hidden rounded border border-slate-200">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="px-2 py-1 text-left font-medium">Supplier</th>
              <th className="px-2 py-1 text-left font-medium">SKU</th>
              <th className="px-2 py-1 text-right font-medium">Stock</th>
              <th className="px-2 py-1 text-right font-medium">MOQ</th>
              <th className="px-2 py-1 text-right font-medium">Lead (days)</th>
              <th className="px-2 py-1 text-left font-medium">Best price</th>
            </tr>
          </thead>
          <tbody>
            {data.suppliers.map((s, i) => (
              <tr key={s.supplier + s.sku + i} className="border-t border-slate-100">
                <td className="px-2 py-1">{s.supplier}</td>
                <td className="px-2 py-1 font-mono">{s.sku}</td>
                <td className="px-2 py-1 text-right tabular-nums">
                  {s.stock.toLocaleString()}
                </td>
                <td className="px-2 py-1 text-right tabular-nums">{s.moq}</td>
                <td className="px-2 py-1 text-right tabular-nums">
                  {s.leadTimeDays ?? "—"}
                </td>
                <td className="px-2 py-1">{s.bestPrice}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function bestOffer(part: PartSearchResult) {
  let best: { price: number; currency: string } | null = null;
  for (const o of part.offers) {
    for (const p of o.prices) {
      if (best === null || p.price < best.price) {
        best = { price: p.price, currency: p.currency };
      }
    }
  }
  return best;
}
