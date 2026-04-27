/**
 * Public marketing landing page.
 *
 * Renders at `/` for anonymous visitors. App.tsx branches on auth
 * status — signed-in users see the in-app HomePage; visitors see this.
 *
 * Copy is intentionally template-y: real positioning + ICP messaging
 * is owned by Raz (per the internal design spec §9.5b). Anything
 * marked [Replace] is a placeholder; ship-blocking copy edits should
 * land before the launch posts go live.
 */

import { Link } from "react-router-dom";

export function LandingPage() {
  return (
    <div className="bg-white">
      {/* ── Hero ───────────────────────────────────────────────────── */}
      <section className="border-b border-slate-200 bg-gradient-to-b from-white to-slate-50">
        <div className="mx-auto max-w-6xl px-6 pt-16 pb-20 text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-blue-600">
            MCP server for Altium
          </p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-900 sm:text-5xl">
            Bring your BOM to your AI assistant.
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg text-slate-600">
            PCBviber gives Claude, Cursor, and any MCP-compatible AI
            tool live access to your Altium 365 workspace and Octopart
            part data — search components, check availability, and
            find alternates without leaving the conversation.
          </p>
          <div className="mt-8 flex items-center justify-center gap-3">
            <Link
              to="/signup"
              className="rounded-md bg-slate-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-slate-700"
            >
              Get started
            </Link>
            <Link
              to="/docs"
              className="rounded-md border border-slate-300 bg-white px-5 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Read the docs
            </Link>
          </div>
          <p className="mt-4 text-xs text-slate-500">
            Free during beta · No credit card required
          </p>
        </div>
      </section>

      {/* ── Features ──────────────────────────────────────────────── */}
      <section className="mx-auto max-w-6xl px-6 py-16">
        <div className="grid gap-6 md:grid-cols-3">
          <FeatureCard
            title="Live Octopart search"
            body="Search 30M+ components by MPN, manufacturer, or category. Pricing, availability, and lifecycle data come straight from distributors."
          />
          <FeatureCard
            title="Altium 365 native"
            body="Connect your Altium 365 workspace and let your AI list projects, walk libraries, and reason about real component metadata you already have."
          />
          <FeatureCard
            title="Find alternates fast"
            body="When a part is end-of-life or out of stock, get description-matched alternatives ranked by lifecycle and availability — in one tool call. Pin-compatible cross-reference matching is on the roadmap."
          />
        </div>
      </section>

      {/* ── How it works ──────────────────────────────────────────── */}
      <section className="border-y border-slate-200 bg-slate-50 py-16">
        <div className="mx-auto max-w-4xl px-6">
          <h2 className="text-center text-2xl font-semibold tracking-tight text-slate-900">
            How it works
          </h2>
          <ol className="mt-8 space-y-4 text-sm text-slate-700">
            <Step
              n={1}
              title="Sign up + create a workspace"
              body="Add your Altium 365 URL and Octopart/Nexar credentials. They're encrypted at rest, never returned to the browser."
            />
            <Step
              n={2}
              title="Drop the MCP config into your AI tool"
              body={
                <>
                  Claude Desktop, Cursor, Continue, Cline — anything
                  that speaks MCP. Copy-paste snippets are in the{" "}
                  <Link to="/docs" className="text-blue-700 underline">
                    docs
                  </Link>
                  .
                </>
              }
            />
            <Step
              n={3}
              title="Ask naturally"
              body='"Find me 100nF 0402 X7R caps in stock from the usual distributors." Your AI calls the right tool, you get a structured answer.'
            />
          </ol>
        </div>
      </section>

      {/* ── Pricing teaser ────────────────────────────────────────── */}
      <section className="mx-auto max-w-6xl px-6 py-16">
        <div className="text-center">
          <h2 className="text-2xl font-semibold tracking-tight text-slate-900">
            Simple, usage-based pricing
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-sm text-slate-600">
            Free for solo engineers and evaluation. Team plan adds
            shared workspaces, audit logs, and SSO. Enterprise is
            invoiced — talk to us.
          </p>
        </div>
        <div className="mt-10 grid gap-6 md:grid-cols-3">
          <PriceCard
            name="Starter"
            price="Free"
            blurb="For evaluation and personal projects."
            features={[
              "1 workspace",
              "100 BOM lookups / month",
              "Community support",
            ]}
          />
          <PriceCard
            name="Team"
            price="[Replace] / seat / mo"
            blurb="For working teams that ship hardware."
            features={[
              "Unlimited workspaces",
              "5,000 BOM lookups / month",
              "SSO + audit logs",
              "Email support",
            ]}
            highlighted
          />
          <PriceCard
            name="Enterprise"
            price="Talk to us"
            blurb="For regulated industries and high-volume teams."
            features={[
              "Custom limits",
              "DPA + IP allowlist",
              "Dedicated support",
              "[Replace] SLA",
            ]}
          />
        </div>
        <p className="mt-6 text-center text-xs text-slate-500">
          Plans and limits are in beta and may change. See{" "}
          <Link to="/legal/subprocessors" className="underline">
            subprocessors
          </Link>{" "}
          and the{" "}
          <Link to="/legal/dpa" className="underline">
            DPA
          </Link>
          .
        </p>
      </section>

      {/* ── Final CTA ─────────────────────────────────────────────── */}
      <section className="border-t border-slate-200 bg-white py-16">
        <div className="mx-auto max-w-3xl px-6 text-center">
          <h2 className="text-2xl font-semibold tracking-tight text-slate-900">
            Ready to try it?
          </h2>
          <p className="mt-3 text-sm text-slate-600">
            Sign up takes 30 seconds. You can have your AI calling
            Octopart on real BOMs before your coffee gets cold.
          </p>
          <Link
            to="/signup"
            className="mt-6 inline-block rounded-md bg-slate-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-slate-700"
          >
            Get started
          </Link>
        </div>
      </section>
    </div>
  );
}

function FeatureCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-6">
      <h3 className="text-base font-semibold text-slate-900">{title}</h3>
      <p className="mt-2 text-sm text-slate-600">{body}</p>
    </div>
  );
}

function Step({
  n,
  title,
  body,
}: {
  n: number;
  title: string;
  body: React.ReactNode;
}) {
  return (
    <li className="flex gap-4">
      <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-semibold text-white">
        {n}
      </span>
      <div>
        <p className="font-medium text-slate-900">{title}</p>
        <p className="mt-1 text-slate-600">{body}</p>
      </div>
    </li>
  );
}

function PriceCard({
  name,
  price,
  blurb,
  features,
  highlighted,
}: {
  name: string;
  price: string;
  blurb: string;
  features: string[];
  highlighted?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border bg-white p-6 ${
        highlighted
          ? "border-blue-500 ring-2 ring-blue-100"
          : "border-slate-200"
      }`}
    >
      <h3 className="text-base font-semibold text-slate-900">{name}</h3>
      <p className="mt-1 text-2xl font-semibold text-slate-900">{price}</p>
      <p className="mt-2 text-sm text-slate-600">{blurb}</p>
      <ul className="mt-4 space-y-2 text-sm text-slate-700">
        {features.map((f) => (
          <li key={f} className="flex gap-2">
            <span className="text-blue-600">✓</span>
            <span>{f}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
