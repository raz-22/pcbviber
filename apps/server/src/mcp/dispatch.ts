/**
 * MCP tool-dispatch wrapper. Sits between the MCP SDK's `server.tool`
 * registration and our underlying handler functions; runs every tool
 * call through @altium-mcp/metering's `meter()` when the tool is in
 * METERED_TOOLS and the request has a per-tenant `meter` context.
 *
 * Two responsibilities:
 *   1. Bridge from "MCP tool name" to "metric + units" via the
 *      shared METERED_TOOLS registry. REST routes use the same
 *      registry so the two transports stay aligned.
 *   2. Map `QuotaExceeded` to a structured MCP tool error so the
 *      AI agent / client sees the same `quota_exceeded` shape the
 *      SPA gets from REST 429.
 *
 * Non-metered tools (ad_*, list_workspaces, list_projects, …) skip
 * the meter wrapper entirely and run identically to the pre-5.4
 * codepath. Stdio (which has no per-tenant context) falls into the
 * same "no metering" branch.
 */

import { QuotaExceeded } from "@altium-mcp/metering";
import type {
  MeterContext,
  QuotaStore,
  RecordUsage,
} from "@altium-mcp/metering";
import { meter } from "@altium-mcp/metering";
import { meteredToolConfig } from "../jobs/metered-tools.js";
import type { NexarService } from "../services/nexar.js";
import { toMcpResponse } from "../handlers/mcp-response.js";

/**
 * Per-tool-call metering context — caller-supplied. The HTTP /mcp
 * handler builds one of these from the API key's org + workspace;
 * the stdio entry leaves it null so meter() is bypassed.
 */
export interface ToolMeteringContext {
  meterCtx: MeterContext;
  store: QuotaStore;
  recordUsage: RecordUsage;
}

/**
 * The bag of dependencies a per-request MCP server hands to its
 * tool registrations. `nexar` is per-tenant when the request comes
 * through /mcp (loaded via NexarServiceFactory.forWorkspace), or
 * the env-loaded singleton on stdio.
 */
export interface ToolContext {
  nexar: NexarService;
  /**
   * Null on stdio / unauthenticated calls — meter() is bypassed and
   * the tool runs as before. Populated for /mcp requests from
   * authenticated API keys with a default workspace configured.
   */
  metering: ToolMeteringContext | null;
}

type McpToolResponse = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

/**
 * Wraps `handler` with metering + MCP response shaping. Tool
 * registrations call this in place of the bare `toMcpResponse`.
 *
 *   - Non-metered tool OR no metering context → runs `handler`
 *     and shapes via toMcpResponse (existing behavior).
 *   - Metered tool with metering context → runs through meter().
 *     QuotaExceeded → structured MCP error with the same
 *     `quota_exceeded` shape REST returns.
 *   - fn() throws something else → mapped to isError: true with
 *     the error message, same as toMcpResponse's catch.
 */
export async function dispatchTool<T>(
  toolName: string,
  toolCtx: ToolContext,
  handler: () => Promise<T>
): Promise<McpToolResponse> {
  const config = meteredToolConfig(toolName);
  if (!config || !toolCtx.metering) {
    return toMcpResponse(handler);
  }
  try {
    const result = await meter(
      toolCtx.metering.meterCtx,
      { tool: toolName, metric: config.metric, units: config.units },
      handler,
      {
        store: toolCtx.metering.store,
        recordUsage: toolCtx.metering.recordUsage,
      }
    );
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    if (err instanceof QuotaExceeded) {
      return mcpQuotaError(err);
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
}

/**
 * Structured MCP error matching the REST 429 body shape. The AI
 * client reads `isError: true` and can parse the JSON body to
 * surface the metric / limit / used to the operator.
 */
function mcpQuotaError(err: QuotaExceeded): McpToolResponse {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error: "quota_exceeded",
          metric: err.metric,
          limit: err.limit,
          used: err.used,
        }),
      },
    ],
    isError: true,
  };
}
