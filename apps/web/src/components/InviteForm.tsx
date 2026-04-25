/**
 * Invite-a-member form. Used inline on Settings → Members.
 *
 * On success the parent receives the raw token + invite metadata; it's
 * the parent's job to render the accept URL for copy-paste (no email
 * sender wired yet — see members/routes.ts).
 *
 * Roles offered match the server's InviteRole enum: owner is excluded
 * deliberately (granted only via PATCH /members/:userId).
 */

import { useState } from "react";
import type { CreateInviteInput, InviteRole } from "../lib/api";
import { memberErrorMessage } from "../lib/members";

export interface InviteFormProps {
  onSubmit: (input: CreateInviteInput) => Promise<void> | void;
  onCancel?: () => void;
  submitting?: boolean;
  submitError?: unknown;
}

const ROLES: { value: InviteRole; label: string; hint: string }[] = [
  { value: "member", label: "Member", hint: "Use tools, read settings" },
  { value: "admin", label: "Admin", hint: "Manage members, workspaces, and API keys" },
  {
    value: "billing_only",
    label: "Billing only",
    hint: "See invoices; cannot use tools",
  },
];

export function InviteForm({
  onSubmit,
  onCancel,
  submitting,
  submitError,
}: InviteFormProps) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InviteRole>("member");
  const [emailError, setEmailError] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed || !trimmed.includes("@")) {
      setEmailError("Please enter a valid email address.");
      return;
    }
    setEmailError(null);
    void onSubmit({ email: trimmed, role });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <label className="block">
        <span className="block text-sm font-medium text-slate-700">Email</span>
        <input
          className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="newhire@example.com"
          autoComplete="off"
        />
        {emailError && (
          <span className="mt-1 block text-xs text-red-600">{emailError}</span>
        )}
      </label>

      <label className="block">
        <span className="block text-sm font-medium text-slate-700">Role</span>
        <div className="mt-1 space-y-2">
          {ROLES.map((r) => (
            <label
              key={r.value}
              className="flex cursor-pointer items-start gap-2 rounded border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50"
            >
              <input
                type="radio"
                name="role"
                value={r.value}
                checked={role === r.value}
                onChange={() => setRole(r.value)}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium">{r.label}</span>
                <span className="ml-2 text-xs text-slate-500">{r.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </label>

      {submitError !== undefined && submitError !== null && (
        <p className="text-sm text-red-600" role="alert">
          {memberErrorMessage(submitError)}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {submitting ? "Creating…" : "Send invite"}
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
