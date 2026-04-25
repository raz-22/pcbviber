/**
 * Shared create/edit form for a Workspace. Used by both the "new
 * workspace" page and the inline edit dialog on Settings → Workspaces.
 *
 * Shape rules — these match the server's CreateWorkspaceBody +
 * UpdateWorkspaceBody schemas:
 *
 *   - On CREATE, both nexarClientId and nexarClientSecret are required.
 *   - On EDIT, leaving creds blank means "don't change them" — the
 *     server's UpdateWorkspaceBody refuses one-without-the-other, so
 *     this form mirrors that: either fill BOTH credential fields or
 *     NEITHER. The validation runs locally first to avoid a roundtrip.
 *   - Test-connection runs against the FORM's current values, not
 *     anything stored — so on edit, the user must fill in the secret
 *     to test, even when "current value" is already on the server.
 *     That's by design: the secret never round-trips back to the SPA.
 *
 * Audit-log writes happen on the server; this component never logs
 * decrypted credentials anywhere — not even console.error on failure.
 */

import { useState } from "react";
import type {
  CreateWorkspaceInput,
  UpdateWorkspaceInput,
  Workspace,
} from "../lib/api";
import { workspaceErrorMessage, useTestWorkspaceConnection } from "../lib/workspaces";

export type WorkspaceFormMode = "create" | "edit";

export interface WorkspaceFormProps {
  mode: WorkspaceFormMode;
  orgId: string;
  /** Required when mode === "edit" — preloads metadata fields. */
  workspace?: Workspace;
  /** Called with the validated payload when the form submits. */
  onSubmit: (
    payload: CreateWorkspaceInput | UpdateWorkspaceInput
  ) => Promise<void> | void;
  onCancel?: () => void;
  /** Bubbled up from the parent's mutation so the form can show errors. */
  submitError?: unknown;
  /** Disables submit while the parent mutation is in flight. */
  submitting?: boolean;
}

interface FieldErrors {
  altiumWorkspaceUrl?: string;
  nexarClientId?: string;
  nexarClientSecret?: string;
  altiumRestToken?: string;
}

