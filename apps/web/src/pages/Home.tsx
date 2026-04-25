import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";

/**
 * Logged-in landing page. Renders the user's organization summary and
 * links to feature pages. This is the SPRINT 1 EXIT page — proof that
 * a user can sign up, see their org name, and log out.
 *
 * Sprint 2 will add Workspace CRUD here. Sprint 3 will add Members.
 */
export function HomePage() {
  const { me } = useAuth();
  if (!me) return null; // route guard handles the redirect

  const primary = me.orgs[0];

  return (
    <div className="mx-auto max-w-3xl px-6 py-10 space-y-8">
      <section>
        <h1 className="text-2xl font-semibold tracking-tight">
          Welcome, {me.user.email}
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Member since {new Date(me.user.createdAt).toLocaleDateString()}.
        </p>
      </section>

      {primary ? (
        <section className="rounded-lg border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Your organization
          </h2>
          <p className="mt-2 text-lg font-medium">{primary.name}</p>
          <p className="text-sm text-slate-500">
            <code className="font-mono text-xs">{primary.slug}</code> · role: {primary.role}
          </p>
          {me.orgs.length > 1 && (
            <p className="mt-2 text-xs text-slate-500">
              You belong to {me.orgs.length} organizations. Switching is coming in Sprint 3.
            </p>
          )}
        </section>
      ) : (
        <section className="rounded-lg border border-amber-300 bg-amber-50 p-5 text-amber-900">
          You are signed in but don't belong to any organization.
        </section>
      )}

      <section className="rounded-lg border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Tools
        </h2>
        <ul className="mt-3 space-y-2 text-sm">
          <li>
            <Link to="/parts" className="text-blue-600 hover:underline">
              Parts Search
            </Link>{" "}
            <span className="text-slate-500">
              — search Octopart for components
            </span>
          </li>
          <li className="text-slate-400">
            <span>BOM analysis</span> · coming in Sprint 2
          </li>
          <li className="text-slate-400">
            <span>Manufacturing exports</span> · coming in Sprint 2
          </li>
        </ul>
      </section>
    </div>
  );
}
