/**
 * Sentry init + PII-filter unit tests.
 *
 * We don't test that Sentry actually ships events — that's the
 * SDK's job. Two things ARE ours to verify:
 *
 *   1. Env-gating: initSentry returns true iff SENTRY_DSN is set
 *      + non-empty. Production wiring depends on that boolean
 *      to know whether observability is live.
 *   2. The `beforeSend` filter scrubs PII + credentials before
 *      events leave the process. This is a security-relevant
 *      pure function and deserves explicit pinning.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as Sentry from "@sentry/node";
import { beforeSend, initSentry } from "./sentry.js";

// ── Env-gating ───────────────────────────────────────────────────────

test("initSentry returns false when SENTRY_DSN is unset", () => {
  const env: NodeJS.ProcessEnv = {};
  assert.equal(initSentry(env), false);
});

test("initSentry returns false when SENTRY_DSN is empty / whitespace", () => {
  // A blank `SENTRY_DSN=` line in .env shouldn't trip us into
  // calling Sentry.init with garbage. Same env-blank handling
  // pattern as the rest of the factory selectors in the monorepo.
  for (const v of ["", "   ", "\n"]) {
    assert.equal(
      initSentry({ SENTRY_DSN: v }),
      false,
      `expected false for ${JSON.stringify(v)}`
    );
  }
});

test("initSentry returns true when SENTRY_DSN is a non-empty string", () => {
  // Sentry's init with a fake DSN is harmless — it constructs a
  // client but won't ship events to the placeholder host. We just
  // assert the gating boolean here.
  const env: NodeJS.ProcessEnv = {
    SENTRY_DSN: "https://test@sentry.example/123",
    NODE_ENV: "production",
  };
  assert.equal(initSentry(env), true);
  // Sanity: the SDK is now active (init populated the client).
  // getClient() returns the active client when one is set; we
  // just check it's defined as a smoke test.
  assert.ok(Sentry.getClient(), "Sentry should have an active client");
});

// ── beforeSend PII filter ────────────────────────────────────────────

test("beforeSend strips request.cookies entirely", () => {
  // Even a "harmless" cookie like `theme=dark` shouldn't leak —
  // session cookies live in the same bag and a partial allowlist
  // would risk forgetting one. Drop the whole object.
  const event = {
    request: {
      cookies: { session: "abc.def", theme: "dark" },
    },
  } as unknown as Sentry.ErrorEvent;
  const result = beforeSend(event);
  assert.ok(result);
  assert.equal(result.request?.cookies, undefined);
});

test("beforeSend strips Authorization / Cookie / x-csrf-token headers", () => {
  // Header names are case-insensitive; the filter must catch
  // `Authorization` AND `authorization` AND `AUTHORIZATION`.
  const event = {
    request: {
      headers: {
        "User-Agent": "test",
        Authorization: "Bearer pcb_secret_token",
        cookie: "session=abc.def",
        "X-Csrf-Token": "csrf-xyz",
        Accept: "application/json",
      },
    },
  } as unknown as Sentry.ErrorEvent;
  const result = beforeSend(event);
  assert.ok(result);
  const h = result.request!.headers as Record<string, string>;
  // Sensitive headers gone.
  assert.equal(h.Authorization, undefined);
  assert.equal(h.cookie, undefined);
  assert.equal(h["X-Csrf-Token"], undefined);
  // Innocuous ones preserved.
  assert.equal(h["User-Agent"], "test");
  assert.equal(h.Accept, "application/json");
});

test("beforeSend redacts email + password in request.data", () => {
  // Auth routes (signup / login) carry email + password in the
  // body. A 5xx during signup would otherwise capture them
  // verbatim into Sentry — which is a credential leak.
  const event = {
    request: {
      data: {
        email: "alice@example.test",
        password: "correct horse battery staple",
        orgName: "Alice's Hardware",
      },
    },
  } as unknown as Sentry.ErrorEvent;
  const result = beforeSend(event);
  assert.ok(result);
  const data = result.request!.data as Record<string, unknown>;
  assert.equal(data.email, "[REDACTED]");
  assert.equal(data.password, "[REDACTED]");
  // Non-sensitive fields preserved so the captured event is
  // still useful for debugging.
  assert.equal(data.orgName, "Alice's Hardware");
});

test("beforeSend redacts email in query_string params", () => {
  // Defensive: query strings shouldn't carry email, but if a
  // future route accidentally does, Sentry must not capture it.
  const event = {
    request: {
      query_string: { email: "bob@example.test", q: "STM32" },
    },
  } as unknown as Sentry.ErrorEvent;
  const result = beforeSend(event);
  assert.ok(result);
  const qs = result.request!.query_string as Record<string, unknown>;
  assert.equal(qs.email, "[REDACTED]");
  assert.equal(qs.q, "STM32");
});

test("beforeSend strips email / username / ip from user context", () => {
  // We set `Sentry.setUser({ id })` only — never email — but a
  // future callsite that forgets shouldn't be able to leak PII.
  // Defense in depth: drop email + username + ip every time.
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
  // An exception captured outside any HTTP context (e.g. a
  // background job) has no request. The filter must not throw.
  const result1 = beforeSend({} as Sentry.ErrorEvent);
  assert.ok(result1);
  // Even an event with `request` but no inner fields shouldn't
  // throw — the filter walks each branch independently.
  const result2 = beforeSend({ request: {} } as Sentry.ErrorEvent);
  assert.ok(result2);
});
