/**
 * `can()` exhaustive policy tests.
 *
 * Every interesting combination of (actorRole, action, resource…) is
 * pinned here so a future tweak to the policy is impossible to make
 * silently. The route tests in members/routes.test.ts also exercise
 * these rules end-to-end through HTTP, but a regression in the policy
 * matrix should fail HERE first with a single clean assertion.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Role } from "@altium-mcp/auth";
import { can, type CanAction, type MemberResource } from "./can.js";

const ROLES: Role[] = ["owner", "admin", "member", "billing_only"];

function actor(role: Role) {
  return { userId: "u-actor", role };
}

function memberResource(opts: Partial<MemberResource> = {}): MemberResource {
  return {
    kind: "member",
    userId: "u-target",
    currentRole: "member",
    isLastOwner: false,
    ...opts,
  };
}

// ─── billing_only allow/deny enumeration ─────────────────────────────

test("billing_only is denied every action that isn't on the allow-list", () => {
  // Enumerate every CanAction the role IS denied. New actions get
  // a deliberate decision: add them here OR add them to the allow
  // list below — leaving them off both arrays leaves the test gap.
  const denied: CanAction[] = [
    "member.invite",
    "member.role_change",
    "member.remove",
    "workspace.create",
    "workspace.update",
    "workspace.delete",
    "workspace.read",
    "api_key.create",
    "api_key.list",
    "api_key.update",
    "api_key.revoke",
    "billing.checkout",
    "billing.portal_manage",
    "tools.use",
  ];
  for (const action of denied) {
    const result = can(
      actor("billing_only"),
      action,
      action.startsWith("member.") ? memberResource() : undefined
    );
    assert.equal(
      result,
      false,
      `billing_only should NOT be allowed to ${action}`
    );
  }
});

test("billing_only is allowed read-only actions on the allow-list", () => {
  // Finance teams need consumption visibility to budget — they get
  // usage.read explicitly. No other actions are on the allow-list
  // today; future read-only actions (invoice.read, etc.) join here.
  const allowed: CanAction[] = ["usage.read"];
  for (const action of allowed) {
    assert.equal(
      can(actor("billing_only"), action),
      true,
      `billing_only should be allowed to ${action}`
    );
  }
});

// ─── member.invite ───────────────────────────────────────────────────

test("member.invite: owner + admin allowed; member + billing_only denied", () => {
  assert.equal(can(actor("owner"), "member.invite"), true);
  assert.equal(can(actor("admin"), "member.invite"), true);
  assert.equal(can(actor("member"), "member.invite"), false);
  assert.equal(can(actor("billing_only"), "member.invite"), false);
});

// ─── member.role_change ──────────────────────────────────────────────

test("role_change without a member resource is always denied", () => {
  // Defense in depth: callers must pass the resource snapshot. A
  // missing resource must not pass through to "true".
  for (const r of ROLES) {
    assert.equal(can(actor(r), "member.role_change"), false);
  }
});

test("role_change with no newRole is denied even for owner", () => {
  // Defense in depth: a partially-formed role_change call must NOT
  // pass through to true just because the actor has high privilege.
  // The route always sets newRole; this test pins the contract for
  // future callers.
  const allowed = can(
    actor("owner"),
    "member.role_change",
    memberResource({ currentRole: "member" /* newRole intentionally unset */ })
  );
  assert.equal(allowed, false);
});

test("role_change: member can never change roles", () => {
  assert.equal(
    can(actor("member"), "member.role_change", memberResource()),
    false
  );
});

test("role_change: admin can promote member to admin (non-owner transition)", () => {
  const allowed = can(
    actor("admin"),
    "member.role_change",
    memberResource({ currentRole: "member", newRole: "admin" })
  );
  assert.equal(allowed, true);
});

test("role_change: admin can demote admin to member", () => {
  const allowed = can(
    actor("admin"),
    "member.role_change",
    memberResource({ currentRole: "admin", newRole: "member" })
  );
  assert.equal(allowed, true);
});

test("role_change: admin CANNOT promote a member to owner (owner transition)", () => {
  // Only owners can mint owners — prevents an admin from escalating
  // a friendly account to owner without owner consent.
  const allowed = can(
    actor("admin"),
    "member.role_change",
    memberResource({ currentRole: "member", newRole: "owner" })
  );
  assert.equal(allowed, false);
});

test("role_change: admin CANNOT demote an owner (owner transition)", () => {
  const allowed = can(
    actor("admin"),
    "member.role_change",
    memberResource({
      currentRole: "owner",
      newRole: "admin",
      isLastOwner: false,
    })
  );
  assert.equal(allowed, false);
});

test("role_change: owner CAN promote a member to owner", () => {
  const allowed = can(
    actor("owner"),
    "member.role_change",
    memberResource({ currentRole: "member", newRole: "owner" })
  );
  assert.equal(allowed, true);
});

test("role_change: owner CAN demote a non-last owner", () => {
  const allowed = can(
    actor("owner"),
    "member.role_change",
    memberResource({
      currentRole: "owner",
      newRole: "admin",
      isLastOwner: false,
    })
  );
  assert.equal(allowed, true);
});

test("role_change: owner CANNOT demote the LAST owner", () => {
  // The whole point of last-owner protection — even an owner trying
  // to self-demote, or another co-owner doing it, would leave the
  // org headless.
  const allowed = can(
    actor("owner"),
    "member.role_change",
    memberResource({
      currentRole: "owner",
      newRole: "admin",
      isLastOwner: true,
    })
  );
  assert.equal(allowed, false);
});

