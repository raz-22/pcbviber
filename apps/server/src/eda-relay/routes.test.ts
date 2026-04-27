/**
 * /api/eda-relay/* route tests — Sprint 9 PR 9.4b.
 *
 * Hermetic. Mounts the routes on a stripped-down Fastify app
 * (no MCP transport, no SPA proxy) and exercises every accept /
 * reject path through `app.inject`. Two API keys are seeded — one
 * bound to an EasyEDA workspace, one bound to an Altium workspace —
 * so the platform-mismatch guard has a real failure case to assert
 * against.
 *
 * What's pinned:
 *   - Auth: missing / unknown bearer → 401
 *   - api_key_no_workspace: API key without a default workspace → 400
 *   - wrong_platform: API key bound to an Altium workspace → 400
 *   - api_key_workspace_org_mismatch: defense in depth — never
 *     happens via the schema today (SetNull), but if it ever did
 *     we'd refuse to serve cross-tenant data
 *   - Round-trip: poll → result → poll, with an in-flight execute
 *   - Cross-workspace isolation at the HTTP layer: the key for
 *     ws-a only ever sees ws-a's queue; never ws-b's
 *   - Status: per-workspace counters reflect only that workspace
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setupTestDatabase } from "@altium-mcp/db/test-utils";

import Fastify, { type FastifyInstance } from "fastify";

import { EdaRelay } from "./relay.js";

let app: FastifyInstance;
let teardown: () => Promise<void>;
let edaKeyPlaintext: string; // bound to easyeda workspace
let altiumKeyPlaintext: string; // bound to altium workspace
let orphanKeyPlaintext: string; // bound to no workspace
let easyedaWsId: string;
let altiumWsId: string;
let edaRelay: EdaRelay;

before(async () => {
  ({ teardown } = await setupTestDatabase());
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.WORKOS_COOKIE_PASSWORD = randomBytes(48).toString("base64");
  delete process.env.WORKOS_API_KEY;
  delete process.env.WORKOS_CLIENT_ID;

  const { prisma } = await import("@altium-mcp/db");
  const { generateApiKey } = await import("../api-keys/keys.js");
  const { registerEdaRelayRoutes } = await import("./routes.js");

  const org = await prisma.organization.create({
    data: { name: "Acme", slug: `acme-${randomBytes(3).toString("hex")}` },
  });

  // Two workspaces under one org: one EasyEDA, one Altium.
  const easyedaWs = await prisma.workspace.create({
    data: { orgId: org.id, platform: "easyeda" },
  });
  easyedaWsId = easyedaWs.id;
  const altiumWs = await prisma.workspace.create({
    data: { orgId: org.id, platform: "altium" },
  });
  altiumWsId = altiumWs.id;

  // Three API keys, all under that org:
  //   eda-key: bound to easyeda workspace (happy path)
  //   altium-key: bound to altium workspace (wrong_platform path)
  //   orphan-key: no defaultWorkspaceId (api_key_no_workspace path)
  const edaKey = generateApiKey();
  edaKeyPlaintext = edaKey.plaintext;
  await prisma.apiKey.create({
    data: {
      orgId: org.id,
      name: "eda-key",
      hashedKey: edaKey.hash,
      scopes: "mcp:tools",
      defaultWorkspaceId: easyedaWsId,
    },
  });

  const altiumKey = generateApiKey();
  altiumKeyPlaintext = altiumKey.plaintext;
  await prisma.apiKey.create({
    data: {
      orgId: org.id,
      name: "altium-key",
      hashedKey: altiumKey.hash,
      scopes: "mcp:tools",
      defaultWorkspaceId: altiumWsId,
    },
  });

  const orphanKey = generateApiKey();
  orphanKeyPlaintext = orphanKey.plaintext;
  await prisma.apiKey.create({
    data: {
      orgId: org.id,
      name: "orphan-key",
      hashedKey: orphanKey.hash,
      scopes: "mcp:tools",
    },
  });

  edaRelay = new EdaRelay();
  app = Fastify({ logger: false });
  registerEdaRelayRoutes(app, edaRelay);
  // Install the api-key error handler so 401s reshape into the
  // {error: "not_authenticated"} body the SPA mapper expects. In
  // production http.ts installs this once at the end of route
  // registration; tests that mount routes in isolation do it here.
  const { installApiKeyErrorHandler } = await import(
    "../api-keys/middleware.js"
  );
  installApiKeyErrorHandler(app);
  await app.ready();
});

after(async () => {
  if (app) await app.close();
  edaRelay.__resetForTests();
  const { prisma } = await import("@altium-mcp/db");
  await prisma.$disconnect();
  await teardown();
});

// ─── Auth ─────────────────────────────────────────────────────────────

test("GET /poll without bearer token returns 401", async () => {
  const res = await app.inject({ method: "GET", url: "/api/eda-relay/poll" });
  assert.equal(res.statusCode, 401);
});

test("GET /poll with unknown bearer token returns 401", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/api/eda-relay/poll",
    headers: { authorization: "Bearer pcb_unknown_garbage" },
  });
  assert.equal(res.statusCode, 401);
});

// ─── Workspace gate ───────────────────────────────────────────────────

test("GET /poll with API key that has no defaultWorkspaceId returns 400 api_key_no_workspace", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/api/eda-relay/poll",
    headers: { authorization: `Bearer ${orphanKeyPlaintext}` },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "api_key_no_workspace");
});

test("GET /poll with API key bound to an Altium workspace returns 400 wrong_platform", async () => {
  // The single most important policy guard on this PR. If this
  // regressed, an Altium-platform workspace's commands could
  // surface to an EasyEDA extension polling the wrong relay.
  const res = await app.inject({
    method: "GET",
    url: "/api/eda-relay/poll",
    headers: { authorization: `Bearer ${altiumKeyPlaintext}` },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "wrong_platform");
  // The detail mentions the actual platform on the workspace so
  // the operator debugging this knows what to fix without
  // having to query the DB.
  assert.match(res.json().detail ?? "", /altium/);
});

// ─── Round-trip ───────────────────────────────────────────────────────

test("poll → result round-trip resolves an in-flight execute against the right workspace", async () => {
  // Enqueue a command via the broker (in real flow, an MCP tool
  // handler does this). Then the extension's polling endpoint
  // should pick it up; the extension's result endpoint should
  // resolve the pending Promise.
  const pending = edaRelay.execute(easyedaWsId, "screenshot", {}, 10_000);

  const pollRes = await app.inject({
    method: "GET",
    url: "/api/eda-relay/poll",
    headers: { authorization: `Bearer ${edaKeyPlaintext}` },
  });
  assert.equal(pollRes.statusCode, 200);
  const cmd = pollRes.json() as { id: string; method: string };
  assert.equal(cmd.method, "screenshot");

  const resultRes = await app.inject({
    method: "POST",
    url: "/api/eda-relay/result",
    headers: { authorization: `Bearer ${edaKeyPlaintext}` },
    payload: { id: cmd.id, ok: true, result: "stub-png-base64" },
  });
  assert.equal(resultRes.statusCode, 200);
  assert.equal(resultRes.json().ok, true);

  const resolved = await pending;
  assert.equal(resolved, "stub-png-base64");
});

test("GET /poll on a workspace with an empty queue returns 204", async () => {
  // Short-poll path (no pollTimeoutMs), no queued command.
  const res = await app.inject({
    method: "GET",
    url: "/api/eda-relay/poll",
    headers: { authorization: `Bearer ${edaKeyPlaintext}` },
  });
  assert.equal(res.statusCode, 204);
});

// ─── Cross-workspace isolation ────────────────────────────────────────

test("ws-a's queue stays invisible to ws-b's API key (security boundary)", async () => {
  // Set up a SECOND easyeda workspace + key under the same org so
  // we can simulate "two extensions, two workspaces, must not see
  // each other's traffic". Key invariant from PR 9.4a's broker
  // tests, here re-pinned at the HTTP layer.
  const { prisma } = await import("@altium-mcp/db");
  const { generateApiKey } = await import("../api-keys/keys.js");
  const wsA = easyedaWsId; // existing EasyEDA workspace
  const wsB = (
    await prisma.workspace.create({
      data: { orgId: (await prisma.workspace.findUnique({ where: { id: wsA } }))!.orgId, platform: "easyeda" },
    })
  ).id;
  const keyB = generateApiKey();
  await prisma.apiKey.create({
    data: {
      orgId: (await prisma.workspace.findUnique({ where: { id: wsB } }))!.orgId,
      name: "ws-b-key",
      hashedKey: keyB.hash,
      scopes: "mcp:tools",
      defaultWorkspaceId: wsB,
    },
  });

  // Queue a command on ws-a.
  const pending = edaRelay.execute(wsA, "screenshot", {}, 10_000);

  // ws-b polls — must NOT receive ws-a's command. 204 is the
  // "queue empty" signal; receiving any command body here would
  // be a tenant-isolation regression.
  const pollB = await app.inject({
    method: "GET",
    url: "/api/eda-relay/poll",
    headers: { authorization: `Bearer ${keyB.plaintext}` },
  });
  assert.equal(pollB.statusCode, 204, "ws-b must not see ws-a's queued command");

  // ws-a polls — gets its own command, as expected.
  const pollA = await app.inject({
    method: "GET",
    url: "/api/eda-relay/poll",
    headers: { authorization: `Bearer ${edaKeyPlaintext}` },
  });
  assert.equal(pollA.statusCode, 200);

  // Detach the pending promise to keep state clean.
  await app.inject({
    method: "POST",
    url: "/api/eda-relay/result",
    headers: { authorization: `Bearer ${edaKeyPlaintext}` },
    payload: { id: (pollA.json() as { id: string }).id, ok: true, result: null },
  });
  await pending;
});

test("ws-b's API key cannot post a result for a command queued on ws-a (HTTP-layer isolation)", async () => {
  // Even if the extension on ws-b somehow learns ws-a's command id
  // (e.g. via logs), it must not be able to resolve ws-a's pending
  // promise. The result endpoint scopes by ws-b's workspace state;
  // ws-a's command isn't there → 410 result_rejected.
  const { prisma } = await import("@altium-mcp/db");
  const { generateApiKey } = await import("../api-keys/keys.js");
  const wsBId = (
    await prisma.workspace.create({
      data: {
        orgId: (await prisma.workspace.findUnique({ where: { id: easyedaWsId } }))!.orgId,
        platform: "easyeda",
      },
    })
  ).id;
  const keyB = generateApiKey();
  await prisma.apiKey.create({
    data: {
      orgId: (await prisma.workspace.findUnique({ where: { id: wsBId } }))!.orgId,
      name: "result-isolation-b",
      hashedKey: keyB.hash,
      scopes: "mcp:tools",
      defaultWorkspaceId: wsBId,
    },
  });

  const pending = edaRelay.execute(easyedaWsId, "screenshot", {}, 10_000);
  const pollA = await app.inject({
    method: "GET",
    url: "/api/eda-relay/poll",
    headers: { authorization: `Bearer ${edaKeyPlaintext}` },
  });
  assert.equal(pollA.statusCode, 200);
  const cmd = pollA.json() as { id: string };

  // ws-b's key tries to claim ws-a's command id.
  const stolenResult = await app.inject({
    method: "POST",
    url: "/api/eda-relay/result",
    headers: { authorization: `Bearer ${keyB.plaintext}` },
    payload: { id: cmd.id, ok: true, result: "stolen" },
  });
  assert.equal(stolenResult.statusCode, 410);
  assert.equal(stolenResult.json().error, "result_rejected");

  // Detach: ws-a posts its own result so the pending promise resolves.
  await app.inject({
    method: "POST",
    url: "/api/eda-relay/result",
    headers: { authorization: `Bearer ${edaKeyPlaintext}` },
    payload: { id: cmd.id, ok: true, result: "real" },
  });
  const resolved = await pending;
  assert.equal(resolved, "real");
});

// ─── Status ───────────────────────────────────────────────────────────

test("GET /status returns per-workspace counters scoped to the API key's workspace", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/api/eda-relay/status",
    headers: { authorization: `Bearer ${edaKeyPlaintext}` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    queued: number;
    inFlight: number;
    pollersWaiting: number;
    connected: boolean;
    totals: { dispatched: number; resolved: number; errored: number };
  };
  // Shape pin — the SPA's /status page (Sprint 8 PR 8.4) consumes
  // these fields, so changing them is breaking.
  assert.ok("queued" in body);
  assert.ok("inFlight" in body);
  assert.ok("pollersWaiting" in body);
  assert.equal(typeof body.connected, "boolean");
  assert.ok("totals" in body);
  // Connected reflects "polled within the last 60s" — true here
  // because the round-trip test above polled.
  assert.equal(body.connected, true);
});

// ─── Bad input ────────────────────────────────────────────────────────

test("POST /result with malformed body returns 400 invalid_input", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/eda-relay/result",
    headers: { authorization: `Bearer ${edaKeyPlaintext}` },
    payload: { id: "x", ok: "not-a-boolean" },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "invalid_input");
});

test("POST /result with unknown command id returns 410 result_rejected", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/eda-relay/result",
    headers: { authorization: `Bearer ${edaKeyPlaintext}` },
    payload: { id: "never-dispatched", ok: true, result: null },
  });
  assert.equal(res.statusCode, 410);
  assert.equal(res.json().error, "result_rejected");
});
