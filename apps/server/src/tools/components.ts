/**
 * MCP tool shells for the component/supply-chain surface.
 * Real logic lives in src/handlers/components.ts and is shared with the REST BFF.
 *
 * Tool calls go through `dispatchTool(name, ctx, handler)` so the
 * metered ones (search_parts, check_part_availability,
 * find_alternative_parts) get gated by quota + write a UsageEvent
 * on success. Non-metered tools (list_library_components) skip
 * the meter wrapper at the dispatch layer.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  SearchPartsInput,
  CheckAvailabilityInput,
  ListLibraryComponentsInput,
  FindAlternativePartsInput,
} from "@altium-mcp/shared";
import * as h from "../handlers/components.js";
import { dispatchTool, type ToolContext } from "../mcp/dispatch.js";

export function registerComponentTools(server: McpServer, ctx: ToolContext) {
  server.tool(
    "search_parts",
    "Search electronic components by MPN, description, or specs. Returns stock, pricing, datasheets, and lifecycle info from Octopart/Nexar.",
    SearchPartsInput.shape,
    async (args) =>
      dispatchTool("search_parts", ctx, () => h.searchParts(ctx.nexar, args))
  );

  server.tool(
    "check_part_availability",
    "Check real-time stock and pricing for a specific manufacturer part number (MPN). Returns supplier inventory, MOQ, and pricing tiers.",
    CheckAvailabilityInput.shape,
    async (args) =>
      dispatchTool("check_part_availability", ctx, () =>
        h.checkPartAvailability(ctx.nexar, args)
      )
  );

  server.tool(
    "list_library_components",
    "List all components in an Altium 365 workspace library.",
    ListLibraryComponentsInput.shape,
    async (args) =>
      dispatchTool("list_library_components", ctx, () =>
        h.listLibraryComponents(ctx.nexar, args)
      )
  );

  server.tool(
    "find_alternative_parts",
    "Find alternative/substitute parts for a given MPN.",
    FindAlternativePartsInput.shape,
    async (args) =>
      dispatchTool("find_alternative_parts", ctx, () =>
        h.findAlternativeParts(ctx.nexar, args)
      )
  );
}
