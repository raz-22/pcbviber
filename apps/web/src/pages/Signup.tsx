import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useSignup, authErrorMessage } from "../lib/auth";

/**
 * Signup page. Server auto-creates an Organization with the user as
 * owner; on success we land on `/`.
 */
export function SignupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [orgName, setOrgName] = useState("");
  const signup = useSignup();
  const navigate = useNavigate();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await signup.mutateAsync({
        email,
        password,
        name: name || undefined,
        orgName: orgName || undefined,
      });
      navigate("/", { replace: true });
    } catch {
      // surface via signup.error below
    }
  }

  return (
    <div className="mx-auto mt-16 max-w-md px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Create your account</h1>
      <p className="mt-1 text-sm text-slate-600">
        Free during beta.{" "}
        <Link to="/login" className="text-blue-600 hover:underline">
          Already have an account?
        </Link>
      </p>

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
          autoComplete="new-password"
          required
          value={password}
          onChange={setPassword}
          hint="At least 12 characters."
        />
        <Field
          label="Your name (optional)"
          type="text"
          autoComplete="name"
          value={name}
          onChange={setName}
        />
        <Field
          label="Organization name (optional)"
          type="text"
          autoComplete="organization"
          value={orgName}
          onChange={setOrgName}
          hint="If left blank, we'll create one for you."
        />

        {signup.error && (
          <p className="text-sm text-red-600">
            {authErrorMessage(signup.error)}
          </p>
        )}

        <button
          type="submit"
          disabled={signup.isPending || !email || !password}
          className="w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {signup.isPending ? "Creating account…" : "Create account"}
        </button>
      </form>
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
  hint?: string;
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
        className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
      />
      {props.hint && <p className="mt-1 text-xs text-slate-500">{props.hint}</p>}
    </label>
  );
}
