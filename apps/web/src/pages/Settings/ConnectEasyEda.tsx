/**
 * Settings → Workspaces → Connect EasyEDA.
 *
 * Sub-route under /settings/workspaces/:workspaceId/connect-easyeda.
 * Linked from the workspace card when `platform === "easyeda"`.
 *
 * The page guides the user through three install steps:
 *   1. Download the .eext (served from /eda-script/pcbviber-easyeda.eext
 *      by Sprint 9 PR 9.5a)
 *   2. Import inside EasyEDA Pro and grant the External
 *      Interactions permission
 *   3. Paste the API key bound to this workspace
 *
 * Once the user finishes the steps, the extension's bottom-dock
 * panel inside EasyEDA Pro shows "Connected". Optional next-PR
 * polish: poll /api/eda-relay/status from this page to confirm
 * the bridge is live, in real time, before the user navigates
 * away.
 */

import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import { useWorkspaces } from "../../lib/workspaces";

export function ConnectEasyEdaPage() {
  const { me } = useAuth();
  const orgId = me?.orgs[0]?.id;
  const params = useParams<{ workspaceId: string }>();
  const navigate = useNavigate();
  const wsQ = useWorkspaces(orgId);

  if (!me || !orgId) {
    return <p className="text-sm text-slate-500">Loading…</p>;
  }
  if (wsQ.isLoading) {
    return <p className="text-sm text-slate-500">Loading…</p>;
  }
  const workspace = wsQ.data?.find((w) => w.id === params.workspaceId);
  if (!workspace) {
    return (
      <div>
        <p className="text-sm text-red-600">Workspace not found.</p>
        <button
          type="button"
          onClick={() => navigate("/settings/workspaces")}
          className="mt-3 text-sm text-blue-700 underline"
        >
          ← Back to Workspaces
        </button>
      </div>
    );
  }
  if (workspace.platform !== "easyeda") {
    // Defense in depth: a user manually navigating to this URL with
    // a non-EasyEDA workspace id shouldn't see install steps that
    // don't apply. Surface as a clear error + a way back.
    return (
      <div>
        <p className="text-sm text-amber-800">
          This workspace's platform is{" "}
          <strong>{workspace.platform}</strong>. The Connect-EasyEDA
          flow is only for EasyEDA workspaces.
        </p>
        <button
          type="button"
          onClick={() => navigate("/settings/workspaces")}
          className="mt-3 text-sm text-blue-700 underline"
        >
          ← Back to Workspaces
        </button>
      </div>
    );
  }

  return (
    <article>
      <div className="mb-2">
        <Link
          to="/settings/workspaces"
          className="text-xs text-slate-500 hover:underline"
        >
          ← Workspaces
        </Link>
      </div>
      <h2 className="text-lg font-semibold">Connect EasyEDA Pro</h2>
      <p className="mt-1 text-sm text-slate-600">
        The PCBviber EasyEDA Pro extension lets your AI assistant
        (Claude, Cursor, etc.) drive this workspace's projects, run
        DRC, export Gerbers, and more — by pushing commands through
        a long-poll bridge to the editor running on your machine.
      </p>

      <ol className="mt-8 space-y-8">
        <Step n={1} title="Download the extension">
          <p className="mt-2 text-sm text-slate-700">
            Grab the packaged <code>.eext</code> archive — three
            files (~10 KB), no install on your computer required.
            EasyEDA imports it directly.
          </p>
          <div className="mt-3">
            <a
              href="/eda-script/pcbviber-easyeda.eext"
              download="pcbviber-easyeda.eext"
              className="inline-block rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
            >
              Download pcbviber-easyeda.eext
            </a>
          </div>
        </Step>

        <Step n={2} title="Import in EasyEDA Pro">
          <p className="mt-2 text-sm text-slate-700">
            Open EasyEDA Pro, then{" "}
            <strong>Advanced → Extensions → Import</strong>, and
            pick the <code>.eext</code> file you just downloaded.
            EasyEDA will prompt for the{" "}
            <strong>External Interactions</strong> permission —
            grant it, otherwise the extension can't reach
            PCBviber's server.
          </p>
        </Step>

        <Step n={3} title="Paste your API key">
          <p className="mt-2 text-sm text-slate-700">
            On the first activation, the extension prompts for an
            API key. The key needs to be bound to{" "}
            <strong>this workspace</strong> (
            <code className="break-all">{workspace.id}</code>).
            Create one on the API keys page, set this workspace as
            its default, and paste it into the extension.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link
              to="/settings/api-keys"
              className="inline-block rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Open API keys →
            </Link>
            <button
              type="button"
              onClick={() => {
                if (navigator.clipboard) {
                  navigator.clipboard.writeText(workspace.id);
                }
              }}
              className="inline-block rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Copy workspace ID
            </button>
          </div>
        </Step>
      </ol>

      <section className="mt-12 rounded-lg border border-slate-200 bg-slate-50 p-5">
        <h3 className="text-sm font-semibold text-slate-700">
          What you should see when it works
        </h3>
        <p className="mt-2 text-sm text-slate-600">
          EasyEDA Pro shows a bottom-dock panel labeled "PCBviber".
          Within a second of pasting a valid API key, the panel
          should read <strong>PCBviber: Connected</strong>. If it
          stays on "Connecting…" or shows an error, double-check
          that the External Interactions permission is granted and
          that the API key is bound to this workspace.
        </p>
      </section>
    </article>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-4">
      <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-semibold text-white">
        {n}
      </span>
      <div className="flex-1">
        <p className="font-medium text-slate-900">{title}</p>
        <div>{children}</div>
      </div>
    </li>
  );
}
