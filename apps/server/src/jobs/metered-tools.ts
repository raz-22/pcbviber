/**
 * Tool → metric registry. Single source of truth for which tools
 * count against which Stripe meter, and at what unit cost. Both
 * the REST routes and the MCP transport's tool dispatch read this
 * map; any new metered tool gets one entry here, then the meter
 * wrapping picks it up automatically.
 *
 * Numbers come from spec §4.4:
 *   - bom_lookup tools (search / availability / alternatives /
 *     get_project_bom): 1 unit per call
 *   - cost_analysis tools (analyze_bom_cost): currently 1 unit per
 *     call. Spec says "1 unit per quantity tier" — implementing
 *     that needs the handler to return the tier count and the
 *     dispatch layer to read it. Deferred; underbilling is the
 *     customer-friendly side of the trade-off.
 *   - export tools (export_manufacturing_data): 1 unit per call
 *
 * Tools NOT in this map (e.g. ad_*, list_workspaces, list_projects,
 * list_library_components) are NOT metered — meter() is bypassed
 * and the call runs as before.
 */

import type { Metric } from "@altium-mcp/metering";

export interface MeteredToolConfig {
  metric: Metric;
  units: number;
}

export const METERED_TOOLS: Readonly<Record<string, MeteredToolConfig>> = {
  search_parts: { metric: "bom_lookup", units: 1 },
  check_part_availability: { metric: "bom_lookup", units: 1 },
  find_alternative_parts: { metric: "bom_lookup", units: 1 },
  get_project_bom: { metric: "bom_lookup", units: 1 },
  analyze_bom_cost: { metric: "cost_analysis", units: 1 },
  export_manufacturing_data: { metric: "export", units: 1 },
};

/**
 * Look up the metering config for a tool by name. Returns null
 * for non-metered tools (the dispatch layer bypasses meter()).
 */
export function meteredToolConfig(tool: string): MeteredToolConfig | null {
  return METERED_TOOLS[tool] ?? null;
}
