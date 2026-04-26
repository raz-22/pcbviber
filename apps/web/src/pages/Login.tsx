import { useState } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { useLogin, authErrorMessage } from "../lib/auth";
import { validateRedirectUrl } from "../lib/redirect";

/**
 * Login page. Submits to /api/auth/login; on success the server sets
 * the session cookie and the SPA's auth state refetches /me.
 *
 * Also offers SAML/OIDC SSO for orgs that have configured a WorkOS
 * connection. The "Sign in with SSO" button reveals an org-slug
 * field and, on submit, full-page-redirects to /api/auth/sso/start
 * (the server 302s onward to the IdP). Browser handles the
 * redirect chain; we don't fetch.
 */
export function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [ssoMode, setSsoMode] = useState(false);
  const [orgSlug, setOrgSlug] = useState("");
  const login = useLogin();
  const navigate = useNavigate();
  const location = useLocation();
  const cameFrom = validateRedirectUrl(
    (location.state as { from?: string } | null)?.from
  );

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await login.mutateAsync({ email, password });
      navigate(cameFrom, { replace: true });
    } catch {
      // Error message renders below from `login.error`; nothing more
      // to do here.
    }
  }

  function onSsoSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!orgSlug) return;
    // Full-page navigation — the server returns 302 to WorkOS, which
    // 302s onward to the IdP. A `fetch` would only follow the first
    // redirect inside the SPA's process, never reaching the IdP.
    const qs = new URLSearchParams({
      orgSlug,
      returnTo: cameFrom,
    });
    window.location.href = `/api/auth/sso/start?${qs.toString()}`;
  }

  return (
    <div className="mx-auto mt-16 max-w-md px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Log in</h1>
      <p className="mt-1 text-sm text-slate-600">
        Welcome back.{" "}
        <Link to="/signup" className="text-blue-600 hover:underline">
          Need an account?
        </Link>
      </p>

      {ssoMode ? (
        <form onSubmit={onSsoSubmit} className="mt-8 space-y-4">
          <p className="text-sm text-slate-600">
            Enter your organization slug to continue with single
            sign-on.
          </p>
          <Field
            label="Organization"
            type="text"
            autoComplete="organization"
            required
            value={orgSlug}
            onChange={setOrgSlug}
            placeholder="acme-hardware"
          />
          <button
            type="submit"
            disabled={!orgSlug}
            className="w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
          >
            Continue with SSO
          </button>
          <button
            type="button"
            onClick={() => setSsoMode(false)}
            className="block w-full text-center text-sm text-slate-600 hover:underline"
          >
            ← Back to password sign-in
          </button>
        </form>
      ) : (
        <form onSubmit={onSubmit} className="mt-8 space-y-4">
          <Field
            label="Email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={setEmail}
          />
          <Field
            label="Password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={setPassword}
          />

          {login.error && (
            <p className="text-sm text-red-600">
              {authErrorMessage(login.error)}
            </p>
          )}

          <button
            type="submit"
            disabled={login.isPending || !email || !password}
            className="w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
          >
            {login.isPending ? "Logging in…" : "Log in"}
          </button>

          <div className="relative my-2 flex items-center">
            <div className="flex-grow border-t border-slate-200" />
            <span className="mx-3 text-xs uppercase text-slate-500">or</span>
            <div className="flex-grow border-t border-slate-200" />
          </div>

          <button
            type="button"
            onClick={() => setSsoMode(true)}
            className="w-full rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Sign in with SSO
          </button>
        </form>
      )}
    </div>
  );
}

interface FieldProps {
  label: string;
  type: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete?: string;
  required?: boolean;
  placeholder?: string;
}

function Field(props: FieldProps) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-slate-700">{props.label}</span>
      <input
        type={props.type}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        autoComplete={props.autoComplete}
        required={props.required}
        placeholder={props.placeholder}
        className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
      />
    </label>
  );
}
