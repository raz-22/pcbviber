/**
 * Handlers that forward MCP tool calls to Altium Designer via the AdRelay.
 *
 * Each handler:
 *   1. Validates params using the Zod schema from @altium-mcp/shared.
 *   2. Calls relay.execute(method, params, timeoutMs).
 *   3. Returns whatever AD posted back, or surfaces the error.
 *
 * The server doesn't care WHAT the AD-side does with each method —
 * that's the contract in ad-script/AltiumRelay.js.
 */

import type { AdRelay } from "../ad-relay/relay.js";
import type {
  OpenProjectParams,
  CompileProjectParams,
  RunDrcParams,
  AnnotateSchematicParams,
  GenerateOutputsParams,
  AutoPlaceParams,
  AutoRouteParams,
} from "@altium-mcp/shared";

function requireConnected(relay: AdRelay): void {
  const s = relay.status();
  if (!s.connected) {
    throw new Error(
      "Altium Designer relay is not connected. Start AD, load ad-script/AltiumRelay.js via " +
        "File → Run Script, and make sure the server is running with --transport=http. " +
        "Check GET http://127.0.0.1:3000/ad-relay/status for diagnostics."
    );
  }
}

export async function adPing(relay: AdRelay): Promise<unknown> {
  // Intentionally does NOT require connected — this tool's job is to *check*.
  return relay.execute("ping", {}, 5_000);
}

export async function adGetActiveProject(relay: AdRelay): Promise<unknown> {
  requireConnected(relay);
  return relay.execute("get_active_project", {}, 10_000);
}

export async function adOpenProject(
  relay: AdRelay,
  params: OpenProjectParams
): Promise<unknown> {
  requireConnected(relay);
  return relay.execute("open_project", params, 30_000);
}

export async function adCompileProject(
  relay: AdRelay,
  params: CompileProjectParams
): Promise<unknown> {
  requireConnected(relay);
  return relay.execute("compile_project", params, 120_000);
}

export async function adRunDrc(
  relay: AdRelay,
  params: RunDrcParams
): Promise<unknown> {
  requireConnected(relay);
  return relay.execute("run_drc", params, 300_000);
}

export async function adAnnotateSchematic(
  relay: AdRelay,
  params: AnnotateSchematicParams
): Promise<unknown> {
  requireConnected(relay);
  return relay.execute("annotate_schematic", params, 60_000);
}

export async function adGenerateOutputs(
  relay: AdRelay,
  params: GenerateOutputsParams
): Promise<unknown> {
  requireConnected(relay);
  return relay.execute("generate_outputs", params, 300_000);
}

export async function adAutoPlace(
  relay: AdRelay,
  params: AutoPlaceParams
): Promise<unknown> {
  requireConnected(relay);
  return relay.execute("auto_place", params, 300_000);
}

export async function adAutoRoute(
  relay: AdRelay,
  params: AutoRouteParams
): Promise<unknown> {
  requireConnected(relay);
  return relay.execute("auto_route", params, 600_000);
}

export function adStatus(relay: AdRelay) {
  return relay.status();
}
