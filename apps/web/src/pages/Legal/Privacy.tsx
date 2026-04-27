/**
 * Privacy Policy.
 *
 * ⚠ THIS IS A SCAFFOLD, NOT LEGAL TEXT.
 *
 * The structure follows GDPR Art. 13/14 + CCPA disclosure norms —
 * what data we collect, why, on what legal basis, who we share it
 * with, how long we keep it, and what rights data subjects have.
 * The body of each section is a placeholder calling out what content
 * needs to live there. Before the SPA goes to public traffic, the
 * operator MUST replace placeholders with text reviewed by counsel.
 *
 * Public route — no auth required. Linked from signup ("by signing
 * up you agree to…") and from the global footer.
 */

import { Link } from "react-router-dom";

export function PrivacyPage() {
  return (
    <article className="mx-auto max-w-3xl px-6 py-12 text-slate-800 [&_h2]:mt-8 [&_h2]:mb-3 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_p]:my-3 [&_p]:leading-7 [&_section]:mt-2 [&_ul]:my-3 [&_ul]:ml-6 [&_ul]:list-disc [&_li]:my-1">
      <header className="mb-8">
        <p className="text-xs uppercase tracking-wide text-rose-700 font-medium">
          Draft template — replace with text reviewed by counsel
          before opening to public traffic
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          Privacy Policy
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Last updated:{" "}
          <time dateTime="2026-04-27">April 27, 2026</time>
        </p>
      </header>

      <section>
        <h2>1. Who we are</h2>
        <p>
          [Replace] PCBviber ("we," "us," "our") operates the
          PCBviber service. This Policy explains what personal data
          we collect about you, why, and what rights you have. If
          you have questions, contact{" "}
          <a
            href="mailto:privacy@pcbviber.example"
            className="text-blue-700 underline"
          >
            privacy@pcbviber.example
          </a>
          .
        </p>
      </section>

      <section>
        <h2>2. What data we collect</h2>
        <p>
          We collect the minimum personal data needed to provide the
          service:
        </p>
        <ul>
          <li>
            <strong>Account data:</strong> email address, hashed
            password, optional display name, organization name.
          </li>
          <li>
            <strong>Authentication data:</strong> session tokens,
            IP address at login, browser user-agent. Used for
            session management, audit logs, and per-org IP
            allowlist enforcement.
          </li>
          <li>
            <strong>Usage data:</strong> the tools you call, when
            you call them, and how many units each call consumed.
            Used for billing and quota enforcement.
          </li>
          <li>
            <strong>Configuration you submit:</strong> Altium 365
            URL and Octopart/Nexar API credentials. Credentials are
            encrypted at rest and never returned to the browser.
          </li>
          <li>
            <strong>Content you submit:</strong> queries you make
            via the API or the UI (e.g. part numbers you search
            for). We do not train AI models on Customer queries.
          </li>
        </ul>
      </section>

      <section>
        <h2>3. Why we process it (legal bases under GDPR)</h2>
        <ul>
          <li>
            <strong>Performance of contract</strong> (Art. 6(1)(b)):
            providing the service, processing payments, supporting
            you.
          </li>
          <li>
            <strong>Legitimate interests</strong> (Art. 6(1)(f)):
            keeping the service secure (audit logs, abuse
            detection), preventing fraud, and improving the
            product.
          </li>
          <li>
            <strong>Legal obligation</strong> (Art. 6(1)(c)):
            tax and accounting records, complying with lawful
            requests.
          </li>
        </ul>
      </section>

      <section>
        <h2>4. Who we share it with</h2>
        <p>
          We use third-party sub-processors to operate the service.
          The complete list, including each one's purpose and
          processing region, is at{" "}
          <Link
            to="/legal/subprocessors"
            className="text-blue-700 underline"
          >
            /legal/subprocessors
          </Link>
          . We do not sell personal data, and we do not share it for
          advertising purposes.
        </p>
      </section>

      <section>
        <h2>5. Where data is processed</h2>
        <p>
          [Replace] Primary infrastructure is hosted in [Replace
          region — e.g., AWS us-east-1]. Some sub-processors
          operate outside the EEA; transfers rely on the European
          Commission's Standard Contractual Clauses (SCCs) — see
          our{" "}
          <Link to="/legal/dpa" className="text-blue-700 underline">
            DPA
          </Link>{" "}
          for details.
        </p>
      </section>

      <section>
        <h2>6. How long we keep it</h2>
        <ul>
          <li>
            <strong>Account data:</strong> for as long as the
            account exists, plus [Replace] days after deletion to
            absorb accidental-deletion recovery.
          </li>
          <li>
            <strong>Audit logs:</strong> [Replace] months for
            security investigations and compliance.
          </li>
          <li>
            <strong>Billing records:</strong> retained for the
            period required by applicable tax law (typically [Replace]
            years).
          </li>
        </ul>
      </section>

      <section>
        <h2>7. Your rights</h2>
        <p>
          Under GDPR, UK GDPR, and CCPA you have the right to:
        </p>
        <ul>
          <li>Access the personal data we hold about you.</li>
          <li>Correct inaccurate data.</li>
          <li>Delete your account and associated data.</li>
          <li>
            Export your data in a portable format ("data
            portability").
          </li>
          <li>
            Object to or restrict certain processing based on
            legitimate interests.
          </li>
          <li>
            Lodge a complaint with your local supervisory
            authority.
          </li>
        </ul>
        <p>
          Email{" "}
          <a
            href="mailto:privacy@pcbviber.example"
            className="text-blue-700 underline"
          >
            privacy@pcbviber.example
          </a>{" "}
          to exercise any of these rights. We respond within 30
          days.
        </p>
      </section>

      <section>
        <h2>8. Security</h2>
        <p>
          [Replace] We encrypt data in transit (TLS) and at rest,
          isolate tenants at the database layer using Postgres
          Row-Level Security, support per-org IP allowlists, and
          maintain audit logs of security-relevant events. Despite
          our best efforts, no system is perfectly secure. If you
          believe your account has been compromised, contact us
          immediately.
        </p>
      </section>

      <section>
        <h2>9. Children</h2>
        <p>
          The service is not directed at children under 16. We do
          not knowingly collect personal data from children. If you
          believe a child has provided personal data, contact us
          and we will delete it.
        </p>
      </section>

      <section>
        <h2>10. Changes to this Policy</h2>
        <p>
          [Replace] We will notify registered users by email of
          material changes at least 30 days before they take
          effect. Non-material changes (clarifications, typo fixes)
          take effect on posting.
        </p>
      </section>

      <footer className="mt-12 border-t border-slate-200 pt-6 text-sm text-slate-500">
        <p>
          Questions? Contact{" "}
          <a
            href="mailto:privacy@pcbviber.example"
            className="text-blue-700 underline"
          >
            privacy@pcbviber.example
          </a>
          .
        </p>
        <p className="mt-2">
          See also:{" "}
          <Link to="/legal/terms" className="underline">
            Terms of Service
          </Link>
          ,{" "}
          <Link to="/legal/dpa" className="underline">
            DPA
          </Link>
          ,{" "}
          <Link to="/legal/subprocessors" className="underline">
            Subprocessors
          </Link>
          .
        </p>
      </footer>
    </article>
  );
}
