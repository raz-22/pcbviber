import { test } from "node:test";
import assert from "node:assert/strict";
import { QueryClient } from "@tanstack/react-query";
import {
  apiKeyErrorMessage,
  apiKeysKey,
  invalidateApiKeys,
} from "./api-keys";
import { ApiError } from "./api";

// ─── apiKeyErrorMessage matrix ───────────────────────────────────────

test("maps api_key_already_revoked to a 'has already been revoked' message", () => {
  const err = new ApiError(409, "api_key_already_revoked", null, "ar");
  assert.match(apiKeyErrorMessage(err), /already been revoked/i);
});

test("maps invalid_input to a check-the-form message", () => {
  const err = new ApiError(400, "invalid_input", null, "ii");
  assert.match(apiKeyErrorMessage(err), /check the form/i);
});

test("maps forbidden to a permission message", () => {
  const err = new ApiError(403, "forbidden", null, "f");
  assert.match(apiKeyErrorMessage(err), /permission/i);
});

test("maps not_found to a key-not-found message", () => {
  const err = new ApiError(404, "not_found", null, "nf");
  assert.match(apiKeyErrorMessage(err), /not found/i);
});

test("maps not_authenticated to session-expired", () => {
  const err = new ApiError(401, "not_authenticated", null, "na");
  assert.match(apiKeyErrorMessage(err), /session has expired/i);
});

test("falls through to ApiError.message on unknown codes", () => {
  const err = new ApiError(500, "weird", null, "raw upstream blob");
  assert.match(apiKeyErrorMessage(err), /raw upstream blob/i);
});

test("non-ApiError inputs surface a network message", () => {
  assert.match(apiKeyErrorMessage(new TypeError("offline")), /network/i);
  assert.match(apiKeyErrorMessage("garbled"), /network/i);
  assert.match(apiKeyErrorMessage(null), /network/i);
});

// ─── cache key shape ─────────────────────────────────────────────────

test("apiKeysKey scopes by orgId", () => {
  assert.deepEqual(apiKeysKey("org-a"), ["apiKeys", "org-a"]);
  assert.notDeepEqual(apiKeysKey("org-a"), apiKeysKey("org-b"));
});

// ─── invalidator behavior ────────────────────────────────────────────

test("invalidateApiKeys marks the list query stale", () => {
  const qc = new QueryClient();
  qc.setQueryData(apiKeysKey("org-a"), []);
  invalidateApiKeys(qc, "org-a");
  assert.equal(qc.getQueryState(apiKeysKey("org-a"))?.isInvalidated, true);
});

test("invalidateApiKeys leaves OTHER orgs alone", () => {
  // Cross-tenant cache safety, same as members/workspaces.
  const qc = new QueryClient();
  qc.setQueryData(apiKeysKey("org-a"), []);
  qc.setQueryData(apiKeysKey("org-b"), []);

  invalidateApiKeys(qc, "org-a");

  assert.equal(qc.getQueryState(apiKeysKey("org-a"))?.isInvalidated, true);
  assert.equal(qc.getQueryState(apiKeysKey("org-b"))?.isInvalidated, false);
});
