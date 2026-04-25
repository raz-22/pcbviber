/**
 * CSRF integration tests — pin the double-submit-cookie contract:
 *
 *   - GET /api/csrf returns `{ csrfToken }` and sets the matching
 *     cookie. Subsequent POST with the token in the
 *     `x-csrf-token` header succeeds.
 *   - POST without the header → 403 csrf_invalid.
 *   - POST with a mismatched / forged token → 403 csrf_invalid.
 *   - csrfOrPassthrough returns a no-op when the plugin isn't
 *     registered (test-mode safety net for unit tests).
 *
 * We don't bring up the full server — just a minimal Fastify with
 * cookie + csrf-protection + one CSRF-protected POST + the bootstrap
 * GET. Keeps the test scope to "is the contract right?" rather
 * than "does every route use it?" (which is best verified by a
 * code-search, and is implicit in the route-test files).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import csrfProtection from "@fastify/csrf-protection";
import {
  csrfOrPassthrough,
  getCsrfTokenFromHeader,
  installCsrfErrorHandler,
} from "./csrf.js";

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(csrfProtection, {
    sessionPlugin: "@fastify/cookie",
    cookieKey: "_csrf",
    cookieOpts: { httpOnly: true, sameSite: "lax", path: "/" },
    getToken: getCsrfTokenFromHeader,
  });
  installCsrfErrorHandler(app);
  app.get("/api/csrf", async (_req, reply) => {
    const csrfToken = reply.generateCsrf();
    return { csrfToken };
  });
  app.post(
    "/protected",
    { preHandler: csrfOrPassthrough(app) },
    async () => ({ ok: true })
  );
  await app.ready();
  return app;
}

function csrfCookieFromBootstrap(setCookie: string | string[] | undefined): string {
  const all = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
  for (const sc of all) {
    const m = /^_csrf=([^;]*)/.exec(sc);
    if (m && m[1]) return `_csrf=${m[1]}`;
  }
  throw new Error("test: missing _csrf cookie on bootstrap response");
}

test("GET /api/csrf returns a token + sets the cookie", async () => {
  const app = await buildApp();
  try {
    const res = await app.inject({ method: "GET", url: "/api/csrf" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { csrfToken: string };
    assert.equal(typeof body.csrfToken, "string");
    assert.ok(body.csrfToken.length > 10);
    // Cookie set so the SPA's session can carry it across requests.
    const setCookie = res.headers["set-cookie"];
    assert.ok(
      setCookie && /_csrf=/.test(String(setCookie)),
      "expected _csrf= cookie on bootstrap"
    );
  } finally {
    await app.close();
  }
});

test("POST without x-csrf-token header → 403 csrf_invalid", async () => {
  const app = await buildApp();
  try {
    const res = await app.inject({ method: "POST", url: "/protected" });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error, "csrf_invalid");
  } finally {
    await app.close();
  }
});

test("POST with matching cookie + x-csrf-token header → 200", async () => {
  const app = await buildApp();
  try {
    // Bootstrap.
    const boot = await app.inject({ method: "GET", url: "/api/csrf" });
    const token = (boot.json() as { csrfToken: string }).csrfToken;
    const cookieHeader = csrfCookieFromBootstrap(boot.headers["set-cookie"]);

    const res = await app.inject({
      method: "POST",
      url: "/protected",
      headers: { cookie: cookieHeader, "x-csrf-token": token },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true });
  } finally {
    await app.close();
  }
});

test("POST with mismatched x-csrf-token (forged) → 403 csrf_invalid", async () => {
  // The cookie is real (we bootstrapped); the header is a different
  // token. The plugin's HMAC check fails → 403.
  const app = await buildApp();
  try {
    const boot = await app.inject({ method: "GET", url: "/api/csrf" });
    const cookieHeader = csrfCookieFromBootstrap(boot.headers["set-cookie"]);

    const res = await app.inject({
      method: "POST",
      url: "/protected",
      headers: {
        cookie: cookieHeader,
        "x-csrf-token": "forged-token-that-does-not-match-the-cookie",
      },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error, "csrf_invalid");
  } finally {
    await app.close();
  }
});

test("POST with header but NO cookie → 403 csrf_invalid", async () => {
  // SPA misconfig: lost the cookie but kept the in-memory token.
  // Plugin needs both to validate; missing cookie → 403.
  const app = await buildApp();
  try {
    const boot = await app.inject({ method: "GET", url: "/api/csrf" });
    const token = (boot.json() as { csrfToken: string }).csrfToken;
    const res = await app.inject({
      method: "POST",
      url: "/protected",
      headers: { "x-csrf-token": token },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error, "csrf_invalid");
  } finally {
    await app.close();
  }
});

// ── csrfOrPassthrough — test-mode safety net ─────────────────────────

test("csrfOrPassthrough returns a no-op when the plugin isn't registered", async () => {
  // This is what makes existing route tests work without registering
  // the plugin — the helper detects the missing decorator and
  // installs a permit-everything preHandler. CSRF behavior is
  // verified by the dedicated tests above.
  const app = Fastify({ logger: false });
  await app.ready();
  try {
    const handler = csrfOrPassthrough(app);
    // Sanity: returns a function (Fastify accepts it as a preHandler).
    assert.equal(typeof handler, "function");
    // Invoke as the route would — `.call(app, …)` so the
    // FastifyInstance `this` binding the preHandler type expects
    // is satisfied. The no-op never reads its arguments; we pass
    // empty objects.
    await handler.call(
      app,
      {} as Parameters<typeof handler>[0],
      {} as Parameters<typeof handler>[1]
    );
  } finally {
    await app.close();
  }
});

test("csrfOrPassthrough returns the real preHandler when the plugin is registered", async () => {
  const app = await buildApp();
  try {
    const handler = csrfOrPassthrough(app);
    // The plugin's preHandler is the function it decorated as
    // `app.csrfProtection`. csrfOrPassthrough should hand back
    // the same reference (no wrapping that would break behavior).
    assert.equal(handler, (app as { csrfProtection: unknown }).csrfProtection);
  } finally {
    await app.close();
  }
});

// ── getCsrfTokenFromHeader unit test ─────────────────────────────────

test("getCsrfTokenFromHeader reads the x-csrf-token header verbatim", () => {
  const fakeReq = {
    headers: { "x-csrf-token": "abc.def.ghi" },
  } as unknown as Parameters<typeof getCsrfTokenFromHeader>[0];
  assert.equal(getCsrfTokenFromHeader(fakeReq), "abc.def.ghi");
});

test("getCsrfTokenFromHeader returns undefined when header is missing", () => {
  const fakeReq = { headers: {} } as unknown as Parameters<
    typeof getCsrfTokenFromHeader
  >[0];
  assert.equal(getCsrfTokenFromHeader(fakeReq), undefined);
});
