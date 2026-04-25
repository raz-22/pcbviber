/**
 * helmet config tests — pin the headers each environment ships.
 * The unit-test surface is the `helmetOptionsFor(env)` factory;
 * we don't boot a Fastify here because helmet's own behavior is
 * not what we're testing — our policy is.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { helmetOptionsFor } from "./headers.js";

function csp(env: NodeJS.ProcessEnv) {
  const opts = helmetOptionsFor(env);
  // contentSecurityPolicy is one of helmet's middleware-config
  // unions; we set it to an object with a `directives` field, so
  // narrow to that shape. `false` is the only other branch helmet's
  // type allows; we throw if it ever shows up (means our config
  // accidentally disabled CSP).
  const csp = opts.contentSecurityPolicy as
    | { directives: Record<string, string[]> }
    | false;
  if (!csp) throw new Error("CSP not configured");
  return csp.directives;
}

// ── CSP base policy ──────────────────────────────────────────────────

test("CSP default-src is 'self'", () => {
  const dir = csp({ NODE_ENV: "production" } as NodeJS.ProcessEnv);
  assert.deepEqual(dir["default-src"], ["'self'"]);
});

test("CSP frame-ancestors 'none' (no iframe embedding allowed)", () => {
  // Modern equivalent of X-Frame-Options: DENY. Belt-and-suspenders
  // with the actual X-Frame-Options header below.
  const dir = csp({ NODE_ENV: "production" } as NodeJS.ProcessEnv);
  assert.deepEqual(dir["frame-ancestors"], ["'none'"]);
});

test("CSP base-uri + form-action locked to 'self'", () => {
  // base-uri: stops <base> tag injection from rerouting relative URLs.
  // form-action: stops <form action="..."> exfiltration.
  const dir = csp({ NODE_ENV: "production" } as NodeJS.ProcessEnv);
  assert.deepEqual(dir["base-uri"], ["'self'"]);
  assert.deepEqual(dir["form-action"], ["'self'"]);
});

test("CSP style-src allows 'unsafe-inline' (Tailwind utility classes)", () => {
  // Tailwind generates inline style attributes for some utility
  // classes; without 'unsafe-inline' the SPA renders unstyled.
  // Documented in headers.ts as a deliberate trade-off.
  const dir = csp({ NODE_ENV: "production" } as NodeJS.ProcessEnv);
  assert.ok(dir["style-src"].includes("'unsafe-inline'"));
});

// ── Dev vs prod CSP differences ──────────────────────────────────────

test("prod CSP connect-src is exactly 'self' — no localhost leakage", () => {
  // Production CSP must NOT leak the dev-mode HMR allowances. If it
  // did, a prod build would silently allow connections to localhost
  // (no security impact, but a code-smell that would regress over time).
  const dir = csp({ NODE_ENV: "production" } as NodeJS.ProcessEnv);
  assert.deepEqual(dir["connect-src"], ["'self'"]);
});

test("dev CSP connect-src includes Vite HMR (localhost:5173)", () => {
  // Without this the SPA can't HMR — every save triggers a CSP
  // violation in the browser console.
  const dir = csp({ NODE_ENV: "development" } as NodeJS.ProcessEnv);
  assert.ok(
    dir["connect-src"].includes("ws://localhost:5173"),
    `connect-src missing Vite HMR ws: ${dir["connect-src"].join(",")}`
  );
  assert.ok(
    dir["connect-src"].includes("http://localhost:5173"),
    `connect-src missing Vite HMR http: ${dir["connect-src"].join(",")}`
  );
});

test("CSP useDefaults: false — our directives are the whole policy", () => {
  // helmet's default policy includes things like script-src 'self'
  // 'unsafe-inline' which we deliberately tighten. useDefaults: false
  // keeps our list authoritative.
  const opts = helmetOptionsFor({ NODE_ENV: "production" } as NodeJS.ProcessEnv);
  const cspOpts = opts.contentSecurityPolicy as { useDefaults: boolean };
  assert.equal(cspOpts.useDefaults, false);
});

// ── HSTS — production only ───────────────────────────────────────────

test("HSTS is enabled in production with 1-year max-age", () => {
  const opts = helmetOptionsFor({ NODE_ENV: "production" } as NodeJS.ProcessEnv);
  const hsts = opts.strictTransportSecurity as
    | { maxAge: number; includeSubDomains: boolean; preload: boolean }
    | false;
  assert.notEqual(hsts, false);
  if (hsts === false) throw new Error("unreachable");
  assert.equal(hsts.maxAge, 365 * 24 * 60 * 60);
  assert.equal(hsts.includeSubDomains, true);
});

test("HSTS does NOT preload — that's a one-way commitment", () => {
  // Submitting to the Chromium preload list is a deliberate launch
  // step, not an automatic side effect. Pin so a future "tidy up"
  // doesn't accidentally enable it.
  const opts = helmetOptionsFor({ NODE_ENV: "production" } as NodeJS.ProcessEnv);
  const hsts = opts.strictTransportSecurity as
    | { preload: boolean }
    | false;
  if (hsts === false) throw new Error("HSTS off in prod");
  assert.equal(hsts.preload, false);
});

test("HSTS is OFF outside production (avoid poisoning localhost for a year)", () => {
  for (const env of ["development", "test", "staging"]) {
    const opts = helmetOptionsFor({ NODE_ENV: env } as NodeJS.ProcessEnv);
    assert.equal(
      opts.strictTransportSecurity,
      false,
      `HSTS should be disabled when NODE_ENV=${env}`
    );
  }
});

// ── Other headers ────────────────────────────────────────────────────

test("frameguard: { action: 'deny' } (legacy clickjacking defense)", () => {
  const opts = helmetOptionsFor({ NODE_ENV: "production" } as NodeJS.ProcessEnv);
  assert.deepEqual(opts.frameguard, { action: "deny" });
});

test("noSniff: true — block MIME sniffing", () => {
  const opts = helmetOptionsFor({ NODE_ENV: "production" } as NodeJS.ProcessEnv);
  assert.equal(opts.noSniff, true);
});

test("Referrer-Policy: strict-origin-when-cross-origin", () => {
  const opts = helmetOptionsFor({ NODE_ENV: "production" } as NodeJS.ProcessEnv);
  assert.deepEqual(opts.referrerPolicy, {
    policy: "strict-origin-when-cross-origin",
  });
});
