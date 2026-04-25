/**
 * API client unit tests. Replaces the global `fetch` with a controllable
 * stub so we can pin every status-code branch without spinning a server.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { api, ApiError } from "./api";

type FetchStub = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const realFetch = globalThis.fetch;

function installFetch(impl: FetchStub) {
  globalThis.fetch = impl as typeof globalThis.fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  // Restore real fetch between tests so a forgotten stub doesn't leak.
  globalThis.fetch = realFetch;
});

// ─── credentials: include — sent on every request ────────────────────

test("call() sends credentials:include on every fetch", async () => {
  const seen: RequestInit[] = [];
  installFetch(async (_url, init) => {
    seen.push(init ?? {});
    return jsonResponse(200, {});
  });
  await api.health();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].credentials, "include");
});

test("call() sets Content-Type only when there's a body", async () => {
  const seen: RequestInit[] = [];
  installFetch(async (_url, init) => {
    seen.push(init ?? {});
    return jsonResponse(200, { ok: true });
  });
  // GET — no body, no Content-Type expected.
  await api.health();
  // POST — has body, Content-Type set.
  await api.login({ email: "a@b.test", password: "x" });

  const get = seen[0];
  const post = seen[1];

  assert.equal((get.headers as Record<string, string> | undefined)?.["Content-Type"], undefined);
  assert.equal(
    (post.headers as Record<string, string>)["Content-Type"],
    "application/json"
  );
  assert.equal(post.method, "POST");
  assert.ok(typeof post.body === "string");
});

// ─── happy paths ─────────────────────────────────────────────────────

test("api.signup posts to /api/auth/signup and returns the parsed body", async () => {
  let calledUrl = "";
  let calledBody = "";
  installFetch(async (url, init) => {
    calledUrl = String(url);
    calledBody = String(init?.body);
    return jsonResponse(200, {
      user: {
        id: "u1",
        email: "alice@example.com",
        emailVerifiedAt: null,
        createdAt: "2026-04-24T00:00:00Z",
      },
      org: { id: "o1", slug: "alice", name: "Alice's Organization" },
    });
  });
  const out = await api.signup({ email: "alice@example.com", password: "x".repeat(12) });
  assert.equal(calledUrl, "/api/auth/signup");
  assert.match(calledBody, /alice@example\.com/);
  assert.equal(out.user.email, "alice@example.com");
  assert.equal(out.org.slug, "alice");
});

test("api.login posts to /api/auth/login", async () => {
  let calledUrl = "";
  installFetch(async (url) => {
    calledUrl = String(url);
    return jsonResponse(200, {
      user: { id: "u1", email: "a@b.test", emailVerifiedAt: null, createdAt: "" },
      orgs: [],
    });
  });
  await api.login({ email: "a@b.test", password: "p".repeat(12) });
  assert.equal(calledUrl, "/api/auth/login");
});

test("api.logout posts to /api/auth/logout", async () => {
  let calledUrl = "";
  let calledMethod = "";
  installFetch(async (url, init) => {
    calledUrl = String(url);
    calledMethod = init?.method ?? "GET";
    return jsonResponse(200, { ok: true });
  });
  const out = await api.logout();
  assert.equal(calledUrl, "/api/auth/logout");
  assert.equal(calledMethod, "POST");
  assert.deepEqual(out, { ok: true });
});

test("api.me GETs /api/auth/me", async () => {
  let calledMethod = "";
  installFetch(async (_url, init) => {
    calledMethod = init?.method ?? "GET";
    return jsonResponse(200, {
      user: { id: "u", email: "e", emailVerifiedAt: null, createdAt: "" },
      orgs: [],
    });
  });
  await api.me();
  assert.equal(calledMethod, "GET");
});

// ─── error mapping ───────────────────────────────────────────────────

/** Asserts-narrows an `unknown` catch value to ApiError. */
function expectApiError(err: unknown): asserts err is ApiError {
  if (!(err instanceof ApiError)) {
    throw new Error(
      `expected ApiError, got ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

test("401 with code → ApiError(status=401, code='invalid_credentials')", async () => {
  installFetch(async () => jsonResponse(401, { error: "invalid_credentials" }));
  try {
    await api.login({ email: "a@b.test", password: "wrong" });
    assert.fail("should have thrown");
  } catch (err) {
    expectApiError(err);
    assert.equal(err.status, 401);
    assert.equal(err.code, "invalid_credentials");
  }
});

test("409 → ApiError(code='email_taken')", async () => {
  installFetch(async () => jsonResponse(409, { error: "email_taken" }));
  try {
    await api.signup({ email: "a@b.test", password: "x".repeat(12) });
    assert.fail("should have thrown");
  } catch (err) {
    expectApiError(err);
    assert.equal(err.status, 409);
    assert.equal(err.code, "email_taken");
  }
});

test("400 with structured detail surfaces detail on the ApiError", async () => {
  installFetch(async () =>
    jsonResponse(400, {
      error: "invalid_input",
      detail: { fieldErrors: { email: ["invalid"] } },
    })
  );
  try {
    await api.signup({ email: "garbage", password: "x".repeat(12) });
    assert.fail("should have thrown");
  } catch (err) {
    expectApiError(err);
    assert.equal(err.status, 400);
    assert.equal(err.code, "invalid_input");
    assert.deepEqual(err.detail, { fieldErrors: { email: ["invalid"] } });
  }
});

test("non-JSON error response yields ApiError without a parseable code", async () => {
  installFetch(
    async () =>
      new Response("upstream is down", {
        status: 502,
        headers: { "content-type": "text/plain" },
      })
  );
  try {
    await api.health();
    assert.fail("should have thrown");
  } catch (err) {
    expectApiError(err);
    assert.equal(err.status, 502);
    // code stays null — caller falls back to generic message
    assert.equal(err.code, null);
  }
});

test("204 No Content resolves with undefined", async () => {
  installFetch(async () => new Response(null, { status: 204 }));
  // The shape isn't really `void`, but the typed call returns undefined.
  // We pick logout as the route most likely to ever return 204.
  const out = await api.logout();
  assert.equal(out, undefined);
});

test("network error (fetch throws) propagates as a regular Error, not ApiError", async () => {
  installFetch(async () => {
    throw new TypeError("network down");
  });
  try {
    await api.me();
    assert.fail("should have thrown");
  } catch (err) {
    if (!(err instanceof Error)) throw new Error("expected Error");
    assert.ok(!(err instanceof ApiError));
    assert.match(err.message, /network down/);
  }
});

// ─── parts URLs (regression) ─────────────────────────────────────────

test("api.searchParts encodes query + limit in the URL", async () => {
  let url = "";
  installFetch(async (u) => {
    url = String(u);
    return jsonResponse(200, []);
  });
  await api.searchParts("100uF 25V", 5);
  assert.equal(url, "/api/parts/search?query=100uF%2025V&limit=5");
});

test("api.checkAvailability encodes the MPN in the URL", async () => {
  let url = "";
  installFetch(async (u) => {
    url = String(u);
    return jsonResponse(200, { notFound: true, mpn: "X" });
  });
  await api.checkAvailability("STM32F407");
  assert.equal(url, "/api/parts/availability?mpn=STM32F407");
});
