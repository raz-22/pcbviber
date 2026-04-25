/**
 * /invites/accept?token=… — public-but-auth-required landing page.
 *
 * Flow:
 *   1. Read `token` from the URL.
 *   2. Need a session: `RequireAuth` redirects to /login with
 *      `state.from = "/invites/accept?token=…"` if not signed in.
 *      After login the user lands here again.
 *   3. POST /api/invites/:token/accept. Surface the result:
 *      - happy: "you've joined ${org.name}" + Continue → /
 *      - 403 invite_email_mismatch: "sign in with the right account"
 *      - 410 invite_expired: "ask for a new invite"
 *      - 409 invite_already_accepted: "this link was already used"
 *      - 404 not_found: "invalid or unknown link"
 *
 * The page calls /accept on first render. On success it invalidates
 * the auth cache so /me reflects the new membership.
 */

import { useEffect } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../lib/api";
import { memberErrorMessage, useAcceptInvite } from "../lib/members";
import { useAuth } from "../lib/auth";

export function AcceptInvitePage() {
  const [params] = useSearchParams();
  const token = params.get("token");
  const accept = useAcceptInvite();
  const qc = useQueryClient();
  const { me } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!token) return;
    if (accept.isPending || accept.isSuccess || accept.isError) return;
    accept
      .mutateAsync(token)
      .then(() => {
        // Refresh /me — the user now has a new membership.
        qc.invalidateQueries({ queryKey: ["auth", "me"] });
      })
      .catch(() => {
        /* error rendered below */
      });
    // We deliberately depend on `token` only — re-running on every
    // render would re-fire the mutation. The internal isPending /
    // isSuccess / isError flags above gate the second invocation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (!token) {
    return (
      <div className="mx-auto max-w-lg px-6 py-10">
        <h1 className="text-xl font-semibold">Missing invite token</h1>
        <p className="mt-2 text-sm text-slate-600">
          The link you followed didn't include a token. Ask for a new invite.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg px-6 py-10">
      <h1 className="text-xl font-semibold">Accept invitation</h1>

      {accept.isPending && (
        <p className="mt-4 text-sm text-slate-600">Accepting…</p>
      )}

      {accept.isSuccess && accept.data && (
        <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-5">
          <p className="font-medium text-emerald-900">
            You've joined {accept.data.org.name}.
          </p>
          <p className="mt-1 text-sm text-emerald-800">
            Role:{" "}
            <span className="font-mono">{accept.data.membership.role}</span>
          </p>
          <button
            onClick={() => navigate("/", { replace: true })}
            className="mt-4 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
          >
            Continue
          </button>
        </div>
      )}

      {accept.isError && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-5">
          <p className="font-medium text-red-900">
            {memberErrorMessage(accept.error)}
          </p>
          {/* Mismatch is the most actionable error — give the signed-in
              user a clear next step. */}
          {accept.error instanceof ApiError &&
            accept.error.code === "invite_email_mismatch" && (
              <p className="mt-2 text-sm text-red-800">
                You're signed in as{" "}
                <span className="font-mono">{me?.user.email ?? "—"}</span>.
                Log out, then sign in with the email the invite was sent to.
              </p>
            )}
          <div className="mt-4">
            <Link
              to="/"
              className="text-sm text-slate-700 hover:underline"
            >
              Back to home
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
