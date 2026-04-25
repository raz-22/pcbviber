/**
 * Authorization — single source of truth for "is this allowed?".
 *
 * Per the internal design spec §3.4:
 *
 *   "One authorization function: can(user, action, resource).
 *    Do not scatter role checks."
 *
 * Pure function; takes pre-loaded snapshots so it can be exhaustively
 * unit-tested without a DB. Routes load whatever resource state the
 * decision needs (e.g. target's current role + whether they're the
 * last owner) and pass it in. The function encodes the policy; callers
 * encode the data flow.
 *
 * Role hierarchy (highest to lowest privilege):
 *   owner         — everything, including billing + delete-org
 *   admin         — invite/remove members, manage workspaces + API keys
 *   member        — use tools, read-only on settings
 *   billing_only  — read-only finance role; allowed only the actions
 *                   in BILLING_ONLY_ACTIONS (see below). Today that's
 *                   `usage.read` for budget visibility; future
 *                   read-only finance actions (invoice.read, etc.)
 *                   join the same allow-list.
 *
 * Transition gates beyond "actor.role ∈ allowed":
 *
 *   - Only an owner can grant or revoke the `owner` role. An admin
 *     trying to promote someone to owner gets a 403; same for
 *     demoting an owner. This protects the org against admins
 *     escalating themselves or each other.
 *
 *   - The last owner cannot be demoted or removed. There must always
 *     be at least one owner standing — otherwise the org becomes
 *     headless (no one can manage billing, no one can promote
 *     replacements). Routes load `isLastOwner` and pass it through.
 *
 *   - billing_only short-circuits at the top of `can()`: any action
 *     not in BILLING_ONLY_ACTIONS returns false regardless of the
 *     per-action switch below.
 */

import type { Role } from "@altium-mcp/auth";

/**
 * Stable vocabulary of action names. Strings (not numeric enum) so
 * audit logs and SPA error responses can carry the action verbatim.
 *
 * When a Sprint adds a new endpoint, add the action here, then write
 * the rule in `can()`. The compiler will flag any switch that fails
 * to handle the new variant.
 */
export type CanAction =
  | "member.invite"
  | "member.role_change"
  | "member.remove"
  | "workspace.create"
  | "workspace.update"
  | "workspace.delete"
  | "workspace.read"
  | "api_key.create"
  | "api_key.list"
  | "api_key.update"
  | "api_key.revoke"
  | "billing.checkout"
  | "billing.portal_manage"
  | "tools.use"
  | "usage.read";

export interface Actor {
  userId: string;
  /** The actor's role in the org being acted upon. */
  role: Role;
}

/**
 * Member-resource view used by `member.*` actions. Pre-loaded by the
 * route so `can()` can stay pure.
 *
 *   currentRole — what the target IS today
 *   newRole     — what role_change wants to set them to (omit on remove)
 *   isLastOwner — true iff demoting/removing this user would leave
 *                 the org with zero owners. Computed by counting
 *                 owner memberships in the org.
 */
export interface MemberResource {
  kind: "member";
  userId: string;
  currentRole: Role;
  newRole?: Role;
  isLastOwner: boolean;
}

/** Union of every resource shape `can()` understands. */
export type Resource = MemberResource;

/**
 * Actions that the billing_only role IS allowed to perform.
 * Everything not in this set is denied for billing_only — see the
 * top-of-`can()` short-circuit. Read-only actions that finance teams
 * legitimately need land here as they're added (e.g. usage.read so
 * they can see consumption to budget).
 */
const BILLING_ONLY_ACTIONS = new Set<CanAction>(["usage.read"]);

export function can(
  actor: Actor,
  action: CanAction,
  resource?: Resource
): boolean {
  // billing_only is a strict role: only the explicitly-allowed
  // billing actions pass. Default to `false` for everything else.
  if (actor.role === "billing_only") {
    return BILLING_ONLY_ACTIONS.has(action);
  }

  switch (action) {
    case "member.invite":
      // Owner/admin can invite. members + billing_only fall through to false.
      return actor.role === "owner" || actor.role === "admin";

    case "member.role_change": {
      if (resource?.kind !== "member") return false;
      // Defense in depth: role_change is meaningless without a target
      // role. Routes always set it; future callers that forget will
      // get a clean `false` instead of a misleading `true`.
      if (resource.newRole === undefined) return false;
      if (actor.role !== "owner" && actor.role !== "admin") return false;
      const isOwnerTransition =
        resource.currentRole === "owner" || resource.newRole === "owner";
      // Only owners can grant or revoke the `owner` role.
      if (isOwnerTransition && actor.role !== "owner") return false;
      // Last-owner guard: cannot demote the last remaining owner.
      const isDemotion =
        resource.currentRole === "owner" && resource.newRole !== "owner";
      if (isDemotion && resource.isLastOwner) return false;
      return true;
    }

    case "member.remove": {
      if (resource?.kind !== "member") return false;
      if (actor.role !== "owner" && actor.role !== "admin") return false;
      // Only owners can remove an existing owner. (Admin removing
      // an admin/member is fine.)
      if (resource.currentRole === "owner" && actor.role !== "owner") {
        return false;
      }
      // Last-owner guard.
      if (resource.currentRole === "owner" && resource.isLastOwner) {
        return false;
      }
      return true;
    }

    case "workspace.create":
    case "workspace.update":
    case "workspace.delete":
    case "api_key.create":
    case "api_key.list":
    case "api_key.update":
    case "api_key.revoke":
      // API key management is owner/admin only — keys grant MCP
      // tool access at the org level, so handing out (or revoking)
      // them is a privileged action. Members never see the list.
      return actor.role === "owner" || actor.role === "admin";

    case "billing.checkout":
    case "billing.portal_manage":
      // Owner only. Picking a plan / changing seats / cancelling /
      // updating payment method are all owner decisions per spec
      // §3.4 ("admin — no billing"). billing_only is view-only and
      // gets a separate (future) action for invoice access.
      return actor.role === "owner";

    case "workspace.read":
    case "tools.use":
      // billing_only is filtered above; the remaining roles
      // (owner / admin / member) all get read + tool access.
      return true;

    case "usage.read":
      // Every role gets to see consumption — billing_only is
      // explicitly let through via BILLING_ONLY_ACTIONS so finance
      // teams can budget without granting them tool / billing
      // privileges.
      return true;

    default: {
      // Exhaustiveness — if a new CanAction was added without a case,
      // TypeScript catches it here and the compiler refuses to build.
      const _never: never = action;
      void _never;
      return false;
    }
  }
}