export function WorkspaceForm({
  mode,
  orgId,
  workspace,
  onSubmit,
  onCancel,
  submitError,
  submitting,
}: WorkspaceFormProps) {
  const [altiumWorkspaceUrl, setAltiumWorkspaceUrl] = useState(
    workspace?.altiumWorkspaceUrl ?? ""
  );
  const [nexarClientId, setNexarClientId] = useState("");
  const [nexarClientSecret, setNexarClientSecret] = useState("");
  const [altiumRestToken, setAltiumRestToken] = useState("");
  const [clearAltiumRestToken, setClearAltiumRestToken] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});

  const test = useTestWorkspaceConnection(orgId);

  function validate(): FieldErrors {
    const e: FieldErrors = {};
    if (altiumWorkspaceUrl.trim()) {
      try {
        new URL(altiumWorkspaceUrl.trim());
      } catch {
        e.altiumWorkspaceUrl = "Must be a valid URL.";
      }
    }
    const idFilled = nexarClientId.trim().length > 0;
    const secretFilled = nexarClientSecret.trim().length > 0;
    if (mode === "create") {
      if (!idFilled) e.nexarClientId = "Required.";
      if (!secretFilled) e.nexarClientSecret = "Required.";
    } else if (idFilled !== secretFilled) {
      // edit: both or neither
      const msg = "Provide both client ID and secret, or leave both blank.";
      if (!idFilled) e.nexarClientId = msg;
      if (!secretFilled) e.nexarClientSecret = msg;
    }
    return e;
  }

  function buildPayload(): CreateWorkspaceInput | UpdateWorkspaceInput {
    const trimmedUrl = altiumWorkspaceUrl.trim();
    const idFilled = nexarClientId.trim().length > 0;
    const secretFilled = nexarClientSecret.trim().length > 0;
    const tokenFilled = altiumRestToken.trim().length > 0;

    if (mode === "create") {
      const payload: CreateWorkspaceInput = {
        nexarClientId: nexarClientId.trim(),
        nexarClientSecret: nexarClientSecret.trim(),
      };
      if (trimmedUrl) payload.altiumWorkspaceUrl = trimmedUrl;
      if (tokenFilled) payload.altiumRestToken = altiumRestToken.trim();
      return payload;
    }

    // edit: only include fields the user actually changed
    const payload: UpdateWorkspaceInput = {};
    const initialUrl = workspace?.altiumWorkspaceUrl ?? "";
    if (trimmedUrl !== initialUrl) {
      payload.altiumWorkspaceUrl = trimmedUrl ? trimmedUrl : null;
    }
    if (idFilled && secretFilled) {
      payload.nexarClientId = nexarClientId.trim();
      payload.nexarClientSecret = nexarClientSecret.trim();
    }
    if (tokenFilled) {
      payload.altiumRestToken = altiumRestToken.trim();
    } else if (clearAltiumRestToken) {
      payload.altiumRestToken = null;
    }
    return payload;
  }

  async function handleTest() {
    const idFilled = nexarClientId.trim().length > 0;
    const secretFilled = nexarClientSecret.trim().length > 0;
    if (!idFilled || !secretFilled) {
      setErrors({
        ...errors,
        nexarClientId: idFilled ? errors.nexarClientId : "Required to test.",
        nexarClientSecret: secretFilled ? errors.nexarClientSecret : "Required to test.",
      });
      return;
    }
    test.reset();
    try {
      await test.mutateAsync({
        nexarClientId: nexarClientId.trim(),
        nexarClientSecret: nexarClientSecret.trim(),
      });
    } catch {
      // Error is surfaced via test.error below — don't throw.
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const fieldErrors = validate();
    setErrors(fieldErrors);
    if (Object.keys(fieldErrors).length > 0) return;
    void onSubmit(buildPayload());
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <Field
        label="Altium 365 workspace URL"
        hint='Optional — e.g. "https://acme.altium365.com/workspaces/…". Required for library + Altium 365 calls.'
        error={errors.altiumWorkspaceUrl}
      >
        <input
          className={inputCls}
          type="url"
          placeholder="https://acme.altium365.com/workspaces/…"
          value={altiumWorkspaceUrl}
          onChange={(e) => setAltiumWorkspaceUrl(e.target.value)}
        />
      </Field>

      <fieldset className="space-y-3 rounded-md border border-slate-200 p-4">
        <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500 px-1">
          Nexar credentials
        </legend>

        {mode === "edit" && workspace?.hasNexarCredentials && (
          <p className="text-xs text-slate-500">
            Credentials are already configured. Leave blank to keep them, or
            fill in BOTH fields to replace them.
          </p>
        )}

        <Field
          label="Client ID"
          error={errors.nexarClientId}
        >
          <input
            className={inputCls}
            value={nexarClientId}
            onChange={(e) => setNexarClientId(e.target.value)}
            autoComplete="off"
            placeholder={mode === "edit" ? "(unchanged)" : ""}
          />
        </Field>

        <Field
          label="Client secret"
          error={errors.nexarClientSecret}
        >
          <input
            className={inputCls}
            type="password"
            value={nexarClientSecret}
            onChange={(e) => setNexarClientSecret(e.target.value)}
            autoComplete="new-password"
            placeholder={mode === "edit" ? "(unchanged)" : ""}
          />
        </Field>

        <div className="flex items-center gap-3 pt-1">
          <button
            type="button"
            onClick={handleTest}
            disabled={test.isPending}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {test.isPending ? "Testing…" : "Test connection"}
          </button>
          {test.isSuccess && (
            <span className="text-xs text-emerald-700">
              ✓ Credentials valid
            </span>
          )}
          {test.isError && (
            <span className="text-xs text-red-700">
              {workspaceErrorMessage(test.error)}
            </span>
          )}
        </div>
      </fieldset>

      <fieldset className="space-y-3 rounded-md border border-slate-200 p-4">
        <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500 px-1">
          Altium REST token
        </legend>
        <p className="text-xs text-slate-500">
          Optional — used for Requirements & Systems Portal calls.
        </p>
        <Field label="REST token" error={errors.altiumRestToken}>
          <input
            className={inputCls}
            type="password"
            value={altiumRestToken}
            onChange={(e) => setAltiumRestToken(e.target.value)}
            autoComplete="new-password"
            placeholder={
              mode === "edit" && workspace?.hasAltiumRestToken
                ? "(unchanged)"
                : ""
            }
          />
        </Field>
        {mode === "edit" && workspace?.hasAltiumRestToken && (
          <label className="flex items-center gap-2 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={clearAltiumRestToken}
              onChange={(e) => setClearAltiumRestToken(e.target.checked)}
            />
            Remove the existing REST token
          </label>
        )}
      </fieldset>

      {submitError !== undefined && submitError !== null && (
        <p className="text-sm text-red-600" role="alert">
          {workspaceErrorMessage(submitError)}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {submitting
            ? "Saving…"
            : mode === "create"
            ? "Create workspace"
            : "Save changes"}
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

const inputCls =
  "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400";

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-slate-700">{label}</span>
      {hint && <span className="mt-0.5 block text-xs text-slate-500">{hint}</span>}
      <div className="mt-1">{children}</div>
      {error && <span className="mt-1 block text-xs text-red-600">{error}</span>}
    </label>
  );
}
