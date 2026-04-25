/**
 * Pure-function tests for the auth helpers. The hooks themselves
 * (useAuth, useLogin, etc.) need a React renderer to exercise — those
 * land with a Vitest setup in a later sprint. For Sprint 1 we pin the
 * non-hook surface.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { QueryClient } from "@tanstack/react-query";
import { authErrorMessage, authMeFromSignup, seedAuthMeCache } from "./auth";
import { ApiError, type SignupResponse } from "./api";

test("maps email_taken to a friendly account-exists message", () => {
  const err = new ApiError(409, "email_taken", null, "email_taken");
  assert.match(authErrorMessage(err), /already exists/i);
});

test("maps password_too_weak to a length hint", () => {
  const err = new ApiError(400, "password_too_weak", null, "password_too_weak");
  assert.match(authErrorMessage(err), /at least 12/i);
});

test("maps invalid_credentials to the generic email-or-password message", () => {
  const err = new ApiError(401, "invalid_credentials", null, "invalid_credentials");
  assert.match(authErrorMessage(err), /email or password is incorrect/i);
});

test("maps invalid_input to a check-your-input message", () => {
  const err = new ApiError(400, "invalid_input", null, "invalid_input");
  assert.match(authErrorMessage(err), /check your input/i);
});

test("maps auth_not_configured to a server-side message", () => {
  const err = new ApiError(503, "auth_not_configured", null, "auth_not_configured");
  assert.match(authErrorMessage(err), /not configured/i);
});

test("falls through to ApiError.message for unknown codes", () => {
  const err = new ApiError(500, "weird_thing", null, "raw provider message");
  assert.match(authErrorMessage(err), /raw provider message/i);
});

test("falls through to a network message for non-ApiError inputs", () => {
  const err = new TypeError("network is down");
  assert.match(authErrorMessage(err), /network error/i);
});

test("non-Error inputs still yield a friendly message", () => {
  assert.match(authErrorMessage("just a string"), /network error/i);
  assert.match(authErrorMessage(null), /network error/i);
  assert.match(authErrorMessage(undefined), /network error/i);
});

// ─── PR #5 review: cache-shape transformation + seeding ─────────────

const SIGNUP_FIXTURE: SignupResponse = {
  user: {
    id: "user_1",
    email: "alice@example.com",
    emailVerifiedAt: null,
    createdAt: "2026-04-24T00:00:00Z",
  },
  org: {
    id: "org_1",
    slug: "alice",
    name: "alice's Organization",
    billingStatus: "trialing",
    trialEndsAt: "2026-05-08T00:00:00Z",
  },
};

test("authMeFromSignup wraps the single org as orgs[] with role owner", () => {
  const me = authMeFromSignup(SIGNUP_FIXTURE);
  assert.deepEqual(me.user, SIGNUP_FIXTURE.user);
  assert.equal(me.orgs.length, 1);
  assert.equal(me.orgs[0].id, "org_1");
  assert.equal(me.orgs[0].slug, "alice");
  assert.equal(me.orgs[0].name, "alice's Organization");
  assert.equal(me.orgs[0].role, "owner");
});

test("authMeFromSignup carries billing state from the signup response", () => {
  // The SPA seeds ["auth", "me"] from the signup response so the
  // post-signup navigate(/) renders billing state without a re-fetch.
  // Drop these fields from the projection and the trial banner won't
  // show until the next /me round-trip — visible flicker.
  const me = authMeFromSignup(SIGNUP_FIXTURE);
  assert.equal(me.orgs[0].billingStatus, "trialing");
  assert.equal(me.orgs[0].trialEndsAt, "2026-05-08T00:00:00Z");
});

test("seedAuthMeCache populates the ['auth','me'] key — what useAuth would read", () => {
  const qc = new QueryClient();
  // Pre-condition: cache is empty.
  assert.equal(qc.getQueryData(["auth", "me"]), undefined);

  const me = authMeFromSignup(SIGNUP_FIXTURE);
  seedAuthMeCache(qc, me);

  // useAuth() reads exactly this key — confirms the no-flicker fix
  // populates the same cell the hook consumes.
  const stored = qc.getQueryData(["auth", "me"]);
  assert.deepEqual(stored, me);
});

test("seedAuthMeCache overwrites a prior null value (logged-out → logged-in)", () => {
  const qc = new QueryClient();
  // Simulate the post-logout state.
  qc.setQueryData(["auth", "me"], null);
  assert.equal(qc.getQueryData(["auth", "me"]), null);

  const me = authMeFromSignup(SIGNUP_FIXTURE);
  seedAuthMeCache(qc, me);

  assert.deepEqual(qc.getQueryData(["auth", "me"]), me);
});

test("QueryClient.clear() drops all keys (logout cross-user-leak fix)", () => {
  // Mirrors what useLogout does after the API call resolves.
  const qc = new QueryClient();
  qc.setQueryData(["auth", "me"], { user: { email: "alice" } });
  qc.setQueryData(["parts", "search", "STM32"], [{ mpn: "STM32F407" }]);
  qc.setQueryData(["bom", "project_xyz"], { items: [] });

  qc.clear();

  assert.equal(qc.getQueryData(["auth", "me"]), undefined);
  assert.equal(qc.getQueryData(["parts", "search", "STM32"]), undefined);
  assert.equal(qc.getQueryData(["bom", "project_xyz"]), undefined);
});
