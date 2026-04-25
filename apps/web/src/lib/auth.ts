/**
 * Auth state — backed entirely by /api/auth/me through TanStack Query.
 *
 * Survives page refresh because the session cookie does, so nothing is
 * stored client-side. login/signup/logout mutations invalidate the
 * `["auth", "me"]` query so components subscribed to it re-render.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type AuthMe } from "./api";

const ME_KEY = ["auth", "me"] as const;

/**
 * Returns the current auth state. `isAuthenticated` is true once /me
 * resolves with a user; `null` if the session cookie is missing or
 * invalid; `undefined` while the first request is still in flight.
 */
export function useAuth() {
  const query = useQuery({
    queryKey: ME_KEY,
    queryFn: async (): Promise<AuthMe | null> => {
      try {
        return await api.me();
      } catch (err) {
        // 401 is the expected "not signed in" signal — return null so
        // the UI can render the login state without React Query
        // marking the query as errored.
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });

  return {
    me: query.data ?? null,
    isLoading: query.isLoading,
    isAuthenticated: !!query.data,
    error: query.error as Error | null,
    refetch: query.refetch,
  };
}

export function useSignup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.signup,
    onSuccess: () => {
      // After signup the server set the cookie; trigger /me to populate.
      qc.invalidateQueries({ queryKey: ME_KEY });
    },
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.login,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ME_KEY });
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.logout,
    onSuccess: () => {
      // Force /me to re-fetch and discover the session is gone.
      qc.setQueryData(ME_KEY, null);
      qc.invalidateQueries({ queryKey: ME_KEY });
    },
  });
}

/**
 * Map an API error code to a user-facing string. Single source of truth
 * for these strings — pages that want to show errors call this.
 */
export function authErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "email_taken":
        return "An account with that email already exists.";
      case "password_too_weak":
        return "Password must be at least 12 characters.";
      case "invalid_credentials":
        return "Email or password is incorrect.";
      case "invalid_input":
        return "Please check your input and try again.";
      case "auth_not_configured":
        return "The server's auth provider is not configured.";
      default:
        return err.message || "Something went wrong. Please try again.";
    }
  }
  return "Network error. Please check your connection and retry.";
}
