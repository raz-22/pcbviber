/**
 * TanStack Query hooks for /api/orgs/:orgId/workspaces/*.
 *
 * Cache layout:
 *   ["workspaces", orgId]              — list
 *   ["workspaces", orgId, workspaceId] — single
 *
 * Mutations invalidate the list (and the single, when applicable) so the
 * Settings page rerenders without manual refetches. We deliberately do
 * NOT setQueryData on the list after create — the server response shape
 * is `{ workspace }`, not `{ workspaces }`, and re-fetching is cheap.
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  api,
  ApiError,
  type CreateWorkspaceInput,
  type TestConnectionInput,
  type UpdateWorkspaceInput,
  type Workspace,
} from "./api";

export const workspacesKey = (orgId: string) => ["workspaces", orgId] as const;
export const workspaceKey = (orgId: string, workspaceId: string) =>
  ["workspaces", orgId, workspaceId] as const;

/**
 * Drop both the list and any per-workspace cache entries for an org.
 * Pulled out so each mutation invalidator stays a one-liner and the
 * unit test can assert the exact key set.
 */
export function invalidateWorkspaces(qc: QueryClient, orgId: string) {
  qc.invalidateQueries({ queryKey: workspacesKey(orgId) });
}

export function useWorkspaces(orgId: string | undefined) {
  return useQuery({
    queryKey: orgId ? workspacesKey(orgId) : ["workspaces", "(none)"],
    queryFn: async (): Promise<Workspace[]> => {
      const res = await api.listWorkspaces(orgId!);
      return res.workspaces;
    },
    enabled: !!orgId,
    staleTime: 30_000,
  });
}

export function useWorkspace(orgId: string | undefined, workspaceId: string | undefined) {
  return useQuery({
    queryKey:
      orgId && workspaceId
        ? workspaceKey(orgId, workspaceId)
        : ["workspaces", "(none)", "(none)"],
    queryFn: async (): Promise<Workspace> => {
      const res = await api.getWorkspace(orgId!, workspaceId!);
      return res.workspace;
    },
    enabled: !!orgId && !!workspaceId,
    staleTime: 30_000,
  });
}

export function useCreateWorkspace(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateWorkspaceInput) => api.createWorkspace(orgId, input),
    onSuccess: () => invalidateWorkspaces(qc, orgId),
  });
}

export function useUpdateWorkspace(orgId: string, workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateWorkspaceInput) =>
      api.updateWorkspace(orgId, workspaceId, input),
    onSuccess: () => invalidateWorkspaces(qc, orgId),
  });
}

export function useDeleteWorkspace(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (workspaceId: string) => api.deleteWorkspace(orgId, workspaceId),
    onSuccess: () => invalidateWorkspaces(qc, orgId),
  });
}

export function useTestWorkspaceConnection(orgId: string) {
  return useMutation({
    mutationFn: (input: TestConnectionInput) =>
      api.testWorkspaceConnection(orgId, input),
  });
}

/**
 * Map a workspace-flow ApiError to a user-facing string. Mirrors the
 * stable codes in the internal design spec §3 + the ones the server
 * actually emits today (workspace.routes.ts, nexar-routes.ts). Anything
 * unmapped falls through to the server's English message so we don't
 * silently swallow new error codes.
 */
export function workspaceErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "credentials_rejected":
        return "Nexar rejected those credentials. Double-check the client ID and secret.";
      case "workspace_not_configured":
        return "This workspace has no Nexar credentials. Add them in Settings.";
      case "workspace_unavailable":
        return "Could not load this workspace's credentials. Try saving them again.";
      case "missing_altium_workspace_url":
        return "This workspace has no Altium 365 URL. Add one in Settings.";
      case "upstream_error":
        return "Nexar returned an error. Your credentials are valid; the upstream call failed.";
      case "invalid_input":
        return "Some fields are invalid. Check the form and try again.";
      case "forbidden":
        return "You don't have permission to perform this action.";
      case "not_found":
        return "Workspace not found.";
      case "not_authenticated":
        return "Your session has expired. Please log in again.";
      default:
        return err.message || "Something went wrong. Please try again.";
    }
  }
  return "Network error. Please check your connection and retry.";
}
