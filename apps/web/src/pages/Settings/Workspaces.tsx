/**
 * Settings → Workspaces. The CRUD UI for tenant workspaces.
 *
 * Three states a workspace card can be in:
 *
 *   - configured     — hasNexarCredentials true; PartsSearch will work
 *   - needs creds    — hasNexarCredentials false; PartsSearch will 503
 *   - delete pending — confirm dialog open
 *
 * Role gating: only owner/admin users see Create/Edit/Delete buttons.
 * Members see the list (read-only). billing_only wouldn't reach here
 * because the server's requireMember check 403s — but if it does, the
 * list call itself will surface that as forbidden.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import {
  useCreateWorkspace,
  useDeleteWorkspace,
  useUpdateWorkspace,
  useWorkspaces,
  workspaceErrorMessage,
} from "../../lib/workspaces";
import { WorkspaceForm } from "../../components/WorkspaceForm";
import type {
  CreateWorkspaceInput,
  UpdateWorkspaceInput,
  Workspace,
  WorkspacePlatform,
} from "../../lib/api";

type ViewState =
  | { kind: "list" }
  | { kind: "create" }
  | { kind: "edit"; workspace: Workspace }
  | { kind: "delete-confirm"; workspace: Workspace };

export function WorkspacesSettingsPage() {
  const { me } = useAuth();
  const orgId = me?.orgs[0]?.id;
  const role = me?.orgs[0]?.role;
  const canEdit = role === "owner" || role === "admin";

  const [view, setView] = useState<ViewState>({ kind: "list" });
  const wsQ = useWorkspaces(orgId);

  if (!me || !orgId) {
    return <p className="text-sm text-slate-500">Loading…</p>;
  }

  if (view.kind === "create") {
    return (
      <CreateWorkspacePane
        orgId={orgId}
        onDone={() => setView({ kind: "list" })}
      />
    );
  }

  if (view.kind === "edit") {
    return (
      <EditWorkspacePane
        orgId={orgId}
        workspace={view.workspace}
        onDone={() => setView({ kind: "list" })}
      />
    );
  }

  return (
    <div>
      <header className="flex items-end justify-between">
        <div>
          <h2 className="text-lg font-semibold">Workspaces</h2>
          <p className="mt-1 text-sm text-slate-600">
            A workspace pairs your Nexar credentials with an Altium 365
            location. Parts Search and Library calls run against the
            workspace you select.
          </p>
        </div>
        {canEdit && (
          <button
            onClick={() => setView({ kind: "create" })}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
          >
            New workspace
          </button>
        )}
      </header>

      <div className="mt-6">
        {wsQ.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
        {wsQ.error && (
          <p className="text-sm text-red-600">
            {workspaceErrorMessage(wsQ.error)}
          </p>
        )}
        {wsQ.data && wsQ.data.length === 0 && !canEdit && (
          <p className="text-sm text-slate-500">
            This organization has no workspaces yet. Ask an owner or admin
            to create one.
          </p>
        )}
        {wsQ.data && wsQ.data.length === 0 && canEdit && (
          <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center">
            <p className="text-sm text-slate-700">
              No workspaces yet. Create one to enable Parts Search and
              library calls.
            </p>
          </div>
        )}
        {wsQ.data && wsQ.data.length > 0 && (
          <ul className="space-y-3">
            {wsQ.data.map((ws) => (
              <WorkspaceCard
                key={ws.id}
                ws={ws}
                canEdit={canEdit}
                pendingDelete={
                  view.kind === "delete-confirm" && view.workspace.id === ws.id
                    ? view.workspace
                    : null
                }
                onEdit={() => setView({ kind: "edit", workspace: ws })}
                onAskDelete={() => setView({ kind: "delete-confirm", workspace: ws })}
                onCancelDelete={() => setView({ kind: "list" })}
                orgId={orgId}
                onDeleted={() => setView({ kind: "list" })}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ─── Subviews ────────────────────────────────────────────────────────

function CreateWorkspacePane({
  orgId,
  onDone,
}: {
  orgId: string;
  onDone: () => void;
}) {
  const create = useCreateWorkspace(orgId);
  return (
    <div>
      <h2 className="text-lg font-semibold">New workspace</h2>
      <p className="mt-1 text-sm text-slate-600">
        Saving runs a credentials test against Nexar; the workspace is
        only persisted if the test succeeds.
      </p>
      <div className="mt-5 max-w-2xl">
        <WorkspaceForm
          mode="create"
          orgId={orgId}
          submitting={create.isPending}
          submitError={create.error}
          onCancel={onDone}
          onSubmit={async (payload) => {
            try {
              await create.mutateAsync(payload as CreateWorkspaceInput);
              onDone();
            } catch {
              // Error is shown inline via submitError. Do not log creds.
            }
          }}
        />
      </div>
    </div>
  );
}

function EditWorkspacePane({
  orgId,
  workspace,
  onDone,
}: {
  orgId: string;
  workspace: Workspace;
  onDone: () => void;
}) {
  const update = useUpdateWorkspace(orgId, workspace.id);
  return (
    <div>
      <h2 className="text-lg font-semibold">Edit workspace</h2>
      <p className="mt-1 text-sm text-slate-600">
        Replacing credentials runs a test before saving. Leave the credential
        fields blank to keep the existing values.
      </p>
      <div className="mt-5 max-w-2xl">
        <WorkspaceForm
          mode="edit"
          orgId={orgId}
          workspace={workspace}
          submitting={update.isPending}
          submitError={update.error}
          onCancel={onDone}
          onSubmit={async (payload) => {
            try {
              await update.mutateAsync(payload as UpdateWorkspaceInput);
              onDone();
            } catch {
              // shown inline via submitError
            }
          }}
        />
      </div>
    </div>
  );
}

function WorkspaceCard({
  ws,
  canEdit,
  pendingDelete,
  onEdit,
  onAskDelete,
  onCancelDelete,
  orgId,
  onDeleted,
}: {
  ws: Workspace;
  canEdit: boolean;
  pendingDelete: Workspace | null;
  onEdit: () => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  orgId: string;
  onDeleted: () => void;
}) {
  const del = useDeleteWorkspace(orgId);

  // Discard the previous attempt's error when the user dismisses the
  // confirm panel — otherwise re-opening it shows a stale red message
  // from a delete that no longer matters.
  function cancel() {
    del.reset();
    onCancelDelete();
  }
  return (
    <li className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <p className="font-medium">
              {ws.altiumWorkspaceUrl ?? <span className="text-slate-400 italic">No Altium 365 URL</span>}
            </p>
            <PlatformPill platform={ws.platform} />
          </div>
          <p className="mt-1 text-xs text-slate-500">
            <code className="font-mono">{ws.id}</code> · created{" "}
            {new Date(ws.createdAt).toLocaleDateString()}
          </p>
          <div className="mt-2 flex items-center gap-2 text-xs">
            <Badge ok={ws.hasNexarCredentials}>
              {ws.hasNexarCredentials ? "Nexar configured" : "Nexar not set"}
            </Badge>
            {ws.hasAltiumRestToken && <Badge ok>REST token set</Badge>}
          </div>
          {ws.platform === "easyeda" && (
            <div className="mt-3 text-xs">
              <Link
                to={`/settings/workspaces/${ws.id}/connect-easyeda`}
                className="text-blue-700 hover:underline"
              >
                Connect EasyEDA Pro →
              </Link>
            </div>
          )}
        </div>
        {canEdit && pendingDelete === null && (
          <div className="flex gap-2">
            <button
              onClick={onEdit}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              Edit
            </button>
            <button
              onClick={onAskDelete}
              className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50"
            >
              Delete
            </button>
          </div>
        )}
      </div>

      {pendingDelete && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 p-3" role="alertdialog">
          <p className="text-sm text-red-900">
            Delete this workspace? Stored credentials will be removed and
            anyone using this workspace will need to switch to another one.
          </p>
          {del.error && (
            <p className="mt-1 text-xs text-red-700">
              {workspaceErrorMessage(del.error)}
            </p>
          )}
          <div className="mt-3 flex gap-2">
            <button
              onClick={async () => {
                try {
                  await del.mutateAsync(ws.id);
                  onDeleted();
                } catch {
                  // shown inline
                }
              }}
              disabled={del.isPending}
              className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50"
            >
              {del.isPending ? "Deleting…" : "Confirm delete"}
            </button>
            <button
              onClick={cancel}
              disabled={del.isPending}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function Badge({ ok, children }: { ok?: boolean; children: React.ReactNode }) {
  return (
    <span
      className={[
        "rounded-full px-2 py-0.5 text-xs font-medium",
        ok ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800",
      ].join(" ")}
    >
      {children}
    </span>
  );
}

function PlatformPill({ platform }: { platform: WorkspacePlatform }) {
  // Per-platform color so the AI / human eye picks up the difference
  // at a glance on a list of mixed workspaces. Altium = blue (matches
  // the brand we're already showing); EasyEDA = teal.
  const cls =
    platform === "easyeda"
      ? "bg-teal-100 text-teal-800"
      : "bg-blue-100 text-blue-800";
  const label = platform === "easyeda" ? "EasyEDA" : "Altium";
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      {label}
    </span>
  );
}
