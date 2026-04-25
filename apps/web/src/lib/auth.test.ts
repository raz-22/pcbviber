/**
 * Pure-function tests for the auth helpers. The hooks themselves
 * (useAuth, useLogin, etc.) need a React renderer to exercise — those
 * land with a Vitest setup in a later sprint. For Sprint 1 we pin the
 * non-hook surface.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { authErrorMessage } from "./auth";
import { ApiError } from "./api";

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
