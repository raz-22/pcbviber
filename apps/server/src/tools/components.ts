/**
 * MCP tool shells for the component/supply-chain surface.
 * Real logic lives in src/handlers/components.ts and is shared with the REST BFF.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NexarService } from "../services/nexar.js";
import {
  SearchPartsInput,
  CheckAvailabilityInput,
  ListLibraryComponentsInput,
  FindAlternativePartsInput,
} from "@altium-mcp/shared";
import * as h from "../handlers/components.js";
import { toMcpResponse } from "../handlers/mcp-response.js";

export function registerComponentTools(server: McpServer, nexar: NexarService) {
  server.tool(
    "search_parts",
    "Search electronic components by MPN, description, or specs. Returns stock, pricing, datasheets, and lifecycle info from Octopart/Nexar.",
    SearchPartsInput.shape,
    async (args) => toMcpResponse(() => h.searchParts(nexar, args))
  );

  server.tool(
    "check_part_availability",
    "Check real-time stock and pricing for a specific manufacturer part number (MPN). Returns supplier inventory, MOQ, and pricing tiers.",
    CheckAvailabilityInput.shape,
    async (args) => toMcpResponse(() => h.checkPartAvailability(nexar, args))
  );

  server.tool(
    "list_library_components",
    "List all components in an Altium 365 workspace library.",
    ListLibraryComponentsInput.shape,
    async (args) => toMcpResponse(() => h.listLibraryComponents(nexar, args))
  );

  server.tool(
    "find_alternative_parts",
    "Find alternative/substitute parts for a given MPN.",
    FindAlternativePartsInput.shape,
    async (args) => toMcpResponse(() => h.findAlternativeParts(nexar, args))
  );
}
