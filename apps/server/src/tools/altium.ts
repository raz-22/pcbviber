/**
 * MCP tool surface for Altium Designer desktop commands.
 *
 * All of these tools require:
 *   1. The server running with --transport=http.
 *   2. Altium Designer open with ad-script/AltiumRelay.js running inside it
 *      (File → Run Script… → AltiumRelay.js, then click Start).
 *
 * If AD isn't connected, each tool returns a clear error explaining how to fix it.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  OpenProjectParams,
  CompileProjectParams,
  RunDrcParams,
  AnnotateSchematicParams,
  GenerateOutputsParams,
  AutoPlaceParams,
  AutoRouteParams,
} from "@altium-mcp/shared";
import * as h from "../handlers/altium.js";
import { toMcpResponse } from "../handlers/mcp-response.js";
import type { AdRelay } from "../ad-relay/relay.js";

export function registerAltiumTools(server: McpServer, relay: AdRelay) {
  server.tool(
    "ad_ping",
    "Smoke test: round-trips a ping to Altium Designer via the relay. Returns the AD version string on success. Use this first to verify AltiumRelay.js is running inside AD.",
    {},
    async () => toMcpResponse(() => h.adPing(relay))
  );

  server.tool(
    "ad_status",
    "Relay connection diagnostics. Shows whether Altium Designer is polling, recent command stats, and queue depth. Does NOT require AD to be connected.",
    {},
    async () => toMcpResponse(async () => h.adStatus(relay))
  );

  server.tool(
    "ad_get_active_project",
    "Returns metadata about the project currently open and focused in Altium Designer: path, name, loaded documents, and active document.",
    {},
    async () => toMcpResponse(() => h.adGetActiveProject(relay))
  );

  server.tool(
    "ad_open_project",
    "Open an Altium Designer project (.PrjPcb / .PrjSch) from disk. The project becomes the active one.",
    OpenProjectParams.shape,
    async (args) => toMcpResponse(() => h.adOpenProject(relay, args))
  );

  server.tool(
    "ad_compile_project",
    "Compile the active (or specified) project. This triggers ERC as a side effect — the result includes ERC messages.",
    CompileProjectParams.shape,
    async (args) => toMcpResponse(() => h.adCompileProject(relay, args))
  );

  server.tool(
    "ad_run_drc",
    "Run the Design Rule Check on the active PCB document. Returns the list of violations with rule name, location, and net.",
    RunDrcParams.shape,
    async (args) => toMcpResponse(() => h.adRunDrc(relay, args))
  );

  server.tool(
    "ad_annotate_schematic",
    "Run silent annotation on schematics of the active project, assigning designators in the specified order.",
    AnnotateSchematicParams.shape,
    async (args) => toMcpResponse(() => h.adAnnotateSchematic(relay, args))
  );

  server.tool(
    "ad_generate_outputs",
    "Run an OutJob file to generate manufacturing outputs (Gerber, BOM, PDF, etc.). Returns the list of output files produced.",
    GenerateOutputsParams.shape,
    async (args) => toMcpResponse(() => h.adGenerateOutputs(relay, args))
  );

  server.tool(
    "ad_auto_place",
    "Run Altium's auto-placement algorithm on unplaced components on the active PCB. 'cluster' groups by connectivity, 'statistical' uses thermal/electrical heuristics.",
    AutoPlaceParams.shape,
    async (args) => toMcpResponse(() => h.adAutoPlace(relay, args))
  );

  server.tool(
    "ad_auto_route",
    "Run Altium's Situs auto-router. Scope 'all' routes the entire board, 'selected' routes the current selection, 'net' routes a single named net.",
    AutoRouteParams.shape,
    async (args) => toMcpResponse(() => h.adAutoRoute(relay, args))
  );
}
