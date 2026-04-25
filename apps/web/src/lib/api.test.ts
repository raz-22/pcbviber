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

// ─── tenant-scoped Nexar URLs (PR 2.3 routes) ────────────────────────

test("api.searchParts hits the tenant-scoped path with encoded query + limit", async () => {
  let url = "";
  installFetch(async (u) => {
    url = String(u);
    return jsonResponse(200, []);
  });
  await api.searchParts("o1", "w1", "100uF 25V", 5);
  assert.equal(
    url,
    "/api/orgs/o1/workspaces/w1/parts/search?query=100uF%2025V&limit=5"
  );
});

test("api.searchParts encodes orgId and workspaceId path components", async () => {
  let url = "";
  installFetch(async (u) => {
    url = String(u);
    return jsonResponse(200, []);
  });
  // Slash and space in IDs would corrupt the URL if not encoded.
  await api.searchParts("org/with slash", "ws id", "x", 10);
  assert.equal(
    url,
    "/api/orgs/org%2Fwith%20slash/workspaces/ws%20id/parts/search?query=x&limit=10"
  );
});

test("api.checkAvailability hits tenant path with encoded MPN", async () => {
  let url = "";
  installFetch(async (u) => {
    url = String(u);
    return jsonResponse(200, { notFound: true, mpn: "X" });
  });
  await api.checkAvailability("o1", "w1", "STM32F407");
  assert.equal(url, "/api/orgs/o1/workspaces/w1/parts/availability?mpn=STM32F407");
});

test("api.findAlternatives encodes both mpn and criteria", async () => {
  let url = "";
  installFetch(async (u) => {
    url = String(u);
    return jsonResponse(200, { notFound: true, mpn: "X" });
  });
  await api.findAlternatives("o1", "w1", "LM358", "pin compatible");
  assert.equal(
    url,
    "/api/orgs/o1/workspaces/w1/parts/alternatives?mpn=LM358&criteria=pin%20compatible"
  );
});

test("api.listLibraryComponents omits ?altiumWorkspaceUrl when not provided", async () => {
  let url = "";
  installFetch(async (u) => {
    url = String(u);
    return jsonResponse(200, []);
  });
  await api.listLibraryComponents("o1", "w1");
  assert.equal(url, "/api/orgs/o1/workspaces/w1/library/components");
});

test("api.listLibraryComponents encodes the altium url when provided", async () => {
  let url = "";
  installFetch(async (u) => {
    url = String(u);
    return jsonResponse(200, []);
  });
  await api.listLibraryComponents("o1", "w1", "https://acme.altium365.com/workspaces/x");
  assert.equal(
    url,
    "/api/orgs/o1/workspaces/w1/library/components?altiumWorkspaceUrl=https%3A%2F%2Facme.altium365.com%2Fworkspaces%2Fx"
  );
});

test("api.listAltium365Workspaces hits the altium-365/workspaces path", async () => {
  let url = "";
  installFetch(async (u) => {
    url = String(u);
    return jsonResponse(200, { workspaces: [] });
  });
  await api.listAltium365Workspaces("o1", "w1");
  assert.equal(url, "/api/orgs/o1/workspaces/w1/altium-365/workspaces");
});

test("api.listAltium365Projects passes altiumWorkspaceUrl in query when provided", async () => {
  let url = "";
  installFetch(async (u) => {
    url = String(u);
    return jsonResponse(200, { projects: [] });
  });
  await api.listAltium365Projects("o1", "w1", "https://acme.altium365.com/workspaces/x");
  assert.equal(
    url,
    "/api/orgs/o1/workspaces/w1/altium-365/projects?altiumWorkspaceUrl=https%3A%2F%2Facme.altium365.com%2Fworkspaces%2Fx"
  );
});

// ─── Workspace CRUD URLs ─────────────────────────────────────────────

test("api.listWorkspaces GETs /api/orgs/:orgId/workspaces", async () => {
  let url = "";
  let method = "";
  installFetch(async (u, init) => {
    url = String(u);
    method = init?.method ?? "GET";
    return jsonResponse(200, { workspaces: [] });
  });
  await api.listWorkspaces("org-1");
  assert.equal(url, "/api/orgs/org-1/workspaces");
  assert.equal(method, "GET");
});

test("api.getWorkspace GETs /api/orgs/:orgId/workspaces/:id", async () => {
  let url = "";
  installFetch(async (u) => {
    url = String(u);
    return jsonResponse(200, {
      workspace: {
        id: "ws-1",
        orgId: "org-1",
        altiumWorkspaceUrl: null,
        hasNexarCredentials: true,
        hasAltiumRestToken: false,
        createdAt: "2026-04-25T00:00:00Z",
      },
    });
  });
  const out = await api.getWorkspace("org-1", "ws-1");
  assert.equal(url, "/api/orgs/org-1/workspaces/ws-1");
  assert.equal(out.workspace.id, "ws-1");
  assert.equal(out.workspace.hasNexarCredentials, true);
});

