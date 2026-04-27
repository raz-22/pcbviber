/**
 * Public status page.
 *
 * Polls /api/health every 30s. The endpoint returns a stable shape
 * (see http.ts) — overall ok flag + per-dependency { ok, detail }.
 * We render one row per dependency with a green/red dot.
 *
 * Deliberately minimal: this is a public probe, not an internal
 * dashboard. For real incident comms (timelines, RCA write-ups)
 * use a hosted status page — see docs/launch/registry-submission.md
 * for the recommendation. This page is the "is the API up right now"
 * view that customers and uptime monitors hit.
 *
 * Public route — no auth required. Linked from the footer.
 */

import { useEffect, useState } from "react";

interface Health {
  ok: boolean;
  name: string;
  version: string;
  uptimeSeconds: number;
  checkedAt: string;
  dependencies: Record<string, { ok: boolean; detail?: string }>;
}

const POLL_INTERVAL_MS = 30_000;

export function StatusPage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<Date | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch("/api/health", { credentials: "include" });
        if (!res.ok) {
          throw new Error(`API returned ${res.status}`);
        }
        const json: Health = await res.json();
        if (!cancelled) {
          setHealth(json);
          setError(null);
          setLastFetched(new Date());
        }
      } catch (e) {
        if (!cancelled) {
          // A failure to even reach /api/health is itself a status
          // signal — the API is down or the network is partitioned.
          setError(e instanceof Error ? e.message : String(e));
          setHealth(null);
          setLastFetched(new Date());
        }
      }
    }
    poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <article className="mx-auto max-w-3xl px-6 py-12">
      <header className="mb-8">
        <p className="text-xs font-semibold uppercase tracking-widest text-blue-600">
          Status
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">
          Service status
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          Live probe of the PCBviber API and its dependencies. Polled
          every 30 seconds. For incident history and post-mortems,{" "}
          <a
            href="mailto:support@pcbviber.example"
            className="text-blue-700 underline"
          >
            email support
          </a>
          .
        </p>
      </header>

      {/* ── Overall ───────────────────────────────────────────────── */}
      <Banner health={health} error={error} />

      {/* ── Per-dependency ────────────────────────────────────────── */}
      {health && (
        <section className="mt-8 rounded-lg border border-slate-200 bg-white">
          <h2 className="border-b border-slate-200 px-5 py-3 text-sm font-semibold text-slate-700">
            Components
          </h2>
          <ul>
            {Object.entries(health.dependencies).map(([name, dep]) => (
              <li
                key={name}
                className="flex items-center justify-between border-b border-slate-100 px-5 py-3 last:border-0"
              >
                <div className="flex items-center gap-3">
                  <Dot ok={dep.ok} />
                  <span className="text-sm font-medium capitalize text-slate-800">
                    {name}
                  </span>
                </div>
                <span className="text-xs text-slate-500">
                  {dep.detail ?? (dep.ok ? "ok" : "down")}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ── Meta ──────────────────────────────────────────────────── */}
      <section className="mt-8 grid gap-4 rounded-lg border border-slate-200 bg-slate-50 p-5 text-sm sm:grid-cols-3">
        <Meta
          label="Server version"
          value={health?.version ?? "—"}
        />
        <Meta
          label="Uptime"
          value={
            health ? humanizeSeconds(health.uptimeSeconds) : "—"
          }
        />
        <Meta
          label="Last checked"
          value={lastFetched ? lastFetched.toLocaleTimeString() : "—"}
        />
      </section>
    </article>
  );
}

function Banner({
  health,
  error,
}: {
  health: Health | null;
  error: string | null;
}) {
  if (error) {
    return (
      <div className="rounded-lg border border-rose-300 bg-rose-50 p-5">
        <p className="flex items-center gap-3 font-semibold text-rose-900">
          <Dot ok={false} />
          Unable to reach the API
        </p>
        <p className="mt-2 text-sm text-rose-800">{error}</p>
      </div>
    );
  }
  if (!health) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-5">
        <p className="text-sm text-slate-600">Probing…</p>
      </div>
    );
  }
  if (health.ok) {
    return (
      <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-5">
        <p className="flex items-center gap-3 font-semibold text-emerald-900">
          <Dot ok={true} />
          All systems operational
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-5">
      <p className="flex items-center gap-3 font-semibold text-amber-900">
        <Dot ok={false} />
        Partial outage
      </p>
      <p className="mt-2 text-sm text-amber-800">
        One or more components are reporting degraded health. See
        details below.
      </p>
    </div>
  );
}

function Dot({ ok }: { ok: boolean }) {
  return (
    <span
      aria-hidden
      className={`inline-block h-2.5 w-2.5 flex-shrink-0 rounded-full ${
        ok ? "bg-emerald-500" : "bg-rose-500"
      }`}
    />
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-slate-500">
        {label}
      </p>
      <p className="mt-1 font-mono text-sm text-slate-800">{value}</p>
    </div>
  );
}

function humanizeSeconds(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86_400)}d ${Math.floor((s % 86_400) / 3600)}h`;
}
