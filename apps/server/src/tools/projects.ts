import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NexarService } from "../services/nexar.js";
import * as h from "../handlers/projects.js";
import { toMcpResponse } from "../handlers/mcp-response.js";

export function registerProjectTools(server: McpServer, nexar: NexarService) {
  server.tool(
    "list_workspaces",
    "List all Altium 365 workspaces the authenticated user has access to.",
    {},
    async () => toMcpResponse(() => h.listWorkspaces(nexar))
  );

  server.tool(
    "list_projects",
    "List all projects in an Altium 365 workspace.",
    { workspaceUrl: z.string().url().describe("Altium 365 workspace URL") },
    async (args) => toMcpResponse(() => h.listProjects(nexar, args))
  );

  server.tool(
    "get_project_details",
    "Get detailed information about an Altium 365 project including revision history, schematic structure, and PCB configuration.",
    {
      workspaceUrl: z.string().url().describe("Altium 365 workspace URL"),
      projectId: z.string().describe("Project ID from list_projects"),
    },
    async (args) => toMcpResponse(() => h.getProjectDetails(nexar, args))
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
    async (args) => toMcpResponse(() => h.createProject(nexar, args))
  );
}