test("api.createWorkspace POSTs to /api/orgs/:orgId/workspaces with the input as JSON", async () => {
  let url = "";
  let method = "";
  let body = "";
  let contentType: string | undefined;
  installFetch(async (u, init) => {
    url = String(u);
    method = init?.method ?? "GET";
    body = String(init?.body);
    contentType = (init?.headers as Record<string, string> | undefined)?.[
      "Content-Type"
    ];
    return jsonResponse(201, {
      workspace: {
        id: "ws-new",
        orgId: "org-1",
        altiumWorkspaceUrl: null,
        hasNexarCredentials: true,
        hasAltiumRestToken: false,
        createdAt: "2026-04-25T00:00:00Z",
      },
    });
  });
  const out = await api.createWorkspace("org-1", {
    nexarClientId: "id",
    nexarClientSecret: "secret",
  });
  assert.equal(url, "/api/orgs/org-1/workspaces");
  assert.equal(method, "POST");
  assert.equal(contentType, "application/json");
  assert.match(body, /"nexarClientId":"id"/);
  assert.equal(out.workspace.id, "ws-new");
});

test("api.updateWorkspace PATCHes the workspace path", async () => {
  let url = "";
  let method = "";
  let body = "";
  installFetch(async (u, init) => {
    url = String(u);
    method = init?.method ?? "GET";
    body = String(init?.body);
    return jsonResponse(200, {
      workspace: {
        id: "ws-1",
        orgId: "org-1",
        altiumWorkspaceUrl: "https://acme.altium365.com/x",
        hasNexarCredentials: true,
        hasAltiumRestToken: false,
        createdAt: "2026-04-25T00:00:00Z",
      },
    });
  });
  await api.updateWorkspace("org-1", "ws-1", {
    altiumWorkspaceUrl: "https://acme.altium365.com/x",
  });
  assert.equal(url, "/api/orgs/org-1/workspaces/ws-1");
  assert.equal(method, "PATCH");
  assert.match(body, /altiumWorkspaceUrl/);
});

test("api.deleteWorkspace DELETEs the workspace path and returns the ok envelope", async () => {
  let url = "";
  let method = "";
  installFetch(async (u, init) => {
    url = String(u);
    method = init?.method ?? "GET";
    return jsonResponse(200, { ok: true });
  });
  const out = await api.deleteWorkspace("org-1", "ws-1");
  assert.equal(url, "/api/orgs/org-1/workspaces/ws-1");
  assert.equal(method, "DELETE");
  assert.deepEqual(out, { ok: true });
});

test("api.testWorkspaceConnection POSTs to .../workspaces/test-connection", async () => {
  let url = "";
  let method = "";
  installFetch(async (u, init) => {
    url = String(u);
    method = init?.method ?? "GET";
    return jsonResponse(200, { ok: true });
  });
  const out = await api.testWorkspaceConnection("org-1", {
    nexarClientId: "id",
    nexarClientSecret: "secret",
  });
  assert.equal(url, "/api/orgs/org-1/workspaces/test-connection");
  assert.equal(method, "POST");
  assert.deepEqual(out, { ok: true });
});

test("422 from test-connection surfaces credentials_rejected as ApiError", async () => {
  installFetch(async () =>
    jsonResponse(422, { error: "credentials_rejected", detail: "401", status: 401 })
  );
  try {
    await api.testWorkspaceConnection("org-1", {
      nexarClientId: "bad",
      nexarClientSecret: "bad",
    });
    assert.fail("should have thrown");
  } catch (err) {
    expectApiError(err);
    assert.equal(err.status, 422);
    assert.equal(err.code, "credentials_rejected");
  }
});

test("503 from a parts call surfaces workspace_not_configured", async () => {
  installFetch(async () =>
    jsonResponse(503, {
      error: "workspace_not_configured",
      detail: "Add credentials in Settings.",
    })
  );
  try {
    await api.searchParts("org-1", "ws-1", "x", 5);
    assert.fail("should have thrown");
  } catch (err) {
    expectApiError(err);
    assert.equal(err.status, 503);
    assert.equal(err.code, "workspace_not_configured");
  }
});

test("503 with workspace_unavailable propagates the code", async () => {
  installFetch(async () =>
    jsonResponse(503, { error: "workspace_unavailable", detail: "decrypt failed" })
  );
  try {
    await api.searchParts("org-1", "ws-1", "x", 5);
    assert.fail("should have thrown");
  } catch (err) {
    expectApiError(err);
    assert.equal(err.status, 503);
    assert.equal(err.code, "workspace_unavailable");
  }
});

test("404 from a workspace path surfaces not_found", async () => {
  installFetch(async () => jsonResponse(404, { error: "not_found" }));
  try {
    await api.getWorkspace("org-1", "missing");
    assert.fail("should have thrown");
  } catch (err) {
    expectApiError(err);
    assert.equal(err.status, 404);
    assert.equal(err.code, "not_found");
  }
});

test("403 from a workspace path surfaces forbidden", async () => {
  installFetch(async () => jsonResponse(403, { error: "forbidden" }));
  try {
    await api.deleteWorkspace("org-1", "ws-1");
    assert.fail("should have thrown");
  } catch (err) {
    expectApiError(err);
    assert.equal(err.status, 403);
    assert.equal(err.code, "forbidden");
  }
});
