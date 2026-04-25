/**
 * Pure tests for the members/invites helpers — error mapper +
 * cache-key shapes. Hooks are exercised through HTTP integration
 * by the server tests; we pin the SPA-side surface that doesn't
 * need React rendering.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { QueryClient } from "@tanstack/react-query";
import {
  invalidateInvites,
  invalidateMembers,
  invitesKey,
  memberErrorMessage,
  membersKey,
} from "./members";
import { ApiError } from "./api";

// ─── memberErrorMessage matrix ───────────────────────────────────────

test("maps cannot_demote_last_owner to a 'promote someone else first' message", () => {
  const err = new ApiError(409, "cannot_demote_last_owner", null, "cdlo");
  assert.match(memberErrorMessage(err), /promote someone else/i);
});

test("maps cannot_remove_last_owner to a similar 'promote first' message", () => {
  const err = new ApiError(409, "cannot_remove_last_owner", null, "crlo");
  assert.match(memberErrorMessage(err), /promote/i);
});

test("maps already_member to a 'already a member' message", () => {
  const err = new ApiError(409, "already_member", null, "am");
  assert.match(memberErrorMessage(err), /already a member/i);
});

test("maps invite_email_mismatch to a 'sign in with that account' hint", () => {
  const err = new ApiError(403, "invite_email_mismatch", null, "iem");
  assert.match(memberErrorMessage(err), /sign in with that account/i);
});

test("maps invite_expired to a 'send a new one' hint", () => {
  const err = new ApiError(410, "invite_expired", null, "exp");
  assert.match(memberErrorMessage(err), /send a new one/i);
});

test("maps invite_already_accepted to a 'already been accepted' message", () => {
  const err = new ApiError(409, "invite_already_accepted", null, "ia");
  assert.match(memberErrorMessage(err), /already been accepted/i);
});

test("maps forbidden to a permission message", () => {
  const err = new ApiError(403, "forbidden", null, "f");
  assert.match(memberErrorMessage(err), /permission/i);
});

test("maps not_authenticated to a session-expired message", () => {
  const err = new ApiError(401, "not_authenticated", null, "na");
  assert.match(memberErrorMessage(err), /session has expired/i);
});

test("falls through to ApiError.message on unknown codes", () => {
  const err = new ApiError(500, "weird", null, "raw upstream blob");
  assert.match(memberErrorMessage(err), /raw upstream blob/i);
});

test("non-ApiError inputs surface a network message", () => {
  assert.match(memberErrorMessage(new TypeError("offline")), /network/i);
  assert.match(memberErrorMessage("garbled"), /network/i);
  assert.match(memberErrorMessage(null), /network/i);
});

// ─── cache key shape ─────────────────────────────────────────────────

test("membersKey scopes by orgId — different orgs get different keys", () => {
  assert.deepEqual(membersKey("org-a"), ["members", "org-a"]);
  assert.deepEqual(membersKey("org-b"), ["members", "org-b"]);
  assert.notDeepEqual(membersKey("org-a"), membersKey("org-b"));
});

test("invitesKey is distinct from membersKey for the same org", () => {
  // Members and invites are separate cache entries — invalidating one
  // must not collaterally invalidate the other.
  const m = membersKey("org-a");
  const i = invitesKey("org-a");
  assert.notDeepEqual(m, i);
});

// ─── invalidator behavior ────────────────────────────────────────────

test("invalidateMembers marks the members list query stale, leaves invites alone", () => {
  const qc = new QueryClient();
  qc.setQueryData(membersKey("org-a"), []);
  qc.setQueryData(invitesKey("org-a"), []);

  invalidateMembers(qc, "org-a");

  assert.equal(qc.getQueryState(membersKey("org-a"))?.isInvalidated, true);
  // Invites cache is a sibling — must NOT be touched (cross-collection
  // invalidation would refetch unrelated data on every mutation).
  assert.equal(qc.getQueryState(invitesKey("org-a"))?.isInvalidated, false);
});

test("invalidateInvites is the mirror image: invites stale, members alone", () => {
  const qc = new QueryClient();
  qc.setQueryData(membersKey("org-a"), []);
  qc.setQueryData(invitesKey("org-a"), []);

  invalidateInvites(qc, "org-a");

  assert.equal(qc.getQueryState(invitesKey("org-a"))?.isInvalidated, true);
  assert.equal(qc.getQueryState(membersKey("org-a"))?.isInvalidated, false);
});

test("invalidateMembers leaves OTHER orgs alone (cross-tenant cache safety)", () => {
  // Same defense pattern as workspaces.test.ts: a mutation in org-a
  // must not stale-invalidate org-b's members cache.
  const qc = new QueryClient();
  qc.setQueryData(membersKey("org-a"), []);
  qc.setQueryData(membersKey("org-b"), []);

  invalidateMembers(qc, "org-a");

  assert.equal(qc.getQueryState(membersKey("org-a"))?.isInvalidated, true);
  assert.equal(qc.getQueryState(membersKey("org-b"))?.isInvalidated, false);
});
