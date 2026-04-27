/**
 * Terms of Service.
 *
 * ⚠ THIS IS A SCAFFOLD, NOT LEGAL TEXT.
 *
 * Standard SaaS ToS structure: account/eligibility, acceptable use,
 * fees + cancellation, IP, warranties + disclaimers, liability cap,
 * indemnification, governing law, changes. The body of each section
 * is a placeholder calling out what content needs to live there.
 * Before the SPA goes to public traffic, the operator MUST replace
 * placeholders with text reviewed by counsel.
 *
 * Public route — no auth required. Linked from signup ("by signing
 * up you agree to…") and from the global footer.
 */

import { Link } from "react-router-dom";

export function TermsPage() {
  return (
    <article className="mx-auto max-w-3xl px-6 py-12 text-slate-800 [&_h2]:mt-8 [&_h2]:mb-3 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_p]:my-3 [&_p]:leading-7 [&_section]:mt-2 [&_ul]:my-3 [&_ul]:ml-6 [&_ul]:list-disc [&_li]:my-1">
      <header className="mb-8">
        <p className="text-xs uppercase tracking-wide text-rose-700 font-medium">
          Draft template — replace with text reviewed by counsel
          before opening to public traffic
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          Terms of Service
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Last updated:{" "}
          <time dateTime="2026-04-27">April 27, 2026</time>
        </p>
      </header>

      <section>
        <h2>1. Agreement</h2>
        <p>
          [Replace] These Terms govern your access to and use of
          the PCBviber service ("Service"). By creating an account
          or using the Service, you agree to these Terms. If you
          are using the Service on behalf of an organization, you
          represent that you have authority to bind that
          organization, and "you" refers to both you individually
          and that organization.
        </p>
      </section>

      <section>
        <h2>2. Eligibility and accounts</h2>
        <p>
          [Replace] You must be at least 16 years old to use the
          Service. You are responsible for maintaining the
          confidentiality of your credentials and for all activity
          on your account. Notify us immediately of any
          unauthorized use.
        </p>
      </section>

      <section>
        <h2>3. Acceptable use</h2>
        <p>You agree not to:</p>
        <ul>
          <li>Use the Service to violate any applicable law.</li>
          <li>
            Attempt to reverse-engineer, scrape at unreasonable
            volume, or interfere with the Service's operation.
          </li>
          <li>
            Submit content that infringes a third party's
            intellectual-property or privacy rights.
          </li>
          <li>
            Resell, sublicense, or expose the Service to third
            parties as a stand-alone product without our written
            agreement.
          </li>
          <li>
            Use the Service to send spam, malware, or any
            unsolicited communications.
          </li>
        </ul>
        <p>
          We may suspend or terminate accounts that violate this
          section, with notice when reasonably possible.
        </p>
      </section>

      <section>
        <h2>4. Fees, billing, and cancellation</h2>
        <p>
          [Replace] Free-tier accounts are available without
          charge subject to the quotas published on the pricing
          page. Paid plans are billed monthly or annually in
          advance. Stripe processes payments on our behalf. You
          may cancel at any time from Settings → Billing;
          cancellation takes effect at the end of the current
          billing period and we do not refund partial periods
          except where required by law.
        </p>
        <p>
          [Replace] We may change pricing with at least 30 days'
          notice to active subscribers. Continued use after the
          notice period constitutes acceptance.
        </p>
      </section>

      <section>
        <h2>5. Your content</h2>
        <p>
          [Replace] You retain ownership of the data you submit
          ("Customer Content"). You grant us a limited license to
          process Customer Content solely to provide the Service
          and as described in our{" "}
          <Link to="/legal/privacy" className="text-blue-700 underline">
            Privacy Policy
          </Link>
          . We do not train AI models on Customer Content.
        </p>
      </section>

      <section>
        <h2>6. Our intellectual property</h2>
        <p>
          [Replace] The Service, including all software,
          documentation, designs, and trademarks, is owned by
          PCBviber and licensed to you under these Terms. We grant
          you a non-exclusive, non-transferable, revocable license
          to use the Service while your account is in good
          standing.
        </p>
      </section>

      <section>
        <h2>7. Third-party services</h2>
        <p>
          [Replace] The Service integrates with third-party
          services (Octopart/Nexar, Altium 365, Stripe, etc.).
          Your use of those services is governed by their own
          terms; we are not responsible for their availability,
          accuracy, or actions. Component data returned from
          Octopart/Nexar is provided "as-is"; you are responsible
          for verifying part availability and pricing before
          relying on it for procurement decisions.
        </p>
      </section>

      <section>
        <h2>8. Warranties and disclaimers</h2>
        <p>
          [Replace] THE SERVICE IS PROVIDED "AS-IS" AND "AS
          AVAILABLE." TO THE MAXIMUM EXTENT PERMITTED BY LAW, WE
          DISCLAIM ALL WARRANTIES, EXPRESS OR IMPLIED, INCLUDING
          MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND
          NON-INFRINGEMENT. WE DO NOT WARRANT THAT THE SERVICE
          WILL BE UNINTERRUPTED, ERROR-FREE, OR THAT DATA RETURNED
          FROM THIRD-PARTY SOURCES IS ACCURATE OR COMPLETE.
        </p>
      </section>

      <section>
        <h2>9. Limitation of liability</h2>
        <p>
          [Replace] TO THE MAXIMUM EXTENT PERMITTED BY LAW, OUR
          TOTAL LIABILITY ARISING OUT OF OR RELATING TO THESE
          TERMS WILL NOT EXCEED THE FEES YOU PAID US IN THE
          TWELVE MONTHS PRECEDING THE EVENT GIVING RISE TO THE
          CLAIM (OR USD 100 IF YOU ARE ON A FREE PLAN). WE WILL
          NOT BE LIABLE FOR INDIRECT, INCIDENTAL, SPECIAL,
          CONSEQUENTIAL, OR PUNITIVE DAMAGES.
        </p>
      </section>

      <section>
        <h2>10. Indemnification</h2>
        <p>
          [Replace] You agree to defend, indemnify, and hold us
          harmless from any third-party claim arising from your
          violation of these Terms, your Customer Content, or
          your use of the Service in breach of applicable law.
        </p>
      </section>

      <section>
        <h2>11. Termination</h2>
        <p>
          [Replace] You may terminate your account at any time.
          We may suspend or terminate your account for material
          breach of these Terms with reasonable notice. On
          termination, your access stops immediately. We retain
          and delete your data per our{" "}
          <Link to="/legal/privacy" className="text-blue-700 underline">
            Privacy Policy
          </Link>{" "}
          and{" "}
          <Link to="/legal/dpa" className="text-blue-700 underline">
            DPA
          </Link>
          .
        </p>
      </section>

      <section>
        <h2>12. Governing law and disputes</h2>
        <p>
          [Replace — counsel must select governing-law clause
          appropriate to entity domicile.] These Terms are governed
          by the laws of [Replace jurisdiction], without regard to
          conflict-of-laws principles. Disputes will be resolved
          in the courts of [Replace venue], and you consent to
          exclusive jurisdiction there.
        </p>
      </section>

      <section>
        <h2>13. Changes to these Terms</h2>
        <p>
          [Replace] We may update these Terms from time to time.
          For material changes, we will notify registered users by
          email at least 30 days before the change takes effect.
          Your continued use after that date constitutes
          acceptance.
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
          See also:{" "}
          <Link to="/legal/privacy" className="underline">
            Privacy Policy
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
