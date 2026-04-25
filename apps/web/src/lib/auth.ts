/**
 * Auth state — backed entirely by /api/auth/me through TanStack Query.
 *
 * Survives page refresh because the session cookie does, so nothing is
 * stored client-side. login/signup mutations SEED the `["auth", "me"]`
 * cache from their response (avoids a redirect-flicker between
 * "logged in by server" and "the SPA's /me has caught up"). Logout
 * clears every query so a different user signing in next can't see
 * leftover data from the previous session.
 */

import {
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  api,
  ApiError,
  type AuthMe,
  type LoginResponse,
  type SignupResponse,
} from "./api";

const ME_KEY = ["auth", "me"] as const;

/**
 * Build the AuthMe-shaped object the cache expects from the
 * /api/auth/signup response. Signup returns a single org (the one
 * just auto-created); /me returns an orgs[] array. The new user is
 * always `owner` of their auto-created org.
 *
 * Exported so the unit test can pin the shape without driving the
 * mutation through React.
 */
export function authMeFromSignup(res: SignupResponse): AuthMe {
  return {
    user: res.user,
    orgs: [
      {
        id: res.org.id,
        slug: res.org.slug,
        name: res.org.name,
        role: "owner",
      },
    ],
  };
}

/** Seed the `["auth", "me"]` cache. Used by signup and login. */
export function seedAuthMeCache(qc: QueryClient, me: AuthMe): void {
  qc.setQueryData(ME_KEY, me);
}

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
    onSuccess: (res: SignupResponse) => {
      // Seed the cache so the post-signup navigate("/") finds the user
      // already authenticated — avoids a flicker through /login during
      // the refetch window.
      seedAuthMeCache(qc, authMeFromSignup(res));
    },
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.login,
    onSuccess: (res: LoginResponse) => {
      // Login response is already AuthMe-shaped; pass it straight through.
      seedAuthMeCache(qc, res);
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.logout,
    onSuccess: () => {
      // Mark the user as logged-out for any subscribers that read /me
      // before the queries below get cleared.
      qc.setQueryData(ME_KEY, null);
      // Drop every cached query — prevents the next user signing in
      // from seeing this user's parts-search results, BOMs, etc.
      qc.clear();
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
