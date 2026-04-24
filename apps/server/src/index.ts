#!/usr/bin/env node

/**
 * Altium MCP Server — entry point.
 *
 * Supports two transports via --transport flag:
 *   --transport=stdio   (default) for Claude Code / Desktop / Cursor
 *   --transport=http    Fastify + MCP HTTP transport for browser UI / remote agents
 *
 * Required env vars: NEXAR_CLIENT_ID, NEXAR_CLIENT_SECRET
 * Optional env vars: ALTIUM_WORKSPACE_URL, ALTIUM_REST_TOKEN,
 *                    HTTP_PORT (default 3000), HTTP_HOST (default 127.0.0.1)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { NexarService } from "./services/nexar.js";
import { registerComponentTools } from "./tools/components.js";
import { registerProjectTools } from "./tools/projects.js";
import { registerManufacturingTools } from "./tools/manufacturing.js";
import { registerAltiumTools } from "./tools/altium.js";
import { startHttpServer } from "./http.js";
import { AdRelay } from "./ad-relay/relay.js";
import type { AltiumConfig } from "@altium-mcp/shared";

function loadConfig(): AltiumConfig {
  const clientId = process.env.NEXAR_CLIENT_ID;
  const clientSecret = process.env.NEXAR_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error(
      [
        "",
        "Altium MCP Server — missing credentials.",
        "",
        "Set these environment variables:",
        "  NEXAR_CLIENT_ID=<your nexar client id>",
        "  NEXAR_CLIENT_SECRET=<your nexar client secret>",
        "",
        "Get credentials at: https://nexar.com/api",
        "",
      ].join("\n")
    );
    process.exit(1);
  }

  return {
    nexarClientId: clientId,
    nexarClientSecret: clientSecret,
    altium365WorkspaceUrl: process.env.ALTIUM_WORKSPACE_URL,
    restApiToken: process.env.ALTIUM_REST_TOKEN,
    nexarAccessToken: process.env.NEXAR_ACCESS_TOKEN,
  };
}

function parseTransport(): "stdio" | "http" {
  const arg = process.argv.find((a) => a.startsWith("--transport="));
  const value = arg ? arg.split("=")[1] : process.env.MCP_TRANSPORT ?? "stdio";
  if (value !== "stdio" && value !== "http") {
    console.error(`Unknown transport: ${value}. Use stdio|http.`);
    process.exit(1);
  }
  return value;
}

export function buildMcpServer(nexar: NexarService, relay: AdRelay): McpServer {
  const server = new McpServer({
    name: "altium-mcp-server",
    version: "0.2.0",
    description:
      "MCP server for Altium 365 and Altium Designer. Tools for component search, project management, BOM analysis, manufacturing output generation, and desktop command & control of Altium Designer via a relay.",
  });
  registerComponentTools(server, nexar);
  registerProjectTools(server, nexar);
  registerManufacturingTools(server, nexar);
  registerAltiumTools(server, relay);
  return server;
}

async function main() {
  const config = loadConfig();
  const nexar = new NexarService(config);
  const relay = new AdRelay();
  const transport = parseTransport();

  if (transport === "stdio") {
    const server = buildMcpServer(nexar, relay);
    const stdio = new StdioServerTransport();
    await server.connect(stdio);
    console.error(
      "Altium MCP server running on stdio. Note: ad_* tools require --transport=http " +
        "so AltiumRelay.js inside AD can poll /ad-relay/next."
    );
    return;
  }

  // transport === "http"
  const host = process.env.HTTP_HOST ?? "127.0.0.1";
  const port = Number(process.env.HTTP_PORT ?? 3000);
  await startHttpServer({ nexar, relay, host, port });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
