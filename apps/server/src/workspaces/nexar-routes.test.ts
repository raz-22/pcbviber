/**
 * Tenant-scoped Nexar route tests — Sprint 2 PR 2.3.
 *
 * Pins the cutover from the env-loaded NexarService singleton to
 * per-workspace `factory.forWorkspace(...)`. Critical invariants:
 *
 *   - The workspace ID in the URL is verified to belong to the org
 *     in the URL (cross-tenant → 404)
 *   - factory.forWorkspace IS called with the right workspace id —
 *     this is the proof that Alice's request uses Alice's creds, not
 *     a globally-shared singleton
 *   - Workspaces with no creds → 503 (not 500); SPA can render a
 *     "configure this workspace" CTA
 *
 * The factory's `forWorkspace` is stubbed so we never touch real
 * Nexar; the stub returns a NexarService whose methods are also
 * stubbed to return canned data. This test stays purely in-process.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";

let app: FastifyInstance;
let workdir: string;
let aliceCookie: string;
let bobCookie: string;
let aliceOrgId: string;
let bobOrgId: string;
let aliceWsConfiguredId: string;  // alice has a workspace with creds
let aliceWsBareId: string;        // ...and one without
let bobWsId: string;              // bob has his own workspace

let stubFactory: import("../services/nexar-factory.js").NexarServiceFactory;
/** The most recent forWorkspace target — verified per-test. */
let lastForWorkspaceId: string | null = null;

const STRONG = "correct-horse-battery-staple-4";

