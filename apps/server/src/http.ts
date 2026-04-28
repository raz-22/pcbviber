/**
 * HTTP transport: hosts both
 *   POST /mcp  — MCP StreamableHTTPServerTransport
 *   GET  /api/* — REST BFF for the browser UI
 *
 * /api handlers call the same functions as the MCP tools (src/handlers/*),
 * so there's a single source of truth for business logic.
 *
 * If StreamableHTTPServerTransport is missing from the SDK you have installed,
 * bump @modelcontextprotocol/sdk to the latest minor version.
 */

import Fastify, { type FastifyInstance } from "fastify";
import * as Sentry from "@sentry/node";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import csrfProtection from "@fastify/csrf-protection";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { selectAuthProvider } from "@altium-mcp/auth";
import { prisma } from "@altium-mcp/db";
import { registerAuthRoutes } from "./auth/routes.js";
import { registerSsoRoutes } from "./auth/sso-routes.js";
import { registerOrgRoutes } from "./auth/org-routes.js";
import { registerWorkspaceRoutes } from "./workspaces/routes.js";
import { registerNexarRoutes } from "./workspaces/nexar-routes.js";
import { registerMemberRoutes } from "./members/routes.js";
import { registerApiKeyRoutes } from "./api-keys/routes.js";
import {
  installApiKeyErrorHandler,
  makeRequireApiKey,
} from "./api-keys/middleware.js";
import { registerBillingRoutes } from "./billing/routes.js";
import { registerBillingWebhookRoute } from "./billing/webhook.js";
import { registerUsageRoutes } from "./usage/routes.js";
import { registerAuditRoutes } from "./audit/routes.js";
import { registerIpAllowlistRoutes } from "./security/ip-allowlist-routes.js";
import {
  makeBillingSigner,
  selectBillingProvider,
} from "@altium-mcp/billing";
import {
  getRedisClient,
  selectQuotaStore,
  writeUsageEvent,
} from "@altium-mcp/metering";
import {
  MCP_RATE_LIMIT,
  installRateLimitErrorHandler,
  rateLimitErrorBuilder,
} from "./security/rate-limits.js";
import { helmetOptionsFor } from "./security/headers.js";
import {
  getCsrfTokenFromHeader,
  installCsrfErrorHandler,
} from "./security/csrf.js";
import { startWorker } from "./jobs/worker.js";
import { NexarServiceFactory } from "./services/nexar-factory.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { NexarService } from "./services/nexar.js";
import { buildMcpServer } from "./index.js";
import type { ToolContext } from "./mcp/dispatch.js";
import { buildApiKeyMeterContext } from "./metering/context.js";
import type { AdRelay } from "./ad-relay/relay.js";
import { registerAdRelayRoutes } from "./ad-relay/routes.js";
import { EdaRelay } from "./eda-relay/relay.js";
import { registerEdaRelayRoutes } from "./eda-relay/routes.js";
import { registerEdaScriptRoutes } from "./eda-script-routes/routes.js";
import { AltiumPlatform } from "./platforms/altium.js";
import { EasyedaPlatform } from "./platforms/easyeda.js";
import * as altium from "./handlers/altium.js";

