/**
 * Subprocessors page — list of third parties that process Customer
 * personal data on PCBviber's behalf, with each one's purpose and
 * processing location.
 *
 * Tied to the DPA (PR 7.5): Section 4 of the DPA points here, and
 * customers under that Addendum get 30 days notice before a new
 * sub-processor is added. When you onboard a new vendor, update
 * this list AND email customers who've signed the DPA.
 *
 * Public route — no auth required.
 *
 * The list below reflects what the platform actually uses today.
 * Update when adding / removing real vendors. Optional vendors
 * (Sentry, WorkOS) are flagged so customers know they're not in
 * the data path unless we configure them.
 */

import { Link } from "react-router-dom";

interface Subprocessor {
  name: string;
  purpose: string;
  data: string;
  location: string;
  optional?: boolean;
}

const SUBPROCESSORS: Subprocessor[] = [
  {
    name: "Neon (Postgres)",
    purpose: "Primary database — application + audit data",
    data:
      "User accounts, organization settings, audit logs, Stripe customer ids, encrypted Nexar credentials",
    location: "United States (us-east-1)",
  },
  {
    name: "Stripe",
    purpose: "Subscription billing + payment processing",
    data:
      "Billing email, Customer's chosen plan, payment method (held by Stripe; PCBviber never sees card numbers)",
    location: "United States, Ireland",
  },
  {
    name: "Octopart / Nexar",
    purpose: "Component pricing + availability lookups",
    data:
      "Manufacturer part numbers and search queries Customer's authorized users submit to Parts Search",
    location: "United States",
  },
  {
    name: "WorkOS",
    purpose: "SAML / OIDC SSO (when Customer enables it)",
    data:
      "Authentication metadata (email, IdP-provided profile fields) for SSO logins",
    location: "United States",
    optional: true,
  },
  {
    name: "Sentry",
    purpose: "Error tracking + observability",
    data:
      "Stack traces, request paths, organization id, redacted-by-default user id (no email, IP, or auth headers — see PR 6.4 PII filter)",
    location: "United States, European Union",
    optional: true,
  },
  {
    name: "GitHub Actions",
    purpose: "CI/CD pipeline (build + test + deploy)",
    data:
      "Source code only — does not handle Customer Personal Data at runtime",
    location: "United States",
  },
];

export function SubprocessorsPage() {
  return (
    <article className="mx-auto max-w-4xl px-6 py-12 text-slate-800">
      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight">Subprocessors</h1>
        <p className="mt-2 text-sm text-slate-600">
          Last updated:{" "}
          <time dateTime="2026-04-26">April 26, 2026</time>
        </p>
        <p className="mt-2 text-sm text-slate-600">
          PCBviber engages the third parties below to deliver the
          Service. Each entry shows the data shared, the purpose,
          and the processing location. See the{" "}
          <Link to="/legal/dpa" className="text-blue-700 underline">
            DPA
          </Link>{" "}
          for the contractual framework that binds these
          sub-processors.
        </p>
      </header>

      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-slate-300 text-left text-xs uppercase text-slate-500">
            <th className="py-2 pr-4 font-medium">Vendor</th>
            <th className="py-2 pr-4 font-medium">Purpose</th>
            <th className="py-2 pr-4 font-medium">Data shared</th>
            <th className="py-2 pr-4 font-medium">Location</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200">
          {SUBPROCESSORS.map((s) => (
            <tr key={s.name}>
              <td className="py-3 pr-4 align-top">
                <span className="font-medium">{s.name}</span>
                {s.optional && (
                  <span className="ml-2 inline-block rounded bg-slate-100 px-1.5 py-0.5 text-[10px] uppercase text-slate-600">
                    optional
                  </span>
                )}
              </td>
              <td className="py-3 pr-4 align-top text-slate-700">
                {s.purpose}
              </td>
              <td className="py-3 pr-4 align-top text-slate-700">
                {s.data}
              </td>
              <td className="py-3 pr-4 align-top text-slate-700">
                {s.location}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <footer className="mt-12 border-t border-slate-200 pt-6 text-sm text-slate-500">
        <p>
          We notify customers under the DPA at least 30 days before
          adding a new sub-processor. Send objections to{" "}
          <a
            href="mailto:legal@pcbviber.example"
            className="text-blue-700 underline"
          >
            legal@pcbviber.example
          </a>
          .
        </p>
      </footer>
    </article>
  );
}