before(async () => {
  workdir = mkdtempSync(join(tmpdir(), "altium-mcp-nexar-routes-"));
  const dbPath = join(workdir, "test.db").replace(/\\/g, "/");
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.WORKOS_COOKIE_PASSWORD = randomBytes(48).toString("base64");
  delete process.env.WORKOS_API_KEY;
  delete process.env.WORKOS_CLIENT_ID;

  const dbPkg = join(process.cwd(), "..", "..", "packages", "db");
  const schemaPath = join(dbPkg, "prisma", "schema.prisma");
  const prismaBin =
    process.platform === "win32"
      ? join(dbPkg, "node_modules", ".bin", "prisma.CMD")
      : join(dbPkg, "node_modules", ".bin", "prisma");
  execFileSync(prismaBin, ["migrate", "deploy", "--schema", schemaPath], {
    shell: true,
    stdio: "ignore",
    env: process.env,
    cwd: dbPkg,
  });

  const { __resetSessionCacheForTests, __resetAuthProviderCacheForTests } =
    await import("@altium-mcp/auth");
  __resetSessionCacheForTests();
  __resetAuthProviderCacheForTests();

  const { selectAuthProvider } = await import("@altium-mcp/auth");
  const { registerAuthRoutes } = await import("../auth/routes.js");
  const { registerWorkspaceRoutes } = await import("./routes.js");
  const { registerNexarRoutes } = await import("./nexar-routes.js");
  const { NexarServiceFactory } = await import("../services/nexar-factory.js");

  app = Fastify({ logger: false });
  await app.register(cookie);
  const auth = selectAuthProvider();
  await registerAuthRoutes(app, auth);

  // Stub the factory so we never reach Nexar.
  stubFactory = new NexarServiceFactory();
  stubFactory.testCredentials = async () => ({ ok: true });
  stubFactory.forWorkspace = async (workspaceId: string) => {
    lastForWorkspaceId = workspaceId;
    // Tests check what was loaded; the returned NexarService is a
    // duck-typed stub whose methods return canned shapes the handlers
    // expect.
    return {
      searchParts: async () => [
        { mpn: "STM32F407VGT6", manufacturer: "ST", description: "MCU",
          category: "MCU", lifecycle: "Active", offers: [] },
      ],
      listWorkspaces: async () => [
        { id: "ws_a365", name: "Acme", url: "https://acme.altium365.com" },
      ],
      listProjects: async () => [
        { id: "proj_1", name: "Power Monitor", workspaceUrl: "...",
          createdAt: "", updatedAt: "" },
      ],
      listComponents: async () => [],
    } as unknown as Awaited<ReturnType<typeof stubFactory.forWorkspace>>;
  };

  await registerWorkspaceRoutes(app, auth, { nexarFactory: stubFactory });
  await registerNexarRoutes(app, auth, { nexarFactory: stubFactory });
  await app.ready();

  // Two orgs.
  const aliceSignup = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email: "alice@nexar-routes.example", password: STRONG },
  });
  aliceOrgId = aliceSignup.json().org.id;
  aliceCookie = extractCookie(aliceSignup.headers["set-cookie"])!;

  const bobSignup = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email: "bob@nexar-routes.example", password: STRONG },
  });
  bobOrgId = bobSignup.json().org.id;
  bobCookie = extractCookie(bobSignup.headers["set-cookie"])!;

  // Alice creates two workspaces: one configured, one bare (no creds).
  const aWsConfigured = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/workspaces`,
    headers: { cookie: aliceCookie },
    payload: {
      altiumWorkspaceUrl: "https://alice.altium365.com",
      nexarClientId: "alice-id",
      nexarClientSecret: "alice-secret",
    },
  });
  aliceWsConfiguredId = aWsConfigured.json().workspace.id;

  // Bare workspace — created via direct DB insert because the route
  // requires creds. Sprint 4 will allow workspace creation without
  // creds for the trial flow; until then, the DB does the right thing.
  const { prisma } = await import("@altium-mcp/db");
  const bare = await prisma.workspace.create({
    data: {
      orgId: aliceOrgId,
      altiumWorkspaceUrl: "https://bare.altium365.com",
    },
  });
  aliceWsBareId = bare.id;

  // Bob's workspace — used for cross-tenant probes.
  const bWs = await app.inject({
    method: "POST",
    url: `/api/orgs/${bobOrgId}/workspaces`,
    headers: { cookie: bobCookie },
    payload: {
      altiumWorkspaceUrl: "https://bob.altium365.com",
      nexarClientId: "bob-id",
      nexarClientSecret: "bob-secret",
    },
  });
  bobWsId = bWs.json().workspace.id;
});

after(async () => {
  if (app) await app.close();
  const { prisma } = await import("@altium-mcp/db");
  await prisma.$disconnect();
  try {
    rmSync(workdir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// ─── Happy path: parts/search ────────────────────────────────────────

test("GET .../parts/search loads NexarService for the URL's workspaceId and returns results", async () => {
  lastForWorkspaceId = null;
  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/workspaces/${aliceWsConfiguredId}/parts/search?query=STM32F407&limit=5`,
    headers: { cookie: aliceCookie },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as Array<{ mpn: string }>;
  assert.equal(body[0].mpn, "STM32F407VGT6");
  assert.equal(
    lastForWorkspaceId,
    aliceWsConfiguredId,
    "factory.forWorkspace must be called with the URL's workspaceId"
  );
});

test("GET .../parts/search with bad query returns 400 (Zod)", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/workspaces/${aliceWsConfiguredId}/parts/search?limit=notanumber`,
    headers: { cookie: aliceCookie },
  });
  // limit=notanumber → coerce.number fails → invalid_input
  assert.equal(res.statusCode, 400);
});

// ─── Cross-tenant defense ───────────────────────────────────────────

test("Alice trying to use Bob's workspace ID through her own orgId returns 404", async () => {
  // alice's orgId, bob's workspaceId — middleware sees workspace.orgId
  // != ctx.org.id → 404 (not 403, no enumeration leak).
  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/workspaces/${bobWsId}/parts/search?query=STM32`,
    headers: { cookie: aliceCookie },
  });
  assert.equal(res.statusCode, 404);
});

test("Alice trying to use Bob's workspace ID through Bob's orgId returns 403", async () => {
  // alice's session, bob's orgId — requireOrgMember rejects at the
  // tenant scope (Alice isn't a member of Bob's org).
  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${bobOrgId}/workspaces/${bobWsId}/parts/search?query=STM32`,
    headers: { cookie: aliceCookie },
  });
  assert.equal(res.statusCode, 403);
});

test("a non-existent workspaceId under a real orgId returns 404", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/workspaces/cknotreal000000000000000xx/parts/search?query=STM32`,
    headers: { cookie: aliceCookie },
  });
  assert.equal(res.statusCode, 404);
});

// ─── Missing-creds workspace → 503 ──────────────────────────────────

