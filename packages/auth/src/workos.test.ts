/**
 * WorkOSAuthProvider unit tests that don't require a live WorkOS tenant.
 *
 * We can't exercise the full signup/login flow without a real API key,
 * but the constructor guard + the error classification helper are pure
 * and worth pinning down — they're the paths that have already shown
 * subtle bugs in other stacks (generic errors leaking field identity,
 * "email already exists" showing up as "provider_error").
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AuthError } from "./types.js";
import { WorkOSAuthProvider, mapWorkOSError } from "./workos.js";

test("constructor throws AuthError('not_configured') when WORKOS_API_KEY is missing", () => {
  delete process.env.WORKOS_API_KEY;
  delete process.env.WORKOS_CLIENT_ID;
  assert.throws(
    () => new WorkOSAuthProvider(),
    (err: unknown) => err instanceof AuthError && err.code === "not_configured"
  );
});

test("constructor throws AuthError('not_configured') when only WORKOS_API_KEY is set", () => {
  process.env.WORKOS_API_KEY = "sk_test_dummy";
  delete process.env.WORKOS_CLIENT_ID;
  assert.throws(
    () => new WorkOSAuthProvider(),
    (err: unknown) => err instanceof AuthError && err.code === "not_configured"
  );
});

test("constructor accepts explicit opts without env vars", () => {
  delete process.env.WORKOS_API_KEY;
  delete process.env.WORKOS_CLIENT_ID;
  const provider = new WorkOSAuthProvider({
    apiKey: "sk_test_direct",
    clientId: "client_direct",
  });
  assert.equal(provider.kind, "workos");
});

// ─── mapWorkOSError ───────────────────────────────────────────────────

test("maps 'email already exists' variants to email_taken", () => {
  const cases = [
    "User with that email already exists",
    "An account with that email is already in use",
    "This email address is already taken",
  ];
  for (const msg of cases) {
    const mapped = mapWorkOSError(new Error(msg));
    assert.equal(mapped.code, "email_taken", `did not map: ${msg}`);
  }
});

test("maps 'invalid credentials' variants to invalid_credentials", () => {
  const cases = [
    "Invalid password",
    "invalid credentials for user",
    "Invalid email or password",
  ];
  for (const msg of cases) {
    const mapped = mapWorkOSError(new Error(msg));
    assert.equal(
      mapped.code,
      "invalid_credentials",
      `did not map: ${msg}`
    );
  }
});

test("maps anything else to provider_error (never silently invalid_credentials)", () => {
  const mapped = mapWorkOSError(new Error("WorkOS: 503 service unavailable"));
  assert.equal(mapped.code, "provider_error");
});

test("mapWorkOSError tolerates non-Error inputs", () => {
  assert.equal(mapWorkOSError("bare string error").code, "provider_error");
  assert.equal(mapWorkOSError(null).code, "provider_error");
  assert.equal(mapWorkOSError(undefined).code, "provider_error");
  assert.equal(mapWorkOSError({ foo: "bar" }).code, "provider_error");
});
