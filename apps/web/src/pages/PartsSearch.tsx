import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { PartSearchResult } from "@altium-mcp/shared";
import { api } from "../lib/api";

export function PartsSearch() {
  const [searchInput, setSearchInput] = useState("");
  const [activeQuery, setActiveQuery] = useState<string | null>(null);
  const [expandedMpn, setExpandedMpn] = useState<string | null>(null);

  const [mpnInput, setMpnInput] = useState("");
  const [activeMpn, setActiveMpn] = useState<string | null>(null);

  const searchQ = useQuery({
    queryKey: ["search", activeQuery],
    queryFn: () => api.searchParts(activeQuery!, 10),
    enabled: !!activeQuery,
  });

  const availQ = useQuery({
    queryKey: ["availability", activeMpn],
    queryFn: () => api.checkAvailability(activeMpn!),
    enabled: !!activeMpn,
  });

  return (
    <div className="space-y-10">
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
            className="flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
            placeholder="e.g. 100uF 25V MLCC, STM32F407, LM358"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
          <button
            type="submit"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
            disabled={!searchInput.trim()}
          >
            Search
          </button>
        </form>

        <div className="mt-5">
          {searchQ.isLoading && <p className="text-sm text-slate-500">Searching…</p>}
          {searchQ.error && (
            <p className="text-sm text-red-600">
              Error: {(searchQ.error as Error).message}
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
            className="flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
            placeholder="Exact MPN, e.g. STM32F407VGT6"
            value={mpnInput}
            onChange={(e) => setMpnInput(e.target.value)}
          />
          <button
            type="submit"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
            disabled={!mpnInput.trim()}
          >
            Check
          </button>
        </form>

        <div className="mt-5">
          {availQ.isLoading && <p className="text-sm text-slate-500">Checking…</p>}
          {availQ.error && (
            <p className="text-sm text-red-600">
              Error: {(availQ.error as Error).message}
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
