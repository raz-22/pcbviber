/**
 * SPA Sentry init + PII-filter unit tests.
 *
 * Mirrors the server-side test surface: env-gating + beforeSend
 * filter. We don't test capture behavior — that's the SDK's job.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as Sentry from "@sentry/react";
import { beforeSend, initSentry, type ViteEnv } from "./sentry";

// ── Env-gating ───────────────────────────────────────────────────────

test("initSentry returns false when VITE_SENTRY_DSN is unset", () => {
  assert.equal(initSentry({} as ViteEnv), false);
});

test("initSentry returns false when VITE_SENTRY_DSN is empty / whitespace", () => {
  for (const v of ["", "   ", "\n"]) {
    assert.equal(
      initSentry({ VITE_SENTRY_DSN: v } as ViteEnv),
      false,
      `expected false for ${JSON.stringify(v)}`
    );
  }
});

test("initSentry returns true when VITE_SENTRY_DSN is non-empty", () => {
  assert.equal(
    initSentry({
      VITE_SENTRY_DSN: "https://test@sentry.example/123",
      MODE: "production",
    } as ViteEnv),
    true
  );
  assert.ok(Sentry.getClient(), "Sentry should have an active client after init");
});

// ── beforeSend PII filter ────────────────────────────────────────────

test("beforeSend strips request.cookies entirely", () => {
  const event = {
    request: { cookies: { session: "abc.def", theme: "dark" } },
  } as unknown as Sentry.ErrorEvent;
  const result = beforeSend(event);
  assert.ok(result);
  assert.equal(result.request?.cookies, undefined);
});

test("beforeSend strips Authorization / Cookie / x-csrf-token headers", () => {
  const event = {
    request: {
      headers: {
        Authorization: "Bearer pcb_secret",
        cookie: "session=abc",
        "X-Csrf-Token": "csrf-xyz",
        "User-Agent": "test",
      },
    },
  } as unknown as Sentry.ErrorEvent;
  const result = beforeSend(event);
  assert.ok(result);
  const h = result.request!.headers as Record<string, string>;
  assert.equal(h.Authorization, undefined);
  assert.equal(h.cookie, undefined);
  assert.equal(h["X-Csrf-Token"], undefined);
  assert.equal(h["User-Agent"], "test");
});

test("beforeSend redacts email + password in request.data", () => {
  // The SPA's fetch wrapper doesn't put bodies through Sentry by
  // default, but XHR breadcrumbs + manual capture calls can. The
  // filter is defense in depth + matches the server's filter so
  // both halves of the stack apply the same redaction policy.
  const event = {
    request: {
      data: {
        email: "alice@example.test",
        password: "secret",
        orgName: "OK",
      },
    },
  } as unknown as Sentry.ErrorEvent;
  const result = beforeSend(event);
  assert.ok(result);
  const data = result.request!.data as Record<string, unknown>;
  assert.equal(data.email, "[REDACTED]");
  assert.equal(data.password, "[REDACTED]");
  assert.equal(data.orgName, "OK");
});

test("beforeSend strips email / username / ip from user context", () => {
  const event = {
    user: {
      id: "user_abc",
      email: "alice@example.test",
      username: "alice",
      ip_address: "203.0.113.5",
    },
  } as unknown as Sentry.ErrorEvent;
  const result = beforeSend(event);
  assert.ok(result);
  assert.equal(result.user?.id, "user_abc");
  assert.equal(result.user?.email, undefined);
  assert.equal(result.user?.username, undefined);
  assert.equal(result.user?.ip_address, undefined);
});

test("beforeSend handles empty / missing request gracefully", () => {
  // A render error (no HTTP context) carries no request shape.
  // The filter must not throw.
  const result1 = beforeSend({} as Sentry.ErrorEvent);
  assert.ok(result1);
  const result2 = beforeSend({ request: {} } as Sentry.ErrorEvent);
  assert.ok(result2);
});
