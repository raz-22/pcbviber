import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as h from "../handlers/projects.js";
import { dispatchTool, type ToolContext } from "../mcp/dispatch.js";

export function registerProjectTools(server: McpServer, ctx: ToolContext) {
  server.tool(
    "list_workspaces",
    "List all Altium 365 workspaces the authenticated user has access to.",
    {},
    async () => dispatchTool("list_workspaces", ctx, () => h.listWorkspaces(ctx.nexar))
  );

  server.tool(
    "list_projects",
    "List all projects in an Altium 365 workspace.",
    { workspaceUrl: z.string().url().describe("Altium 365 workspace URL") },
    async (args) =>
      dispatchTool("list_projects", ctx, () => h.listProjects(ctx.nexar, args))
  );

  server.tool(
    "get_project_details",
    "Get detailed information about an Altium 365 project including revision history, schematic structure, and PCB configuration.",
    {
      workspaceUrl: z.string().url().describe("Altium 365 workspace URL"),
      projectId: z.string().describe("Project ID from list_projects"),
    },
    async (args) =>
      dispatchTool("get_project_details", ctx, () =>
        h.getProjectDetails(ctx.nexar, args)
      )
  );

  server.tool(
    "create_project",
    "[Phase 2] Create a new project in an Altium 365 workspace with initial configuration.",
    {
      workspaceUrl: z.string().url().describe("Altium 365 workspace URL"),
      name: z.string().describe("Project name"),
      description: z.string().optional().describe("Project description"),
      template: z
        .enum(["blank", "arduino_shield", "raspberry_pi_hat", "custom"])
        .default("blank"),
    },
    async (args) =>
      dispatchTool("create_project", ctx, () => h.createProject(ctx.nexar, args))
  );
}