test("role_change: promoting INTO owner is fine even if the target is currently the only owner", () => {
  // Edge case: target is currently owner AND last-owner, promoting
  // them TO owner is a no-op transition. The function checks
  // newRole !== "owner" for the demotion guard, so this case is
  // allowed (no demotion happening).
  const allowed = can(
    actor("owner"),
    "member.role_change",
    memberResource({
      currentRole: "owner",
      newRole: "owner",
      isLastOwner: true,
    })
  );
  assert.equal(allowed, true);
});

// ─── member.remove ───────────────────────────────────────────────────

test("remove without a member resource is always denied", () => {
  for (const r of ROLES) {
    assert.equal(can(actor(r), "member.remove"), false);
  }
});

test("remove: member + billing_only never allowed to remove anyone", () => {
  assert.equal(
    can(actor("member"), "member.remove", memberResource()),
    false
  );
  assert.equal(
    can(actor("billing_only"), "member.remove", memberResource()),
    false
  );
});

test("remove: admin CAN remove a member or admin (non-owner target)", () => {
  for (const targetRole of ["member", "admin"] as const) {
    assert.equal(
      can(
        actor("admin"),
        "member.remove",
        memberResource({ currentRole: targetRole })
      ),
      true,
      `admin should be able to remove ${targetRole}`
    );
  }
});

test("remove: admin CANNOT remove an owner", () => {
  // Privilege transition: only owners can remove owners. Stops an
  // admin from booting the org's only owner.
  const allowed = can(
    actor("admin"),
    "member.remove",
    memberResource({ currentRole: "owner", isLastOwner: false })
  );
  assert.equal(allowed, false);
});

test("remove: owner CAN remove a non-last owner", () => {
  const allowed = can(
    actor("owner"),
    "member.remove",
    memberResource({ currentRole: "owner", isLastOwner: false })
  );
  assert.equal(allowed, true);
});

test("remove: owner CANNOT remove the LAST owner (incl. themselves)", () => {
  const allowed = can(
    actor("owner"),
    "member.remove",
    memberResource({ currentRole: "owner", isLastOwner: true })
  );
  assert.equal(allowed, false);
});

test("remove: owner CAN remove an admin or member without restriction", () => {
  for (const targetRole of ["admin", "member", "billing_only"] as const) {
    assert.equal(
      can(
        actor("owner"),
        "member.remove",
        memberResource({ currentRole: targetRole })
      ),
      true,
      `owner should be able to remove ${targetRole}`
    );
  }
});

// ─── workspace.* ─────────────────────────────────────────────────────

test("workspace.create / update / delete: owner + admin only", () => {
  for (const action of ["workspace.create", "workspace.update", "workspace.delete"] as const) {
    assert.equal(can(actor("owner"), action), true);
    assert.equal(can(actor("admin"), action), true);
    assert.equal(can(actor("member"), action), false);
    assert.equal(can(actor("billing_only"), action), false);
  }
});

test("workspace.read: any non-billing role", () => {
  assert.equal(can(actor("owner"), "workspace.read"), true);
  assert.equal(can(actor("admin"), "workspace.read"), true);
  assert.equal(can(actor("member"), "workspace.read"), true);
  assert.equal(can(actor("billing_only"), "workspace.read"), false);
});

// ─── api_key.* ───────────────────────────────────────────────────────

test("api_key.create / .list / .update / .revoke: owner + admin only", () => {
  for (const action of [
    "api_key.create",
    "api_key.list",
    "api_key.update",
    "api_key.revoke",
  ] as const) {
    assert.equal(can(actor("owner"), action), true);
    assert.equal(can(actor("admin"), action), true);
    // Members + billing_only can't see or touch keys. Members aren't
    // billing-restricted, so this also verifies that "member" without
    // an explicit allow defaults to denied for these actions.
    assert.equal(can(actor("member"), action), false);
    assert.equal(can(actor("billing_only"), action), false);
  }
});

// ─── billing.checkout ────────────────────────────────────────────────

test("billing.checkout: owner only — admin / member / billing_only denied", () => {
  // Picking a plan + seat count is an owner action per spec §3.4
  // ("admin — no billing"). Even billing_only is denied; that role
  // is view-only on invoices, never the one that starts a checkout.
  assert.equal(can(actor("owner"), "billing.checkout"), true);
  assert.equal(can(actor("admin"), "billing.checkout"), false);
  assert.equal(can(actor("member"), "billing.checkout"), false);
  assert.equal(can(actor("billing_only"), "billing.checkout"), false);
});

test("billing.portal_manage: owner only — same gating as billing.checkout", () => {
  // The Customer Portal handles plan switches, seat changes, payment-
  // method updates, and cancellation. All four are owner decisions;
  // billing_only specifically does NOT get this action — view-only
  // invoice access (when wired) is a separate action.
  assert.equal(can(actor("owner"), "billing.portal_manage"), true);
  assert.equal(can(actor("admin"), "billing.portal_manage"), false);
  assert.equal(can(actor("member"), "billing.portal_manage"), false);
  assert.equal(can(actor("billing_only"), "billing.portal_manage"), false);
});

// ─── tools.use ───────────────────────────────────────────────────────

test("tools.use: owner / admin / member yes, billing_only no", () => {
  assert.equal(can(actor("owner"), "tools.use"), true);
  assert.equal(can(actor("admin"), "tools.use"), true);
  assert.equal(can(actor("member"), "tools.use"), true);
  assert.equal(can(actor("billing_only"), "tools.use"), false);
});
