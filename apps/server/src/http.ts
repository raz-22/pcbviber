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
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  SearchPartsInput,
  CheckAvailabilityInput,
  ListLibraryComponentsInput,
  FindAlternativePartsInput,
} from "@altium-mcp/shared";
import type { NexarService } from "./services/nexar.js";
import { buildMcpServer } from "./index.js";
import * as components from "./handlers/components.js";
import * as projects from "./handlers/projects.js";
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
    credentials: false,
  });

  // ── AD relay (HTTP long-poll bridge to Altium Designer) ──
  registerAdRelayRoutes(app, relay);

  // ── MCP over HTTP (stateless) ──────────────────────────
  app.post("/mcp", async (req, reply) => {
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

  // ── REST BFF — Parts Search page ──────────────────────
  app.get("/api/parts/search", async (req, reply) => {
    const parsed = SearchPartsInput.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid query", detail: parsed.error.flatten() };
    }
    try {
      return await components.searchParts(nexar, parsed.data);
    } catch (err) {
      reply.code(502);
      return { error: "upstream error", detail: (err as Error).message };
    }
  });

  app.get("/api/parts/availability", async (req, reply) => {
    const parsed = CheckAvailabilityInput.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid query", detail: parsed.error.flatten() };
    }
    try {
      return await components.checkPartAvailability(nexar, parsed.data);
    } catch (err) {
      reply.code(502);
      return { error: "upstream error", detail: (err as Error).message };
    }
  });

  app.get("/api/library/components", async (req, reply) => {
    const parsed = ListLibraryComponentsInput.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid query", detail: parsed.error.flatten() };
    }
    try {
      return await components.listLibraryComponents(nexar, parsed.data);
    } catch (err) {
      reply.code(502);
      return { error: "upstream error", detail: (err as Error).message };
    }
  });

  app.get("/api/parts/alternatives", async (req, reply) => {
    const parsed = FindAlternativePartsInput.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid query", detail: parsed.error.flatten() };
    }
    try {
      return await components.findAlternativeParts(nexar, parsed.data);
    } catch (err) {
      reply.code(502);
      return { error: "upstream error", detail: (err as Error).message };
    }
  });

  app.get("/api/workspaces", async (_req, reply) => {
    try {
      return await projects.listWorkspaces(nexar);
    } catch (err) {
      reply.code(502);
      return { error: "upstream error", detail: (err as Error).message };
    }
  });

  app.get("/api/workspaces/projects", async (req, reply) => {
    const q = req.query as { workspaceUrl?: string };
    if (!q.workspaceUrl) {
      reply.code(400);
      return { error: "workspaceUrl required" };
    }
    try {
      return await projects.listProjects(nexar, { workspaceUrl: q.workspaceUrl });
    } catch (err) {
      reply.code(502);
      return { error: "upstream error", detail: (err as Error).message };
    }
  });

  app.get("/api/health", async () => ({ ok: true, version: "0.2.0" }));

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
