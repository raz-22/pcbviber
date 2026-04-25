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
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import { selectAuthProvider } from "@altium-mcp/auth";
import { registerAuthRoutes } from "./auth/routes.js";
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
import {
  makeBillingSigner,
  selectBillingProvider,
} from "@altium-mcp/billing";
import { NexarServiceFactory } from "./services/nexar-factory.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { NexarService } from "./services/nexar.js";
import { buildMcpServer } from "./index.js";
import type { AdRelay } from "./ad-relay/relay.js";
import { registerAdRelayRoutes } from "./ad-relay/routes.js";
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

  // ── AD relay (HTTP long-poll bridge to Altium Designer) ──
  registerAdRelayRoutes(app, relay);

  // ── MCP over HTTP (stateless) ──────────────────────────
  // Bearer-token auth gates every /mcp request: the middleware hashes
  // the token, looks up the ApiKey row, rejects revoked/expired, and
  // populates req.apiKeyCtx. Tools currently still use the env-loaded
  // singleton; the per-tenant cutover is a follow-up.
  const requireApiKey = makeRequireApiKey();
  app.post("/mcp", { preHandler: requireApiKey }, async (req, reply) => {
    const server = buildMcpServer(nexar, relay);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    reply.raw.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
  // Reshape the middleware's 401 throws into the SPA-friendly
  // `{ error: "not_authenticated" }` body. Mounted last so all
  // routes are registered before the error handler is replaced.
  installApiKeyErrorHandler(app);

  app.get("/api/health", async () => ({
    ok: true,
    name: "pcbviber",
    version: "0.3.0",
    relay: relay.status().connected ? "connected" : "disconnected",
  }));

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
