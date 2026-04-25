/**
 * Settings → Members.
 *
 *   - Members list with role + remove (per row, gated by can() server-side)
 *   - Pending invites list with revoke
 *   - Invite-a-member form (admin/owner only)
 *
 * The page renders for any member; non-admins get 403s on the
 * mutation paths and the error mapper surfaces "you don't have
 * permission". Buttons that admins can use are still rendered for
 * everyone — the source of truth is the server, the SPA's hide-
 * the-button behavior is a UX convenience.
 */

import { useState } from "react";
import { useAuth } from "../../lib/auth";
import {
  memberErrorMessage,
  useChangeRole,
  useCreateInvite,
  useInvites,
  useMembers,
  useRemoveMember,
  useRevokeInvite,
} from "../../lib/members";
import { InviteForm } from "../../components/InviteForm";
import type { Invite, Member, Role } from "../../lib/api";

type View =
  | { kind: "list" }
  | { kind: "invite" }
  | { kind: "remove-confirm"; member: Member };

export function MembersSettingsPage() {
  const { me } = useAuth();
  const orgId = me?.orgs[0]?.id;
  const myUserId = me?.user.id;
  const myRole = me?.orgs[0]?.role as Role | undefined;
  const canEdit = myRole === "owner" || myRole === "admin";

  const [view, setView] = useState<View>({ kind: "list" });
  const membersQ = useMembers(orgId);
  const invitesQ = useInvites(orgId);

  if (!me || !orgId) {
    return <p className="text-sm text-slate-500">Loading…</p>;
  }

  if (view.kind === "invite") {
    return (
      <InvitePane
        orgId={orgId}
        onDone={() => setView({ kind: "list" })}
      />
    );
  }

  return (
    <div className="space-y-10">
      <section>
        <header className="flex items-end justify-between">
          <div>
            <h2 className="text-lg font-semibold">Members</h2>
            <p className="mt-1 text-sm text-slate-600">
              Members of this organization. Only owners and admins can
              invite, remove, or change roles.
            </p>
          </div>
          {canEdit && (
            <button
              onClick={() => setView({ kind: "invite" })}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
            >
              Invite a member
            </button>
          )}
        </header>

        <div className="mt-5">
          {membersQ.isLoading && (
            <p className="text-sm text-slate-500">Loading…</p>
          )}
          {membersQ.error && (
            <p className="text-sm text-red-600">
              {memberErrorMessage(membersQ.error)}
            </p>
          )}
          {membersQ.data && membersQ.data.length > 0 && (
            <ul className="space-y-2">
              {membersQ.data.map((m) => (
                <MemberRow
                  key={m.userId}
                  member={m}
                  orgId={orgId}
                  canEdit={canEdit}
                  myRole={myRole}
                  isSelf={m.userId === myUserId}
                  pendingRemove={
                    view.kind === "remove-confirm" && view.member.userId === m.userId
                  }
                  onAskRemove={() => setView({ kind: "remove-confirm", member: m })}
                  onCancelRemove={() => setView({ kind: "list" })}
                  onRemoved={() => setView({ kind: "list" })}
                />
              ))}
            </ul>
          )}
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold">Pending invites</h2>
        <p className="mt-1 text-sm text-slate-600">
          Invites that haven't been accepted yet. Expire 7 days after creation.
        </p>
        <div className="mt-5">
          {invitesQ.isLoading && (
            <p className="text-sm text-slate-500">Loading…</p>
          )}
          {invitesQ.error && (
            <p className="text-sm text-red-600">
              {memberErrorMessage(invitesQ.error)}
            </p>
          )}
          {invitesQ.data && invitesQ.data.length === 0 && (
            <p className="text-sm text-slate-500">No pending invites.</p>
          )}
          {invitesQ.data && invitesQ.data.length > 0 && (
            <ul className="space-y-2">
              {invitesQ.data.map((inv) => (
                <InviteRow
                  key={inv.id}
                  invite={inv}
                  orgId={orgId}
                  canEdit={canEdit}
                />
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

// ─── Subviews ────────────────────────────────────────────────────────

function InvitePane({ orgId, onDone }: { orgId: string; onDone: () => void }) {
  const create = useCreateInvite(orgId);
  const [accepted, setAccepted] = useState<{ token: string; email: string } | null>(
    null
  );

  if (accepted) {
    const acceptUrl = `${window.location.origin}/invites/accept?token=${accepted.token}`;
    return (
      <div className="max-w-2xl">
        <h2 className="text-lg font-semibold">Invite created</h2>
        <p className="mt-1 text-sm text-slate-600">
          Email delivery isn't wired yet. Copy this URL and send it to{" "}
          <span className="font-mono text-xs">{accepted.email}</span> however you
          normally do (Slack, email, etc.). The link expires in 7 days.
        </p>
        <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3">
          <code className="block break-all font-mono text-xs">{acceptUrl}</code>
        </div>
        <div className="mt-4 flex gap-2">
          <button
            onClick={() => {
              navigator.clipboard.writeText(acceptUrl).catch(() => {});
            }}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Copy URL
          </button>
          <button
            onClick={onDone}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700"
          >
            Back to members
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-lg font-semibold">Invite a member</h2>
      <p className="mt-1 text-sm text-slate-600">
        The invitee gets an accept URL they open in a logged-in browser
        session matching the email below.
      </p>
      <div className="mt-5 max-w-2xl">
        <InviteForm
          submitting={create.isPending}
          submitError={create.error}
          onCancel={onDone}
          onSubmit={async (input) => {
            try {
              const res = await create.mutateAsync(input);
              setAccepted({ token: res.token, email: res.invite.email });
            } catch {
              /* shown inline */
            }
          }}
        />
      </div>
    </div>
  );
}

function MemberRow({
  member,
  orgId,
  canEdit,
  myRole,
  isSelf,
  pendingRemove,
  onAskRemove,
  onCancelRemove,
  onRemoved,
}: {
  member: Member;
  orgId: string;
  canEdit: boolean;
  myRole: Role | undefined;
  isSelf: boolean;
  pendingRemove: boolean;
  onAskRemove: () => void;
  onCancelRemove: () => void;
  onRemoved: () => void;
}) {
  const change = useChangeRole(orgId);
  const remove = useRemoveMember(orgId);

  // Only owners can grant or revoke "owner" role; admins can flip
  // among admin/member/billing_only. Mirrors can() server-side so
  // the SPA shows only the options the server will accept.
  const roleOptions: Role[] =
    myRole === "owner"
      ? ["owner", "admin", "member", "billing_only"]
      : ["admin", "member", "billing_only"];

  return (
    <li className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-medium">
            {member.email}
            {isSelf && (
              <span className="ml-2 text-xs text-slate-500">(you)</span>
            )}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            joined {new Date(member.joinedAt).toLocaleDateString()}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canEdit ? (
            <select
              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs"
              value={member.role}
              onChange={async (e) => {
                const next = e.target.value as Role;
                if (next === member.role) return;
                try {
                  await change.mutateAsync({
                    userId: member.userId,
                    input: { role: next },
                  });
                } catch {
                  /* shown below */
                }
              }}
              disabled={change.isPending}
            >
              {roleOptions.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
              {/* If the current role isn't in roleOptions (e.g. an admin
                  looking at an owner row), keep it visible so the select
                  shows a value rather than a blank. */}
              {!roleOptions.includes(member.role) && (
                <option value={member.role} disabled>
                  {member.role}
                </option>
              )}
            </select>
          ) : (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
              {member.role}
            </span>
          )}
          {canEdit && !pendingRemove && (
            <button
              onClick={onAskRemove}
              className="rounded-md border border-red-300 bg-white px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
            >
              Remove
            </button>
          )}
        </div>
      </div>

      {change.error && (
        <p className="mt-2 text-xs text-red-700" role="alert">
          {memberErrorMessage(change.error)}
        </p>
      )}

      {pendingRemove && (
        <div
          className="mt-3 rounded-md border border-red-200 bg-red-50 p-3"
          role="alertdialog"
        >
          <p className="text-sm text-red-900">
            Remove <span className="font-mono">{member.email}</span> from this
            organization? They keep their account but lose access here.
          </p>
          {remove.error && (
            <p className="mt-1 text-xs text-red-700">
              {memberErrorMessage(remove.error)}
            </p>
          )}
          <div className="mt-3 flex gap-2">
            <button
              onClick={async () => {
                try {
                  await remove.mutateAsync(member.userId);
                  onRemoved();
                } catch {
                  /* shown above */
                }
              }}
              disabled={remove.isPending}
              className="rounded-md bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50"
            >
              {remove.isPending ? "Removing…" : "Confirm remove"}
            </button>
            <button
              onClick={() => {
                remove.reset();
                onCancelRemove();
              }}
              disabled={remove.isPending}
              className="rounded-md border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function InviteRow({
  invite,
  orgId,
  canEdit,
}: {
  invite: Invite;
  orgId: string;
  canEdit: boolean;
}) {
  const revoke = useRevokeInvite(orgId);
  const acceptUrl = `${window.location.origin}/invites/accept?token=…`;
  return (
    <li className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-medium">{invite.email}</p>
          <p className="mt-1 text-xs text-slate-500">
            role: <span className="font-mono">{invite.role}</span> · expires{" "}
            {new Date(invite.expiresAt).toLocaleDateString()}
          </p>
          <p className="mt-1 text-xs text-slate-400" title={acceptUrl}>
            Send the recipient the accept URL from the create response — server
            doesn't store the token.
          </p>
        </div>
        {canEdit && (
          <button
            onClick={async () => {
              try {
                await revoke.mutateAsync(invite.id);
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
        <p className="mt-2 text-xs text-red-700">
          {memberErrorMessage(revoke.error)}
        </p>
      )}
    </li>
  );
}
