import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as h from "../handlers/manufacturing.js";
import { dispatchTool, type ToolContext } from "../mcp/dispatch.js";

export function registerManufacturingTools(server: McpServer, ctx: ToolContext) {
  server.tool(
    "get_project_bom",
    "Retrieve the Bill of Materials (BOM) for an Altium 365 project.",
    {
      workspaceUrl: z.string().url(),
      projectId: z.string(),
      includeAlternatives: z.boolean().default(false),
    },
    async (args) =>
      dispatchTool("get_project_bom", ctx, () => h.getProjectBom(ctx.nexar, args))
  );

  server.tool(
    "analyze_bom_cost",
    "Analyze BOM cost at different production quantities.",
    {
      workspaceUrl: z.string().url(),
      projectId: z.string(),
      quantities: z.array(z.number().positive()).default([1, 10, 100, 1000]),
    },
    async (args) =>
      dispatchTool("analyze_bom_cost", ctx, () => h.analyzeBomCost(ctx.nexar, args))
  );

  server.tool(
    "export_manufacturing_data",
    "[Phase 2] Export Gerber, ODB++, pick-and-place data, or IPC-2581 for a project release.",
    {
      workspaceUrl: z.string().url(),
      projectId: z.string(),
      format: z.enum(["gerber_274x", "gerber_x2", "odb++", "ipc2581", "pick_and_place"]),
      releaseId: z.string().optional(),
    },
    async (args) =>
      dispatchTool("export_manufacturing_data", ctx, () =>
        h.exportManufacturingData(ctx.nexar, args)
      )
  );

  server.tool(
    "run_drc_summary",
    "[Phase 2] Get the latest Design Rule Check (DRC) results for a project.",
    { workspaceUrl: z.string().url(), projectId: z.string() },
    async (args) =>
      dispatchTool("run_drc_summary", ctx, () => h.runDrcSummary(ctx.nexar, args))
  );

  server.tool(
    "check_production_readiness",
    "Run a production readiness checklist for a project.",
    { workspaceUrl: z.string().url(), projectId: z.string() },
    async (args) =>
      dispatchTool("check_production_readiness", ctx, () =>
        h.checkProductionReadiness(ctx.nexar, args)
      )
  );
}
