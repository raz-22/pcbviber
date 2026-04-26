/**
 * Data Processing Addendum (DPA).
 *
 * ⚠ THIS IS A SCAFFOLD, NOT LEGAL TEXT.
 *
 * The structure here matches what enterprise procurement teams
 * expect to see in a DPA — section headings, sub-processor pointer,
 * SCC reference, audit + termination clauses. The body of each
 * section is a placeholder calling out what content needs to live
 * there. Before this page goes to a real customer, the operator
 * MUST replace placeholders with text reviewed by counsel
 * (Vanta / Drata's template generators are a reasonable starting
 * point — see SOC 2 work in Sprint 7).
 *
 * Public route — no auth required. Customers read this before
 * signing contracts.
 */

import { Link } from "react-router-dom";

export function DpaPage() {
  return (
    <article className="mx-auto max-w-3xl px-6 py-12 text-slate-800 [&_h2]:mt-8 [&_h2]:mb-3 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_p]:my-3 [&_p]:leading-7 [&_section]:mt-2">
      <header className="mb-8">
        <p className="text-xs uppercase tracking-wide text-rose-700 font-medium">
          Draft template — replace with text reviewed by counsel
          before signing with customers
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          Data Processing Addendum
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Last updated:{" "}
          <time dateTime="2026-04-26">April 26, 2026</time>
        </p>
      </header>

      <section>
        <h2>1. Scope and definitions</h2>
        <p>
          [Replace] This Addendum applies to the processing of
          personal data by PCBviber on behalf of the Customer in
          connection with the Service. Defined terms ("Controller,"
          "Processor," "Personal Data," "Data Subject," "Processing")
          have the meanings given in the GDPR.
        </p>
      </section>

      <section>
        <h2>2. Subject matter and duration</h2>
        <p>
          [Replace] The subject matter of the processing is the
          provision of the Service. The duration is the term of the
          underlying agreement plus any retention period required to
          fulfill obligations under that agreement.
        </p>
      </section>

      <section>
        <h2>3. Categories of data subjects and personal data</h2>
        <p>
          [Replace] Data subjects: Customer's authorized users of
          the Service, and end-users whose data Customer chooses to
          submit to the Service.
        </p>
        <p>
          [Replace] Categories of personal data: identification data
          (name, email), authentication data (hashed passwords,
          session tokens, IP addresses), and any other personal
          data Customer chooses to submit.
        </p>
      </section>

      <section>
        <h2>4. Sub-processors</h2>
        <p>
          PCBviber engages sub-processors to provide the Service.
          The current list, including each sub-processor's purpose
          and processing location, is published at{" "}
          <Link
            to="/legal/subprocessors"
            className="text-blue-700 underline"
          >
            /legal/subprocessors
          </Link>
          . PCBviber will notify Customer of any new sub-processor
          at least 30 days before that sub-processor begins
          processing personal data, and the Customer may object on
          reasonable grounds.
        </p>
      </section>

      <section>
        <h2>5. International transfers</h2>
        <p>
          [Replace] Where personal data is transferred from the
          European Economic Area, the United Kingdom, or
          Switzerland to a country not subject to an adequacy
          decision, the parties rely on the European Commission's
          Standard Contractual Clauses ("SCCs"), incorporated by
          reference. Module 2 (controller-to-processor) applies to
          transfers from Customer to PCBviber; Module 3
          (processor-to-processor) applies to transfers from
          PCBviber to its sub-processors.
        </p>
      </section>

      <section>
        <h2>6. Technical and organizational measures</h2>
        <p>
          [Replace — list real measures here] In summary, PCBviber
          maintains: encryption at rest and in transit, role-based
          access control, multi-tenant isolation enforced at the
          database layer (Postgres Row-Level Security), per-tenant
          IP allowlists, audit logging of security-relevant events,
          and incident response procedures.
        </p>
      </section>

      <section>
        <h2>7. Audit rights</h2>
        <p>
          [Replace] Customer may, at its own expense and on
          reasonable notice, audit PCBviber's compliance with this
          Addendum no more frequently than annually. PCBviber will
          satisfy audit obligations by providing its most recent
          third-party audit report (e.g. SOC 2 Type II).
        </p>
      </section>

      <section>
        <h2>8. Personal data breach</h2>
        <p>
          [Replace] PCBviber will notify Customer without undue
          delay, and in any event within 72 hours of becoming aware,
          of any personal data breach affecting Customer's data.
          Notification will include the nature of the breach,
          categories and approximate number of affected data
          subjects, likely consequences, and measures taken or
          proposed.
        </p>
      </section>

      <section>
        <h2>9. Return or deletion</h2>
        <p>
          [Replace] On termination of the underlying agreement,
          PCBviber will, at Customer's choice, return or delete all
          personal data within 30 days, except to the extent
          retention is required by applicable law.
        </p>
      </section>

      <footer className="mt-12 border-t border-slate-200 pt-6 text-sm text-slate-500">
        <p>
          Questions? Contact{" "}
          <a
            href="mailto:legal@pcbviber.example"
            className="text-blue-700 underline"
          >
            legal@pcbviber.example
          </a>
          .
        </p>
        <p className="mt-2">
          See also: <Link to="/legal/subprocessors" className="underline">Subprocessors</Link>.
        </p>
      </footer>
    </article>
  );
}
