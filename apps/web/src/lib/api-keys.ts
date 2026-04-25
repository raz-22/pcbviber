/**
 * TanStack Query hooks for /api/orgs/:orgId/api-keys.
 *
 * Cache layout:
 *   ["apiKeys", orgId]   — list (includes revoked rows so the SPA can
 *                          render history; the page filters on
 *                          revokedAt === null for "active" view)
 *
 * Mutations (create + revoke) invalidate the list. The plaintext key
 * returned by `createApiKey` is intentionally NOT cached — it's
 * single-use, surfaced once in the create-success UI, then discarded.
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
  type ApiKey,
  type CreateApiKeyInput,
} from "./api";

export const apiKeysKey = (orgId: string) => ["apiKeys", orgId] as const;

export function invalidateApiKeys(qc: QueryClient, orgId: string) {
  qc.invalidateQueries({ queryKey: apiKeysKey(orgId) });
}

export function useApiKeys(orgId: string | undefined) {
  return useQuery({
    queryKey: orgId ? apiKeysKey(orgId) : ["apiKeys", "(none)"],
    queryFn: async (): Promise<ApiKey[]> => {
      const res = await api.listApiKeys(orgId!);
      return res.apiKeys;
    },
    enabled: !!orgId,
    staleTime: 30_000,
  });
}

export function useCreateApiKey(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateApiKeyInput) => api.createApiKey(orgId, input),
    onSuccess: () => invalidateApiKeys(qc, orgId),
  });
}

export function useRevokeApiKey(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (keyId: string) => api.revokeApiKey(orgId, keyId),
    onSuccess: () => invalidateApiKeys(qc, orgId),
  });
}

/**
 * API-key-flow error mapper. Mirrors the stable codes the server
 * emits from /api/orgs/:orgId/api-keys/*.
 */
export function apiKeyErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "api_key_already_revoked":
        return "This key has already been revoked.";
      case "invalid_input":
        return "Some fields are invalid. Check the form and try again.";
      case "forbidden":
        return "You don't have permission to perform this action.";
      case "not_found":
        return "API key not found.";
      case "not_authenticated":
        return "Your session has expired. Please log in again.";
      default:
        return err.message || "Something went wrong. Please try again.";
    }
  }
  return "Network error. Please check your connection and retry.";
}
