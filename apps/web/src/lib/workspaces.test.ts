/**
 * Pure-function tests for the workspaces helpers — error mapping +
 * cache-key shapes. The hooks themselves (useWorkspaces, useCreate*…)
 * need React rendering to exercise; that lands with Vitest in a later
 * sprint. For PR 2.4 we pin the non-hook surface so the SPA's error
 * messaging and cache invalidation can't drift silently.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { QueryClient } from "@tanstack/react-query";
import {
  invalidateWorkspaces,
  pickDefaultWorkspace,
  workspaceErrorMessage,
  workspaceKey,
  workspacesKey,
} from "./workspaces";
import { ApiError, type Workspace } from "./api";

function ws(id: string, hasNexarCredentials = true): Workspace {
  return {
    id,
    orgId: "org-a",
    platform: "altium",
    altiumWorkspaceUrl: null,
    hasNexarCredentials,
    hasAltiumRestToken: false,
    createdAt: "2026-04-25T00:00:00Z",
  };
}

// ─── error mapping ───────────────────────────────────────────────────

test("maps credentials_rejected to a creds-check message", () => {
  const err = new ApiError(422, "credentials_rejected", null, "credentials_rejected");
  assert.match(workspaceErrorMessage(err), /client id and secret/i);
});

test("maps workspace_not_configured to an Add-them-in-Settings message", () => {
  const err = new ApiError(
    503,
    "workspace_not_configured",
    null,
    "workspace_not_configured"
  );
  assert.match(workspaceErrorMessage(err), /no nexar credentials/i);
});

test("maps workspace_unavailable to a try-saving-again message", () => {
  const err = new ApiError(503, "workspace_unavailable", null, "workspace_unavailable");
  assert.match(workspaceErrorMessage(err), /could not load/i);
});

test("maps missing_altium_workspace_url to an explicit Settings hint", () => {
  const err = new ApiError(
    400,
    "missing_altium_workspace_url",
    null,
    "missing_altium_workspace_url"
  );
  assert.match(workspaceErrorMessage(err), /altium 365 url/i);
});

test("maps upstream_error to a creds-valid-but-upstream message", () => {
  const err = new ApiError(502, "upstream_error", null, "upstream_error");
  assert.match(workspaceErrorMessage(err), /upstream/i);
  // Important: do NOT tell the user their creds are bad on a 502 —
  // that's the whole point of separating it from credentials_rejected.
  assert.doesNotMatch(workspaceErrorMessage(err), /reject/i);
});

test("maps forbidden to a permission message", () => {
  const err = new ApiError(403, "forbidden", null, "forbidden");
  assert.match(workspaceErrorMessage(err), /permission/i);
});

test("maps not_found to a missing-workspace message", () => {
  const err = new ApiError(404, "not_found", null, "not_found");
  assert.match(workspaceErrorMessage(err), /not found/i);
});

test("maps not_authenticated to a session-expired message", () => {
  const err = new ApiError(401, "not_authenticated", null, "not_authenticated");
  assert.match(workspaceErrorMessage(err), /session has expired/i);
});

test("maps invalid_input to a check-the-form message", () => {
  const err = new ApiError(400, "invalid_input", null, "invalid_input");
  assert.match(workspaceErrorMessage(err), /check the form/i);
});

test("falls through to ApiError.message on unmapped codes", () => {
  const err = new ApiError(500, "weird_thing", null, "raw upstream message");
  assert.match(workspaceErrorMessage(err), /raw upstream message/i);
});

test("non-ApiError inputs surface a network message", () => {
  assert.match(workspaceErrorMessage(new TypeError("offline")), /network error/i);
  assert.match(workspaceErrorMessage("garbled"), /network error/i);
  assert.match(workspaceErrorMessage(null), /network error/i);
});

// ─── cache key shape ─────────────────────────────────────────────────

test("workspacesKey scopes by orgId — different orgs hit different cache cells", () => {
  const a = workspacesKey("org-a");
  const b = workspacesKey("org-b");
  assert.deepEqual(a, ["workspaces", "org-a"]);
  assert.deepEqual(b, ["workspaces", "org-b"]);
  assert.notDeepEqual(a, b);
});

test("workspaceKey nests under workspacesKey for prefix invalidation", () => {
  const list = workspacesKey("org-a");
  const single = workspaceKey("org-a", "ws-1");
  assert.deepEqual(single, ["workspaces", "org-a", "ws-1"]);
  // The single key starts with the list key, so React Query's prefix
  // matching invalidates both with one call. Encodes the contract that
  // invalidateWorkspaces relies on.
  assert.equal(single[0], list[0]);
  assert.equal(single[1], list[1]);
});

// ─── invalidateWorkspaces — the cache-mutation contract ──────────────

test("invalidateWorkspaces marks the list query as stale", () => {
  const qc = new QueryClient();
  qc.setQueryData(workspacesKey("org-a"), [
    {
      id: "ws-1",
      orgId: "org-a",
      altiumWorkspaceUrl: null,
      hasNexarCredentials: true,
      hasAltiumRestToken: false,
      createdAt: "2026-04-25T00:00:00Z",
    },
  ]);
  // Sanity: data is in the cache and fresh.
  const before = qc.getQueryState(workspacesKey("org-a"));
  assert.ok(before);
  assert.equal(before.isInvalidated, false);

  invalidateWorkspaces(qc, "org-a");

  const after = qc.getQueryState(workspacesKey("org-a"));
  assert.ok(after);
  assert.equal(after.isInvalidated, true);
});

test("invalidateWorkspaces also invalidates per-workspace cache cells (prefix match)", () => {
  const qc = new QueryClient();
  qc.setQueryData(workspaceKey("org-a", "ws-1"), { id: "ws-1" });
  qc.setQueryData(workspaceKey("org-a", "ws-2"), { id: "ws-2" });

  invalidateWorkspaces(qc, "org-a");

  // Both per-workspace entries share the ["workspaces","org-a", …] prefix
  // and so are invalidated by the same call — confirms we don't need
  // a separate single-workspace invalidator after a delete.
  assert.equal(qc.getQueryState(workspaceKey("org-a", "ws-1"))?.isInvalidated, true);
  assert.equal(qc.getQueryState(workspaceKey("org-a", "ws-2"))?.isInvalidated, true);
});

// ─── pickDefaultWorkspace — auto-select state machine ────────────────
//
// This is the function PartsSearch's useEffect drives. The previous
// in-effect logic early-returned whenever a workspaceId was set, which
// meant a deleted workspace stranded the page (no re-pick, dropdown
// stuck on a dead id). Each test here pins one branch of the recovery.

test("pickDefaultWorkspace returns null on an empty list", () => {
  assert.equal(pickDefaultWorkspace([], null), null);
  // Even when something is currently selected, an empty list can't
  // satisfy it — the result must collapse to null so callers know to
  // clear their state.
  assert.equal(pickDefaultWorkspace([], "ws-stale"), null);
});

test("pickDefaultWorkspace keeps a still-valid current selection", () => {
  // The user explicitly chose ws-2; a refetch should NOT yank them
  // back to the auto-pick. ws-1 is configured but ws-2 isn't — the
  // function trusts the user's choice over the heuristic.
  const list = [ws("ws-1", true), ws("ws-2", false)];
  assert.equal(pickDefaultWorkspace(list, "ws-2"), "ws-2");
});

test("pickDefaultWorkspace re-picks when the current id is stale", () => {
  // The selected workspace was deleted (or another tab created+deleted).
  // ws-stale isn't in the list, so the function falls through to the
  // auto-pick (configured first). This is the regression-test for the
  // "page is stuck" bug where the effect early-returned on truthy id.
  const list = [ws("ws-1", false), ws("ws-2", true)];
  assert.equal(pickDefaultWorkspace(list, "ws-stale"), "ws-2");
});

test("pickDefaultWorkspace prefers a configured workspace over an unconfigured one", () => {
  // Without this preference, a freshly-created (no-creds) workspace
  // would auto-select and leave the user staring at a 503 instead of
  // the working sibling.
  const list = [ws("ws-empty", false), ws("ws-ready", true)];
  assert.equal(pickDefaultWorkspace(list, null), "ws-ready");
});

test("pickDefaultWorkspace falls back to the first row when none is configured", () => {
  // Useful so the dropdown still has a value to render — the page
  // shows the "not configured" warning, not a blank selector.
  const list = [ws("ws-a", false), ws("ws-b", false)];
  assert.equal(pickDefaultWorkspace(list, null), "ws-a");
});

test("pickDefaultWorkspace is order-stable: no jitter from refetches reordering equals", () => {
  // Two refetches of an unchanged list must return the same id, even
  // when nothing is selected. Otherwise the page would oscillate
  // between cards on every poll.
  const list = [ws("ws-a", true), ws("ws-b", true)];
  const first = pickDefaultWorkspace(list, null);
  const second = pickDefaultWorkspace(list, null);
  assert.equal(first, second);
  assert.equal(first, "ws-a");
});

test("invalidateWorkspaces leaves OTHER orgs' caches alone", () => {
  const qc = new QueryClient();
  qc.setQueryData(workspacesKey("org-a"), []);
  qc.setQueryData(workspacesKey("org-b"), []);

  invalidateWorkspaces(qc, "org-a");

  assert.equal(qc.getQueryState(workspacesKey("org-a"))?.isInvalidated, true);
  // Cross-tenant defense at the cache layer: a mutation in org-a must
  // not stale-invalidate org-b's list.
  assert.equal(qc.getQueryState(workspacesKey("org-b"))?.isInvalidated, false);
});
