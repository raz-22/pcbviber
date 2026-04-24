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
  NewProjectParams,
  SaveProjectParams,
  ListDocumentsParams,
  GetMessagesParams,
  ScreenshotParams,
  TailLogParams,
  SelfTestParams,
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
    "ad_tail_log",
    "Return the last N lines of the AltiumRelay script log (%TEMP%\\AltiumRelay.log). Useful for debugging relay behavior without having to SSH to the machine running AD. Does NOT require AD to be connected.",
    TailLogParams.shape,
    async (args) => toMcpResponse(async () => h.adTailLog(args))
  );

  server.tool(
    "pcbviber_selftest",
    "Run a full diagnostic: server version, relay status, live ad_ping (with latency), active project, and a tail of the AD-side log. Single call — everything you need to know whether PCBviber is healthy end-to-end. Skips AD-side calls gracefully if the relay is disconnected so the report always returns fast.",
    SelfTestParams.shape,
    async (args) => toMcpResponse(async () => h.pcbviberSelftest(relay, args))
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
    "ad_new_project",
    "[EXPERIMENTAL] Create a new empty PCB project at the given path, optionally with a blank schematic document. Parent directories are auto-created. Useful for setting up minimal test projects.",
    NewProjectParams.shape,
    async (args) => toMcpResponse(() => h.adNewProject(relay, args))
  );

  server.tool(
    "ad_save_project",
    "Save the active (or specified) project to disk. Returns the saved path.",
    SaveProjectParams.shape,
    async (args) => toMcpResponse(() => h.adSaveProject(relay, args))
  );

  server.tool(
    "ad_list_documents",
    "List the source documents (schematics, PCB, OutJobs, scripts) of the active (or specified) project, including each document's file path and kind.",
    ListDocumentsParams.shape,
    async (args) => toMcpResponse(() => h.adListDocuments(relay, args))
  );

  server.tool(
    "ad_get_messages",
    "Return the current contents of Altium's Messages panel as structured entries (class, document, source, message, time) with severity counts. Supports filtering by min severity and source. Does NOT re-run any build.",
    GetMessagesParams.shape,
    async (args) => toMcpResponse(() => h.adGetMessages(relay, args))
  );

  server.tool(
    "ad_debug_introspect_messages",
    "[DIAGNOSTIC] Probe the live DM_MessagesManager object for accessor names (count methods, iteration methods, per-message fields). Use when ad_get_messages reports that DM_MessageCount / DM_Messages are unavailable — the report shows which accessors this AD build actually exposes so EnumerateMessages can be patched to match. Read-only.",
    {},
    async () => toMcpResponse(() => h.adDebugIntrospectMessages(relay))
  );

  server.tool(
    "ad_screenshot",
    "Capture a PNG screenshot of Altium Designer's main window (default) or the full virtual desktop. Returns the image inline so it can be viewed. Runs locally via PowerShell; does NOT require the AD relay.",
    ScreenshotParams.shape,
    async (args) => {
      try {
        return await h.adScreenshot(args);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    }
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
