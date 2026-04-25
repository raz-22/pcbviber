import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { validateRedirectUrl } from "../lib/redirect";

/**
 * Wraps protected routes: while /me is loading, render nothing (avoids
 * a flash of /login). Once we know auth state, either pass through to
 * children or redirect to /login while remembering where the user
 * was trying to go.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) return null;
  if (!isAuthenticated) {
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: location.pathname + location.search }}
      />
    );
  }
  return <>{children}</>;
}

/**
 * Inverse: keeps already-logged-in users out of /login + /signup.
 * Sends them to wherever they were before, or `/`.
 */
export function RedirectIfAuthed({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();
  const location = useLocation();
  if (isLoading) return null;
  if (isAuthenticated) {
    const rawFrom = (location.state as { from?: string } | null)?.from;
    const from = validateRedirectUrl(rawFrom);
    return <Navigate to={from} replace />;
  }
  return <>{children}</>;
}
