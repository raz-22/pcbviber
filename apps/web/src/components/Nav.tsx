import { Link, useNavigate } from "react-router-dom";
import { useAuth, useLogout } from "../lib/auth";

/**
 * Top navigation. Renders different content based on auth state:
 *   - Authenticated: shows user email + active org name + logout button
 *   - Anonymous: shows links to /login and /signup
 *   - Loading: minimal placeholder so the layout doesn't jump
 */
export function Nav() {
  const { me, isAuthenticated, isLoading } = useAuth();
  const logout = useLogout();
  const navigate = useNavigate();

  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto max-w-6xl px-6 py-4 flex items-center justify-between gap-4">
        <Link
          to="/"
          className="text-lg font-semibold tracking-tight hover:underline"
        >
          PCBviber
        </Link>

        <nav className="flex items-center gap-3 text-sm">
          {isLoading ? (
            <span className="text-slate-400">…</span>
          ) : isAuthenticated && me ? (
            <>
              <span className="text-slate-600 hidden sm:inline">
                {me.user.email}
              </span>
              {me.orgs[0] && (
                <span
                  className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700"
                  title={`Role: ${me.orgs[0].role}`}
                >
                  {me.orgs[0].name}
                </span>
              )}
              <Link
                to="/parts"
                className="text-slate-700 hover:underline"
              >
                Parts
              </Link>
              <Link
                to="/settings/workspaces"
                className="text-slate-700 hover:underline"
              >
                Settings
              </Link>
              <button
                onClick={async () => {
                  await logout.mutateAsync();
                  navigate("/login", { replace: true });
                }}
                disabled={logout.isPending}
                className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50"
              >
                {logout.isPending ? "…" : "Log out"}
              </button>
            </>
          ) : (
            <>
              <Link to="/login" className="text-slate-700 hover:underline">
                Log in
              </Link>
              <Link
                to="/signup"
                className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700"
              >
                Sign up
              </Link>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
