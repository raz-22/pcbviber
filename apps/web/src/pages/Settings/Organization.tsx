/**
 * Settings → Organization.
 *
 * Today this surfaces the IP allowlist (PR 7.4). Future PRs add
 * org name / slug rename, soft-delete, etc.
 *
 * Permissions: owner | admin (server returns 403 forbidden for
 * member / billing_only). The page honors that 403 with a clear
 * message.
 */

import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../../lib/auth";
import { api, ApiError } from "../../lib/api";

export function OrganizationSettingsPage() {
  const { me } = useAuth();
  const orgId = me?.orgs[0]?.id;
  const qc = useQueryClient();

  const allowlistQ = useQuery({
    enabled: !!orgId,
    queryKey: ["ip-allowlist", orgId] as const,
    queryFn: async () => {
      if (!orgId) throw new Error("orgId required");
      return await api.getIpAllowlist(orgId);
    },
    staleTime: 30 * 1000,
  });

  // Editable string-list state. Backed by the server's normalized
  // entries on first load; we leave room for a `force` checkbox in
  // the submit row when a save would self-lock.
  const [draft, setDraft] = useState<string>("");
  const [force, setForce] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [invalidEntries, setInvalidEntries] = useState<string[]>([]);

  useEffect(() => {
    if (allowlistQ.data) {
      setDraft(allowlistQ.data.entries.join("\n"));
    }
  }, [allowlistQ.data]);

  const saveMut = useMutation({
    mutationFn: async (input: { entries: string[]; force: boolean }) => {
      if (!orgId) throw new Error("orgId required");
      return await api.putIpAllowlist(orgId, input);
    },
    onSuccess: (data) => {
      qc.setQueryData(["ip-allowlist", orgId], data);
      setErrorMsg(null);
      setInvalidEntries([]);
      setForce(false);
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError) {
        if (err.code === "invalid_ip_entries") {
          const detail = err.detail as { invalid?: string[] } | null;
          setInvalidEntries(detail?.invalid ?? []);
          setErrorMsg(
            "Some entries didn't parse as IP addresses or CIDR ranges. " +
              "Fix or remove the highlighted lines and try again."
          );
          return;
        }
        if (err.code === "ip_allowlist_would_lock_out_self") {
          const detail = err.detail as { clientIp?: string } | null;
          setErrorMsg(
            `This change would lock out your current IP (${
              detail?.clientIp ?? "unknown"
            }). Add it to the list, or check the "force" box if you ` +
              "intend to apply anyway."
          );
          return;
        }
        if (err.code === "forbidden") {
          setErrorMsg("Only admins and owners can change this setting.");
          return;
        }
        setErrorMsg(err.message ?? "Could not save.");
        return;
      }
      setErrorMsg("Network error. Please try again.");
    },
  });

  if (!me || !orgId) {
    return <p className="text-sm text-slate-500">Loading…</p>;
  }
  if (allowlistQ.isLoading) {
    return <p className="text-sm text-slate-500">Loading organization settings…</p>;
  }
  if (allowlistQ.error || !allowlistQ.data) {
    const err = allowlistQ.error;
    const code = err instanceof ApiError ? err.code : null;
    const msg =
      code === "forbidden"
        ? "Only admins and owners can view this page."
        : code === "ip_not_allowed"
          ? "Your current IP isn't on this organization's allowlist. Reach out to an owner from a permitted network."
          : "Could not load organization settings. Please retry.";
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Organization</h2>
        <p className="text-sm text-rose-700">{msg}</p>
      </div>
    );
  }

  function onSave() {
    const entries = draft
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    saveMut.mutate({ entries, force });
  }

  const currentEntries = allowlistQ.data.entries;
  const enabled = currentEntries.length > 0;

  return (
    <div className="space-y-8">
      <header>
        <h2 className="text-lg font-semibold">Organization</h2>
        <p className="mt-1 text-sm text-slate-600">
          Settings that apply to the entire organization.
        </p>
      </header>

      <section className="space-y-4">
        <div>
          <h3 className="text-sm font-medium uppercase tracking-wide text-slate-500">
            IP allowlist
          </h3>
          <p className="mt-1 text-sm text-slate-600">
            When set, requests scoped to this organization (web, API
            keys) are rejected unless the source IP matches one of the
            entries. Leave empty to disable. One IP or CIDR per line.
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Status:{" "}
            {enabled ? (
              <span className="text-emerald-700">
                Enabled — {currentEntries.length} entry
                {currentEntries.length === 1 ? "" : "ies"}
              </span>
            ) : (
              <span className="text-slate-500">Disabled (allow all IPs)</span>
            )}
          </p>
        </div>

        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={
            "203.0.113.5\n203.0.113.0/24\n2001:db8::/32"
          }
          rows={8}
          className="w-full rounded border border-slate-300 bg-white px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
        />

        {invalidEntries.length > 0 && (
          <div className="rounded border border-rose-300 bg-rose-50 p-3 text-sm">
            <p className="font-medium text-rose-800">
              Couldn't parse these entries:
            </p>
            <ul className="ml-4 mt-1 list-disc text-rose-700">
              {invalidEntries.map((e) => (
                <li key={e}>
                  <code className="text-xs">{e}</code>
                </li>
              ))}
            </ul>
          </div>
        )}

        {errorMsg && (
          <p className="text-sm text-rose-700">{errorMsg}</p>
        )}

        <div className="flex items-center justify-between">
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={force}
              onChange={(e) => setForce(e.target.checked)}
            />
            Force — accept self-lockout if my IP isn't in the new list
          </label>
          <button
            type="button"
            onClick={onSave}
            disabled={saveMut.isPending}
            className="rounded bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
          >
            {saveMut.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </section>
    </div>
  );
}
