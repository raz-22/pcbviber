import type { NexarService } from "../services/nexar.js";
import type { AltiumWorkspace, AltiumProject } from "@altium-mcp/shared";

export async function listWorkspaces(nexar: NexarService): Promise<AltiumWorkspace[]> {
  return nexar.listWorkspaces();
}

export async function listProjects(
  nexar: NexarService,
  { workspaceUrl }: { workspaceUrl: string }
): Promise<AltiumProject[]> {
  return nexar.listProjects(workspaceUrl);
}

export async function getProjectDetails(
  _nexar: NexarService,
  { workspaceUrl, projectId }: { workspaceUrl: string; projectId: string }
): Promise<object> {
  return {
    status: "stub",
    message: `Project details for ${projectId} in ${workspaceUrl} — coming in Phase 2`,
    planned_fields: [
      "schematic_hierarchy",
      "pcb_stackup",
      "design_rules",
      "revision_history",
      "release_status",
      "collaborators",
    ],
  };
}

export async function createProject(
  _nexar: NexarService,
  args: {
    workspaceUrl: string;
    name: string;
    description?: string;
    template: "blank" | "arduino_shield" | "raspberry_pi_hat" | "custom";
  }
): Promise<object> {
  return {
    status: "stub",
    message: `Would create project '${args.name}' from template '${args.template}' — coming in Phase 2`,
    workspaceUrl: args.workspaceUrl,
    description: args.description,
  };
}
