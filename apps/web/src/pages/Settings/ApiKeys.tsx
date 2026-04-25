/**
 * Settings → API Keys.
 *
 *   - List of API keys (active + revoked, separated visually)
 *   - Create form. Successful create flips into a "show key once" pane
 *     where the user copies the plaintext; navigating away wipes it
 *     from React state — the server cannot reproduce it.
 *   - Per-key Revoke button.
 *
 * Owner/admin only on the server. The page renders for any role; non-
 * admins see 403s mapped to a permission message.
 */

import { useState } from "react";
import { useAuth } from "../../lib/auth";
import {
  apiKeyErrorMessage,
  useApiKeys,
  useCreateApiKey,
  useRevokeApiKey,
} from "../../lib/api-keys";
import { CreateApiKeyForm } from "../../components/CreateApiKeyForm";
import type { ApiKey } from "../../lib/api";

type View =
  | { kind: "list" }
  | { kind: "create" }
  | {
      kind: "show-once";
      apiKey: ApiKey;
      plaintext: string;
    };

export function ApiKeysSettingsPage() {
  const { me } = useAuth();
  const orgId = me?.orgs[0]?.id;
  const role = me?.orgs[0]?.role;
  const canEdit = role === "owner" || role === "admin";

  const [view, setView] = useState<View>({ kind: "list" });
  const keysQ = useApiKeys(orgId);

  if (!me || !orgId) {
    return <p className="text-sm text-slate-500">Loading…</p>;
  }

  if (view.kind === "create") {
    return (
      <CreateApiKeyPane
        orgId={orgId}
        onCreated={(apiKey, plaintext) =>
          setView({ kind: "show-once", apiKey, plaintext })
        }
        onCancel={() => setView({ kind: "list" })}
      />
    );
  }

  if (view.kind === "show-once") {
    return (
      <ShowOncePane
        apiKey={view.apiKey}
        plaintext={view.plaintext}
        onDone={() => setView({ kind: "list" })}
      />
    );
  }

  const active = (keysQ.data ?? []).filter((k) => !k.revokedAt);
  const revoked = (keysQ.data ?? []).filter((k) => k.revokedAt);

  return (
    <div>
      <header className="flex items-end justify-between">
        <div>
          <h2 className="text-lg font-semibold">API keys</h2>
          <p className="mt-1 text-sm text-slate-600">
            Bearer tokens for the MCP transport. Keys are shown to you exactly
            once at creation; the server never stores them in plaintext.
          </p>
        </div>
        {canEdit && (
          <button
            onClick={() => setView({ kind: "create" })}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
          >
            New API key
          </button>
        )}
      </header>

      <div className="mt-6">
        {keysQ.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
        {keysQ.error && (
          <p className="text-sm text-red-600">
            {apiKeyErrorMessage(keysQ.error)}
          </p>
        )}
        {keysQ.data && active.length === 0 && (
          <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center">
            <p className="text-sm text-slate-700">
              {canEdit
                ? "No active keys. Create one to use the MCP transport."
                : "No active keys yet."}
            </p>
          </div>
        )}
        {active.length > 0 && (
          <ul className="space-y-2">
            {active.map((k) => (
              <ApiKeyRow
                key={k.id}
                apiKey={k}
                orgId={orgId}
                canEdit={canEdit}
              />
            ))}
          </ul>
        )}
        {revoked.length > 0 && (
          <details className="mt-8">
            <summary className="cursor-pointer text-xs font-medium text-slate-600 hover:underline">
              Revoked keys ({revoked.length})
            </summary>
            <ul className="mt-3 space-y-2">
              {revoked.map((k) => (
                <ApiKeyRow
                  key={k.id}
                  apiKey={k}
                  orgId={orgId}
                  canEdit={canEdit}
                />
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}

// ─── Subviews ────────────────────────────────────────────────────────

function CreateApiKeyPane({
  orgId,
  onCreated,
  onCancel,
}: {
  orgId: string;
  onCreated: (apiKey: ApiKey, plaintext: string) => void;
  onCancel: () => void;
}) {
  const create = useCreateApiKey(orgId);
  return (
    <div>
      <h2 className="text-lg font-semibold">New API key</h2>
      <p className="mt-1 text-sm text-slate-600">
        The plaintext key will be shown once. Save it somewhere safe before
        navigating away.
      </p>
      <div className="mt-5 max-w-2xl">
        <CreateApiKeyForm
          submitting={create.isPending}
          submitError={create.error}
          onCancel={onCancel}
          onSubmit={async (input) => {
            try {
              const res = await create.mutateAsync(input);
              onCreated(res.apiKey, res.key);
            } catch {
              /* shown inline */
            }
          }}
        />
      </div>
    </div>
  );
}

function ShowOncePane({
  apiKey,
  plaintext,
  onDone,
}: {
  apiKey: ApiKey;
  plaintext: string;
  onDone: () => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  return (
    <div className="max-w-2xl">
      <h2 className="text-lg font-semibold">Key created — copy it now</h2>
      <p className="mt-1 text-sm text-slate-600">
        This is the only time the full key will be shown. The server stores
        only a hash; we cannot recover the plaintext later.
      </p>

      <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-amber-900">
          {apiKey.name}
        </p>
        <code className="mt-2 block break-all rounded bg-white p-3 font-mono text-sm">
          {plaintext}
        </code>
        <button
          onClick={() => {
            navigator.clipboard.writeText(plaintext).catch(() => {});
          }}
          className="mt-3 rounded-md border border-amber-400 bg-white px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100"
        >
          Copy to clipboard
        </button>
      </div>

      <label className="mt-4 flex items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        I've saved the key somewhere safe.
      </label>

      <div className="mt-4">
        <button
          onClick={onDone}
          disabled={!confirmed}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          Done
        </button>
      </div>
    </div>
  );
}

function ApiKeyRow({
  apiKey,
  orgId,
  canEdit,
}: {
  apiKey: ApiKey;
  orgId: string;
  canEdit: boolean;
}) {
  const revoke = useRevokeApiKey(orgId);
  const isRevoked = !!apiKey.revokedAt;
  return (
    <li
      className={[
        "rounded-lg border p-4",
        isRevoked
          ? "border-slate-200 bg-slate-50"
          : "border-slate-200 bg-white",
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-medium">{apiKey.name}</p>
          <p className="mt-1 text-xs text-slate-500">
            {apiKey.preview ? (
              <>
                <span className="font-mono">{apiKey.preview}</span>… ·{" "}
              </>
            ) : null}
            created {new Date(apiKey.createdAt).toLocaleDateString()}
            {apiKey.expiresAt && (
              <>
                {" · expires "}
                {new Date(apiKey.expiresAt).toLocaleDateString()}
              </>
            )}
            {apiKey.lastUsedAt && (
              <>
                {" · last used "}
                {new Date(apiKey.lastUsedAt).toLocaleDateString()}
              </>
            )}
            {isRevoked && (
              <>
                {" · revoked "}
                {new Date(apiKey.revokedAt!).toLocaleDateString()}
              </>
            )}
          </p>
          {apiKey.scopes.length > 0 && (
            <p className="mt-1 text-xs text-slate-500">
              scopes:{" "}
              {apiKey.scopes.map((s) => (
                <span
                  key={s}
                  className="mr-1 inline-block rounded-full bg-slate-100 px-2 py-0.5 font-mono text-xs"
                >
                  {s}
                </span>
              ))}
            </p>
          )}
        </div>
        {canEdit && !isRevoked && (
          <button
            onClick={async () => {
              try {
                await revoke.mutateAsync(apiKey.id);
              } catch {
                /* shown below */
              }
            }}
            disabled={revoke.isPending}
            className="rounded-md border border-red-300 bg-white px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
          >
            {revoke.isPending ? "Revoking…" : "Revoke"}
          </button>
        )}
      </div>
      {revoke.error && (
        <p className="mt-2 text-xs text-red-700" role="alert">
          {apiKeyErrorMessage(revoke.error)}
        </p>
      )}
    </li>
  );
}