export async function startHttpServer(opts: {
  nexar: NexarService;
  relay: AdRelay;
  host: string;
  port: number;
}): Promise<FastifyInstance> {
  const { nexar, relay, host, port } = opts;
  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      const allowed = [
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "http://127.0.0.1:3000",
        "http://localhost:3000",
      ];
      cb(null, allowed.includes(origin));
    },
    // Browser sends the session cookie on cross-origin requests during
    // dev (Vite on :5173 → Fastify on :3000). Enable credentials so the
    // SPA can authenticate.
    credentials: true,
  });

  await app.register(cookie);

  // ── Sentry per-request tenant attribution ───────────────
  // We don't add an app-level preHandler here: Fastify runs
  // app-level `addHook("preHandler", ...)` hooks BEFORE
  // route-level preHandler arrays, so req.ctx / req.apiKeyCtx
  // would always be undefined at that stage. The auth/tenant
  // middleware (auth/tenant.ts) and api-key middleware
  // (api-keys/middleware.ts) call `tagRequestUser` /
  // `tagRequestApiKey` themselves, immediately after they
  // populate the context. Sentry's async-context tracking
  // attaches those tags to the current request's scope, so
  // any error captured later (via setupFastifyErrorHandler
  // below) carries the right tenant attribution.

  // ── Security headers ────────────────────────────────────
  // CSP / HSTS (prod only) / X-Frame-Options / X-Content-Type-Options /
  // Referrer-Policy. Dev relaxes connect-src to allow Vite HMR.
  await app.register(helmet, helmetOptionsFor(process.env));

  // ── CSRF protection ─────────────────────────────────────
  // Per-route opt-in via the route's preHandler (`app.csrfProtection`).
  // The plugin sets a signed cookie + exposes `reply.generateCsrf()`
  // for the bootstrap endpoint below. The SPA's fetch wrapper sends
  // `x-csrf-token: <token>` on every state-change request; mismatch
  // → 403 csrf_invalid.
  //
  // Routes that DON'T use the preHandler:
  //   - /mcp (Bearer-token auth, not cookies)
  //   - /api/billing/webhook (Stripe HMAC, not session)
  //   - /api/auth/{signup,login} (no session yet to bind to)
  //   - GET /api/csrf (the bootstrap)
  //   - All GETs (read-only, not state-changing)
  // The full rationale for each skip lives at the top of csrf.ts.
  await app.register(csrfProtection, {
    sessionPlugin: "@fastify/cookie",
    cookieKey: "_csrf",
    cookieOpts: {
      // httpOnly: the SPA reads the token from the response body
      // of GET /api/csrf, never the cookie itself, so we keep the
      // cookie unreachable from JS (defense against XSS-stealing
      // the CSRF cookie).
      httpOnly: true,
      // sameSite: "lax" — sent on top-level navigations + same-
      // site requests. With our credentials:include CORS for the
      // dev-mode cross-origin SPA, "strict" would block all
      // SPA→API requests; "lax" plus the explicit origin
      // allow-list in CORS gives the right balance.
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
    },
    getToken: getCsrfTokenFromHeader,
  });
  installCsrfErrorHandler(app);

  // GET /api/csrf — token bootstrap. SPA calls this on first
  // state-change attempt (or proactively on app load). The plugin
  // sets the cookie and we return the token so the SPA can echo
  // it back as the x-csrf-token header.
  app.get("/api/csrf", async (_req, reply) => {
    const csrfToken = reply.generateCsrf();
    return { csrfToken };
  });

  // ── Rate limiting ───────────────────────────────────────
  // Per-route opt-in via `config.rateLimit` on each protected route.
  // Storage: ioredis when REDIS_URL is set (state shared across
  // replicas — without this, an attacker could N× their effective
  // rate by hitting different replicas). In-memory fallback for
  // dev / tests is the plugin's default.
  //
  // selectQuotaStore() is called before getRedisClient() so the
  // metering layer's lazy-construction path runs first; both share
  // the same ioredis instance via the metering factory's cache.
  selectQuotaStore();
  const rateLimitRedis = getRedisClient();
  await app.register(rateLimit, {
    // Global off so routes opt in via `config.rateLimit`. Saves us
    // from accidentally rate-limiting /api/health or anything else
    // that shouldn't be capped.
    global: false,
    redis: rateLimitRedis ?? undefined,
    // The plugin throws what this builder returns; we attach a
    // marker so the error handler below can reshape into our
    // `{ error: "rate_limited", detail: { … } }` body. Without the
    // handler reshape, Fastify's default error serializer would
    // emit `{statusCode, error, message}` (Fastify's standard
    // error shape) — close, but inconsistent with the rest of
    // the API.
    errorResponseBuilder: rateLimitErrorBuilder,
  });
  // Mount BEFORE installApiKeyErrorHandler so the api-key handler
  // stays the outermost wrapper for unhandled errors.
  installRateLimitErrorHandler(app);

  // ── Auth (signup / login / logout / me) ─────────────────
  // Lazy-construct the provider here so the same env-gated factory the
  // CLI uses is what the server runs against. `selectAuthProvider` is
  // env-gated: WorkOS in prod, LocalAuthProvider in dev.
  const authProvider = selectAuthProvider();
  // Single factory shared across the process — lifts the per-workspace
  // NexarService cache so repeat tool calls don't re-decrypt creds.
  // PR 2.3 will cut Nexar-using tool handlers over to this factory.
  const nexarFactory = new NexarServiceFactory();
  await registerAuthRoutes(app, authProvider);
  // SAML / OIDC via WorkOS. The routes themselves are always
  // mounted; if the active provider doesn't expose startSso /
  // completeSsoCallback (e.g. LocalAuthProvider), the routes
  // 503 with `sso_not_configured`.
  await registerSsoRoutes(app, authProvider);
  await registerOrgRoutes(app, authProvider);
  await registerWorkspaceRoutes(app, authProvider, { nexarFactory });
  // Tenant-scoped Nexar routes (Sprint 2 PR 2.3): every Parts /
  // Library / Altium-365 query goes through factory.forWorkspace(...)
  // and is gated by org-membership + workspace-belongs-to-org.
  await registerNexarRoutes(app, authProvider, { nexarFactory });
  // Members + invitations (Sprint 3 PR 3.1).
  await registerMemberRoutes(app, authProvider);
  // API keys CRUD (Sprint 3 PR 3.3). The MCP transport's bearer-token
  // verification lives in a separate route; the keys themselves are
  // managed here.
  await registerApiKeyRoutes(app, authProvider);

  // Billing — Stripe-backed when STRIPE_SECRET_KEY is set; Noop in
  // dev otherwise. The signer derives its secret from the existing
  // CREDENTIAL_ENCRYPTION_KEY (already-required env). Routes signal
  // 503 billing_not_configured when the provider is the no-op.
  const billing = selectBillingProvider();
  const billingSigner = makeBillingSigner(
    Buffer.from(process.env.CREDENTIAL_ENCRYPTION_KEY ?? "", "base64")
  );
  const appBaseUrl = process.env.APP_BASE_URL ?? "http://localhost:5173";
  await registerBillingRoutes(app, authProvider, {
    billing,
    signer: billingSigner,
    appBaseUrl,
  });
  // Webhook route — UNTENANTED (signed by Stripe, not by user). Lives
  // in a child Fastify scope so its raw-body content-type parser
  // doesn't affect any other application/json route.
  await registerBillingWebhookRoute(app, {
    billing,
    signer: billingSigner,
  });
  // Usage dashboard read-only endpoint — drives Settings → Usage.
  await registerUsageRoutes(app, authProvider);

  // Audit log read-only endpoint — drives Settings → Audit. Admin-
  // only inside the route file (matches Members/Billing visibility).
  await registerAuditRoutes(app, authProvider);

  // Per-org IP allowlist — drives Settings → Organization. Admin-
  // only. The middleware that ENFORCES the allowlist lives inline
  // in tenant.ts + api-keys/middleware.ts; these routes only handle
  // read + update of the configuration.
  await registerIpAllowlistRoutes(app, authProvider);

  // Metering background worker — boots only when REDIS_URL is set
  // (BullMQ requires Redis). In dev without Redis the meter wrapper
  // still works against the InMemoryQuotaStore; jobs just don't run,
  // and pending UsageEvent rows wait until a Redis-backed env runs
  // them via `pnpm -F @altium-mcp/server run-job meter-push`.
  if (process.env.REDIS_URL?.trim()) {
    const meteringWorker = await startWorker({
      prisma,
      billing,
      store: selectQuotaStore(),
      connection: { url: process.env.REDIS_URL.trim() },
      log: app.log as unknown as Pick<Console, "info" | "warn" | "error">,
    });
    // SIGTERM / SIGINT: drain in-flight jobs before exit. Fly sends
    // SIGTERM with a 30s grace period; BullMQ's worker.close() resolves
    // once the current job returns, so we get clean shutdown without
    // dropping a meter-push mid-batch.
    const shutdown = async (signal: string) => {
      app.log.info(`metering worker: caught ${signal}, draining jobs`);
      try {
        await meteringWorker.close();
      } catch (err) {
        app.log.error({ err }, "metering worker close failed");
      }
    };
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
    process.once("SIGINT", () => void shutdown("SIGINT"));
  }

  // ── AD relay (HTTP long-poll bridge to Altium Designer) ──
  registerAdRelayRoutes(app, relay);

  // ── EasyEDA relay (HTTP long-poll bridge to the in-editor extension) ──
  // Per-workspace state, mirroring AdRelay's pattern but multi-tenant.
  // The extension package that consumes these routes lands in PR 9.4c;
  // Sprint 10+ tools call `edaRelay.execute(workspaceId, ...)` from
  // EasyedaPlatform once the extension can post results back.
  const edaRelay = new EdaRelay();
  registerEdaRelayRoutes(app, edaRelay);

  // ── eda-script package serve ───────────────────────────────────
  // Serves the packaged EasyEDA Pro extension as a `.eext` archive
  // at /eda-script/pcbviber-easyeda.eext. Public route — the .eext
  // contains no secrets; the API key is entered by the user inside
  // EasyEDA at first run.
  registerEdaScriptRoutes(app);

  // ── MCP over HTTP (stateless) ──────────────────────────
  // Bearer-token auth gates every /mcp request: the middleware hashes
  // the token, looks up the ApiKey row, rejects revoked/expired, and
  // populates req.apiKeyCtx. Each request resolves the API key's
  // default workspace, loads a per-tenant NexarService via the
  // factory, builds a metering context, and constructs a fresh MCP
  // server bound to that ToolContext. Metered tool calls go through
  // meter() in the dispatch layer; non-metered tools (ad_*) work as
  // before.
  const requireApiKey = makeRequireApiKey();
  const meteringStore = selectQuotaStore();
  app.post(
    "/mcp",
    {
      preHandler: requireApiKey,
      config: { rateLimit: MCP_RATE_LIMIT },
    },
    async (req, reply) => {
    const apiKeyCtx = req.apiKeyCtx;
    if (!apiKeyCtx) {
      // Programmer error: middleware should have populated this.
      reply.code(500);
      return reply.send({ error: "internal_error" });
    }
    const apiKey = await prisma.apiKey.findUnique({
      where: { id: apiKeyCtx.apiKey.id },
      select: { defaultWorkspaceId: true },
    });
    if (!apiKey?.defaultWorkspaceId) {
      // Stable error code so the MCP client can surface a precise
      // operator-facing message ("set a default workspace on your
      // API key in Settings → API Keys"). Returns 400, not 401 —
      // the key authenticated fine; it just isn't usable yet.
      reply.code(400);
      return reply.send({ error: "api_key_no_workspace" });
    }
    // Workspace platform decides which Platform impl gets handed to
    // the per-request ToolContext. The `platform` field is the
    // single source of truth for cross-platform tool dispatch
    // (Sprint 9 PR 9.2 added the column; Sprint 10 PR 10.1b — this
    // PR — wires it into MCP dispatch).
    const workspaceRow = await prisma.workspace.findUnique({
      where: { id: apiKey.defaultWorkspaceId },
      select: { id: true, platform: true, altiumWorkspaceUrl: true },
    });
    if (!workspaceRow) {
      reply.code(400);
      return reply.send({ error: "api_key_no_workspace" });
    }
    let perRequestNexar: NexarService;
    try {
      perRequestNexar = await nexarFactory.forWorkspace(
        apiKey.defaultWorkspaceId,
        apiKeyCtx.org.id
      );
    } catch (err) {
      // Workspace exists but credentials missing / unloadable. Same
      // 503 the REST routes return.
      reply.code(503);
      return reply.send({
        error: "workspace_unavailable",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    const meterCtx = await buildApiKeyMeterContext(req);
    const platform =
      workspaceRow.platform === "easyeda"
        ? new EasyedaPlatform({
            relay: edaRelay,
            workspaceId: workspaceRow.id,
            // EasyEDA can call Nexar for LCSC/MPN enrichment in
            // listLibraryComponents. Per-request handle, same one
            // the metered tools use — when missing, enrichment
            // silently skips.
            nexar: perRequestNexar,
          })
        : new AltiumPlatform({
            relay,
            nexar: perRequestNexar,
            altiumWorkspaceUrl: workspaceRow.altiumWorkspaceUrl,
          });
    const toolCtx: ToolContext = {
      nexar: perRequestNexar,
      metering: {
        meterCtx,
        store: meteringStore,
        recordUsage: writeUsageEvent,
      },
      platform,
    };
    const server = buildMcpServer(toolCtx, relay);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    reply.raw.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
    }
  );
  // Reshape the middleware's 401 throws into the SPA-friendly
  // `{ error: "not_authenticated" }` body. Mounted last so all
  // routes are registered before the error handler is replaced.
  installApiKeyErrorHandler(app);

  // Sentry's Fastify error handler: captures any error that
  // bubbles out of a route handler. Mounted AFTER our own
  // error handlers so they get first crack at reshaping known
  // error codes (csrf_invalid, rate_limited, not_authenticated,
  // quota_exceeded). Whatever lands here is by definition an
  // "unexpected" error — exactly what Sentry should see.
  // No-op when SENTRY_DSN is unset.
  Sentry.setupFastifyErrorHandler(app);

  // Probe the database with a trivial round-trip. Bounded by a 5s
  // timeout: warm queries land in <300ms, but Neon cold-start (TLS
  // + AWS round-trip) can stretch to ~2s on the first call, so
  // anything below ~3s would falsely flag DB as down for 30s after
  // a process restart while the SPA's poll loop still showed red.
  // 5s is generous enough for cold-start while still surfacing a
  // wedged DB faster than a real query timeout would.
  async function probeDb(): Promise<{ ok: boolean; detail?: string }> {
    const start = Date.now();
    try {
      await Promise.race([
        prisma.$queryRaw`SELECT 1`,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 5000)
        ),
      ]);
      return { ok: true, detail: `${Date.now() - start}ms` };
    } catch (err) {
      // /api/health is unauthenticated. Raw Prisma errors can include
      // the DB hostname, the DB name, or auth specifics
      // ("Can't reach database server at host:5432") — none of which
      // belong on the wire to anonymous probers. Map to a stable
      // short code and log the full error server-side.
      app.log.error({ err }, "/api/health: probeDb failed");
      const code =
        err instanceof Error && err.message === "timeout"
          ? "timeout"
          : "unreachable";
      return { ok: false, detail: code };
    }
  }

  // /api/health is the public probe. Used by:
  //   - the SPA's /status page (polls every 30s for green/red dots)
  //   - external uptime monitors (Better Uptime / Pingdom, when wired)
  //   - readiness probes if/when this gets containerized in k8s
  // The shape is intentionally narrow + stable: ok (overall), then a
  // dependency map. Each dependency is { ok, detail? } so the SPA
  // can render a green/red dot without parsing free-form text.
  // Errors are caught per-dependency so one slow check doesn't tank
  // the whole probe — the response always returns within ~db-timeout.
  const healthStartedAt = Date.now();
  app.get("/api/health", async () => {
    const dbCheck = await probeDb();
    const relayConnected = relay.status().connected;
    return {
      ok: dbCheck.ok,
      name: "pcbviber",
      version: "0.3.0",
      uptimeSeconds: Math.floor((Date.now() - healthStartedAt) / 1000),
      checkedAt: new Date().toISOString(),
      dependencies: {
        database: dbCheck,
        // Relay is informational, not a service-up indicator: AD is
        // a per-user local connection. ok=true here means "the relay
        // bridge is configured", not "every customer has AD running".
        relay: { ok: true, detail: relayConnected ? "connected" : "no client" },
      },
    };
  });

  // ── REST wrappers for AD tools (no MCP protocol required) ────────
  // These call the same handlers the MCP tools use. Useful for curl,
  // PowerShell, the web UI, or any plain-HTTP consumer.
  // Bodyless AD commands use GET for curl-friendliness. They still
  // round-trip to AD via the relay — GET here means "no parameters",
  // not "read-only".
  app.get("/api/ad/ping", async (_req, reply) => {
    try {
      return await altium.adPing(relay);
    } catch (err) {
      reply.code(502);
      return { error: (err as Error).message };
    }
  });

  app.get("/api/ad/status", async () => altium.adStatus(relay));

  app.get("/api/ad/active-project", async (_req, reply) => {
    try {
      return await altium.adGetActiveProject(relay);
    } catch (err) {
      reply.code(502);
      return { error: (err as Error).message };
    }
  });

  app.get("/api/ad/compile", async (_req, reply) => {
    try {
      return await altium.adCompileProject(relay, {});
    } catch (err) {
      reply.code(502);
      return { error: (err as Error).message };
    }
  });

  app.post("/api/ad/open", async (req, reply) => {
    const body = req.body as { path?: string };
    if (!body?.path) {
      reply.code(400);
      return { error: "path required" };
    }
    try {
      return await altium.adOpenProject(relay, { path: body.path });
    } catch (err) {
      reply.code(502);
      return { error: (err as Error).message };
    }
  });

  app.post("/api/ad/new-project", async (req, reply) => {
    const body = req.body as { projectPath?: string; addSchematic?: boolean };
    if (!body?.projectPath) {
      reply.code(400);
      return { error: "projectPath required" };
    }
    try {
      return await altium.adNewProject(relay, {
        projectPath: body.projectPath,
        addSchematic: body.addSchematic !== false,
      });
    } catch (err) {
      reply.code(502);
      return { error: (err as Error).message };
    }
  });

  await app.listen({ host, port });
  app.log.info(`Altium MCP HTTP + REST BFF listening on http://${host}:${port}`);
  return app;
}