test("a workspace with no Nexar creds returns 503 with workspace_not_configured", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/workspaces/${aliceWsBareId}/parts/search?query=STM32`,
    headers: { cookie: aliceCookie },
  });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error, "workspace_not_configured");
});

// ─── Factory failure surfaces as 503 (not 500) ──────────────────────

test("factory.forWorkspace throwing surfaces as 503 workspace_unavailable, not 500", async () => {
  // Temporarily make the factory throw.
  const orig = stubFactory.forWorkspace;
  stubFactory.forWorkspace = async () => {
    throw new Error("decryption blew up");
  };
  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/workspaces/${aliceWsConfiguredId}/parts/search?query=x`,
    headers: { cookie: aliceCookie },
  });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error, "workspace_unavailable");
  stubFactory.forWorkspace = orig;
});

// ─── library + altium-365 endpoints ─────────────────────────────────

test("GET .../library/components uses the workspace's stored Altium URL by default", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/workspaces/${aliceWsConfiguredId}/library/components`,
    headers: { cookie: aliceCookie },
  });
  assert.equal(res.statusCode, 200);
  // We don't observe the URL passed to listComponents directly, but
  // the call shouldn't 400 because the workspace HAS an altiumWorkspaceUrl.
});

test("GET .../library/components on a workspace WITHOUT a stored URL returns 400 unless overridden", async () => {
  // Create a workspace with creds but no altiumWorkspaceUrl.
  const noUrl = await app.inject({
    method: "POST",
    url: `/api/orgs/${aliceOrgId}/workspaces`,
    headers: { cookie: aliceCookie },
    payload: { nexarClientId: "no-url", nexarClientSecret: "no-url" },
  });
  const wsId = noUrl.json().workspace.id;

  const without = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/workspaces/${wsId}/library/components`,
    headers: { cookie: aliceCookie },
  });
  assert.equal(without.statusCode, 400);
  assert.equal(without.json().error, "missing_altium_workspace_url");

  const withOverride = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/workspaces/${wsId}/library/components?altiumWorkspaceUrl=https%3A%2F%2Fexplicit.altium365.com`,
    headers: { cookie: aliceCookie },
  });
  assert.equal(withOverride.statusCode, 200);
});

test("GET .../altium-365/workspaces returns the desWorkspaces list shape", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/workspaces/${aliceWsConfiguredId}/altium-365/workspaces`,
    headers: { cookie: aliceCookie },
  });
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.json().workspaces));
});

test("GET .../altium-365/projects falls back to the stored Altium URL", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/workspaces/${aliceWsConfiguredId}/altium-365/projects`,
    headers: { cookie: aliceCookie },
  });
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.json().projects));
});

// ─── auth gating ────────────────────────────────────────────────────

test("anonymous request to a workspace-scoped Nexar route returns 401", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/workspaces/${aliceWsConfiguredId}/parts/search?query=x`,
  });
  assert.equal(res.statusCode, 401);
});

// ─── Per-workspace isolation ────────────────────────────────────────

test("two requests to different workspaces load different NexarService instances", async () => {
  // Both calls hit the stub; lastForWorkspaceId is the proof. The real
  // factory's caching is exercised in nexar-factory.test.ts; this test
  // verifies the route layer correctly threads the workspaceId.
  await app.inject({
    method: "GET",
    url: `/api/orgs/${aliceOrgId}/workspaces/${aliceWsConfiguredId}/parts/search?query=a`,
    headers: { cookie: aliceCookie },
  });
  assert.equal(lastForWorkspaceId, aliceWsConfiguredId);

  await app.inject({
    method: "GET",
    url: `/api/orgs/${bobOrgId}/workspaces/${bobWsId}/parts/search?query=b`,
    headers: { cookie: bobCookie },
  });
  assert.equal(lastForWorkspaceId, bobWsId);
});

// ─── helper ──────────────────────────────────────────────────────────

function extractCookie(setCookie: string | string[] | undefined): string | null {
  if (!setCookie) return null;
  const all = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const sc of all) {
    const m = /^session=([^;]*)/i.exec(sc);
    if (m && m[1] && m[1].length > 0) return `session=${m[1]}`;
  }
  return null;
}
