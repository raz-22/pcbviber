#!/usr/bin/env node
/**
 * pcbviber — local, single-user entry point.
 *
 * One process, no database, no account:
 *   - MCP over stdio for Claude Code / Claude Desktop / Cursor
 *   - a loopback-only HTTP listener (/ad-relay/*) that AltiumRelay.js,
 *     running inside Altium Designer, polls for commands
 *
 * Nexar credentials are optional. Without them the live Altium tools
 * work and the part-data tools return a clear "not configured" error.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AdResultEnvelope, type AltiumConfig } from "@altium-mcp/shared";
import { NexarService } from "../../server/src/services/nexar.js";
import { registerComponentTools } from "../../server/src/tools/components.js";
import { registerProjectTools } from "../../server/src/tools/projects.js";
import { registerManufacturingTools } from "../../server/src/tools/manufacturing.js";
import { registerAltiumTools } from "../../server/src/tools/altium.js";
import { registerPlatformTools } from "../../server/src/tools/platform.js";
import { registerPcbFlowPrompts } from "../../server/src/prompts/pcb-flow.js";
import { AdRelay } from "../../server/src/ad-relay/relay.js";
import { AltiumPlatform } from "../../server/src/platforms/altium.js";
import type { ToolContext } from "../../server/src/mcp/dispatch.js";

declare const __PCBVIBER_VERSION__: string;
const VERSION = __PCBVIBER_VERSION__;
const MAX_BODY_BYTES = 64 * 1024 * 1024; // screenshots come back as base64

const here = dirname(fileURLToPath(import.meta.url));

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

function printHelp(): void {
  process.stdout.write(
    [
      `pcbviber ${VERSION} — MCP server for Altium Designer`,
      "",
      "Usage:",
      "  pcbviber                  start the MCP server on stdio",
      "  pcbviber --relay-script   print the path of AltiumRelay.js to load in Altium",
      "  pcbviber --version",
      "",
      "Options:",
      "  --relay-port=<n>   loopback port Altium polls (default 3000, env PCBVIBER_RELAY_PORT)",
      "",
      "Optional environment (part search, pricing, Altium 365 data):",
      "  NEXAR_CLIENT_ID, NEXAR_CLIENT_SECRET   from https://nexar.com/api",
      "  ALTIUM_WORKSPACE_URL                   your Altium 365 workspace URL",
      "",
    ].join("\n")
  );
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

/** Same three routes the hosted server mounts, minus Fastify. */
function startRelayListener(relay: AdRelay, port: number): Promise<{ port: number; close: () => void } | null> {
  const server = createServer(async (req, res) => {
    try {
      const path = (req.url ?? "").split("?")[0];
      if (req.method === "GET" && path === "/ad-relay/next") {
        const cmd = await relay.nextCommand(0);
        if (!cmd) {
          res.writeHead(204);
          res.end();
          return;
        }
        sendJson(res, 200, cmd);
        return;
      }
      if (req.method === "POST" && path === "/ad-relay/result") {
        let json: unknown;
        try {
          json = JSON.parse(await readBody(req));
        } catch {
          sendJson(res, 400, { error: "invalid json" });
          return;
        }
        const parsed = AdResultEnvelope.safeParse(json);
        if (!parsed.success) {
          sendJson(res, 400, { error: "invalid result envelope", detail: parsed.error.flatten() });
          return;
        }
        const outcome = relay.postResult(parsed.data);
        if (!outcome.accepted) {
          sendJson(res, 410, { error: "result rejected", detail: outcome.reason });
          return;
        }
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === "GET" && path === "/ad-relay/status") {
        sendJson(res, 200, relay.status());
        return;
      }
      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  return new Promise((resolve) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      console.error(
        err.code === "EADDRINUSE"
          ? `[pcbviber] port ${port} is in use — live Altium tools are disabled. ` +
              `Close the other process or pass --relay-port=<n> (and set the same port in AltiumRelay.js).`
          : `[pcbviber] relay listener failed: ${err.message}`
      );
      resolve(null);
    });
    // Loopback only: this listener has no authentication by design.
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const bound = typeof address === "object" && address ? address.port : port;
      resolve({ port: bound, close: () => server.close() });
    });
  });
}

function buildServer(toolCtx: ToolContext, relay: AdRelay): McpServer {
  const server = new McpServer({ name: "pcbviber", version: VERSION });
  registerComponentTools(server, toolCtx);
  registerProjectTools(server, toolCtx);
  registerManufacturingTools(server, toolCtx);
  registerAltiumTools(server, relay);
  registerPlatformTools(server, toolCtx);
  registerPcbFlowPrompts(server);
  return server;
}

async function main(): Promise<void> {
  if (process.argv.includes("--version") || process.argv.includes("-v")) {
    process.stdout.write(VERSION + "\n");
    return;
  }
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    return;
  }
  if (process.argv.includes("--relay-script")) {
    const p = join(here, "AltiumRelay.js");
    readFileSync(p); // fail loudly if the package is incomplete
    process.stdout.write(p + "\n");
    return;
  }

  const clientId = process.env.NEXAR_CLIENT_ID ?? "";
  const clientSecret = process.env.NEXAR_CLIENT_SECRET ?? "";
  const config: AltiumConfig = {
    nexarClientId: clientId,
    nexarClientSecret: clientSecret,
    altium365WorkspaceUrl: process.env.ALTIUM_WORKSPACE_URL,
    restApiToken: process.env.ALTIUM_REST_TOKEN,
    nexarAccessToken: process.env.NEXAR_ACCESS_TOKEN,
  };
  if (!clientId || !clientSecret) {
    console.error(
      "[pcbviber] NEXAR_CLIENT_ID / NEXAR_CLIENT_SECRET not set — part search, pricing and " +
        "Altium 365 tools will report an auth error. Live Altium tools work without them."
    );
  }

  const nexar = new NexarService(config);
  const relay = new AdRelay();
  const port = Number(arg("relay-port") ?? process.env.PCBVIBER_RELAY_PORT ?? 3000);
  const listener = await startRelayListener(relay, port);
  if (listener) {
    console.error(`[pcbviber] waiting for Altium on http://127.0.0.1:${listener.port}/ad-relay`);
  }

  const platform = new AltiumPlatform({
    relay,
    nexar,
    altiumWorkspaceUrl: config.altium365WorkspaceUrl ?? null,
  });
  const toolCtx: ToolContext = { nexar, metering: null, platform };
  const server = buildServer(toolCtx, relay);
  await server.connect(new StdioServerTransport());
  // The relay listener keeps the event loop alive, so exit explicitly when
  // the MCP client goes away instead of lingering and holding the port.
  const shutdown = () => {
    listener?.close();
    process.exit(0);
  };
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  console.error(`[pcbviber] ${VERSION} running on stdio`);
}

main().catch((err) => {
  console.error("[pcbviber] fatal:", err);
  process.exit(1);
});
