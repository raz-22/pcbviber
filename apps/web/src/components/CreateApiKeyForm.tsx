/**
 * "New API key" form. Used inline on Settings → API Keys.
 *
 * Scopes input is a comma-separated text field — the SPA splits and
 * trims; the server's regex (\S+) rejects whitespace, so internal
 * spaces in a single scope round-trip cleanly only as separators
 * here.
 *
 * Expiry is an optional date input (yyyy-mm-dd). We send midnight UTC
 * ISO; the server's Zod refine rejects past dates. Empty = no expiry.
 */

import { useState } from "react";
import type { CreateApiKeyInput } from "../lib/api";
import { apiKeyErrorMessage } from "../lib/api-keys";

export interface CreateApiKeyFormProps {
  onSubmit: (input: CreateApiKeyInput) => Promise<void> | void;
  onCancel?: () => void;
  submitting?: boolean;
  submitError?: unknown;
}

export function CreateApiKeyForm({
  onSubmit,
  onCancel,
  submitting,
  submitError,
}: CreateApiKeyFormProps) {
  const [name, setName] = useState("");
  const [scopesRaw, setScopesRaw] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [errors, setErrors] = useState<{ name?: string; expiresAt?: string }>({});

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmedName = name.trim();
    const fieldErrors: { name?: string; expiresAt?: string } = {};
    if (!trimmedName) fieldErrors.name = "Required.";
    let expiresAtIso: string | undefined;
    if (expiryDate) {
      const d = new Date(`${expiryDate}T23:59:59Z`);
      if (Number.isNaN(d.getTime())) {
        fieldErrors.expiresAt = "Invalid date.";
      } else if (d.getTime() <= Date.now()) {
        fieldErrors.expiresAt = "Must be in the future.";
      } else {
        expiresAtIso = d.toISOString();
      }
    }
    setErrors(fieldErrors);
    if (Object.keys(fieldErrors).length > 0) return;

    const scopes = scopesRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const payload: CreateApiKeyInput = { name: trimmedName };
    if (scopes.length > 0) payload.scopes = scopes;
    if (expiresAtIso) payload.expiresAt = expiresAtIso;
    void onSubmit(payload);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <label className="block">
        <span className="block text-sm font-medium text-slate-700">Name</span>
        <span className="mt-0.5 block text-xs text-slate-500">
          What this key is for ("CI runner", "raz's laptop", etc.).
        </span>
        <input
          className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="off"
        />
        {errors.name && (
          <span className="mt-1 block text-xs text-red-600">{errors.name}</span>
        )}
      </label>

      <label className="block">
        <span className="block text-sm font-medium text-slate-700">Scopes</span>
        <span className="mt-0.5 block text-xs text-slate-500">
          Comma-separated. Leave blank for no claimed scopes.
        </span>
        <input
          className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
          value={scopesRaw}
          onChange={(e) => setScopesRaw(e.target.value)}
          placeholder="mcp:tools, mcp:read"
        />
      </label>

      <label className="block">
        <span className="block text-sm font-medium text-slate-700">
          Expires (optional)
        </span>
        <span className="mt-0.5 block text-xs text-slate-500">
          End-of-day UTC. Leave blank for no expiry.
        </span>
        <input
          className="mt-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
          type="date"
          value={expiryDate}
          onChange={(e) => setExpiryDate(e.target.value)}
        />
        {errors.expiresAt && (
          <span className="mt-1 block text-xs text-red-600">
            {errors.expiresAt}
          </span>
        )}
      </label>

      {submitError !== undefined && submitError !== null && (
        <p className="text-sm text-red-600" role="alert">
          {apiKeyErrorMessage(submitError)}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {submitting ? "Creating…" : "Create key"}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
