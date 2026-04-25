/**
 * Factory tests — pure env gating, no DB.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  selectAuthProvider,
  __resetAuthProviderCacheForTests,
} from "./factory.js";

beforeEach(() => {
  __resetAuthProviderCacheForTests();
  process.env.WORKOS_COOKIE_PASSWORD = randomBytes(48).toString("base64");
});

test("picks LocalAuthProvider when WORKOS_API_KEY is unset", () => {
  delete process.env.WORKOS_API_KEY;
  delete process.env.WORKOS_CLIENT_ID;
  const auth = selectAuthProvider();
  assert.equal(auth.kind, "local");
});

test("picks LocalAuthProvider when WORKOS_API_KEY is empty string", () => {
  process.env.WORKOS_API_KEY = "";
  process.env.WORKOS_CLIENT_ID = "";
  const auth = selectAuthProvider();
  assert.equal(auth.kind, "local");
});

test("picks WorkOSAuthProvider when both WorkOS env vars are set", () => {
  process.env.WORKOS_API_KEY = "sk_test_dummy_value_not_real";
  process.env.WORKOS_CLIENT_ID = "client_test_dummy";
  const auth = selectAuthProvider();
  assert.equal(auth.kind, "workos");
});

test("picks LocalAuthProvider when only one of the WorkOS vars is set", () => {
  process.env.WORKOS_API_KEY = "sk_test_dummy_value_not_real";
  delete process.env.WORKOS_CLIENT_ID;
  const auth = selectAuthProvider();
  assert.equal(auth.kind, "local");
});

test("caches the provider across calls", () => {
  delete process.env.WORKOS_API_KEY;
  const a = selectAuthProvider();
  const b = selectAuthProvider();
  assert.equal(a, b);
});
