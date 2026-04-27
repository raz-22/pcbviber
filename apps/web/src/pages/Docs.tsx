/**
 * Docs page — quickstart + tool reference.
 *
 * Public route. Same audience as the Landing: prospects evaluating
 * PCBviber and engineers configuring the MCP integration. The
 * registry submission, design-partner emails, and PH/HN posts will
 * all link here, so it has to stand on its own without the SPA
 * shell context.
 *
 * Tool list reflects what's actually registered in
 * apps/server/src/tools/*.ts. When a tool is added/removed/renamed
 * server-side, update the corresponding row here; this is the
 * canonical user-facing surface for what the integration exposes.
 *
 * Quickstart MCP-config snippets use placeholder URLs ([Replace
 * with your-deployment-host]) — the operator swaps these for the
 * real production host before linking the page from launch posts.
 */

import { Link } from "react-router-dom";

export function DocsPage() {
  return (
    <article className="mx-auto max-w-4xl px-6 py-12 text-slate-800">
      <header className="mb-10">
        <p className="text-xs font-semibold uppercase tracking-widest text-blue-600">
          Documentation
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          PCBviber MCP integration
        </h1>
        <p className="mt-3 text-base text-slate-600">
          PCBviber speaks the{" "}
          <a
            href="https://modelcontextprotocol.io"
            target="_blank"
            rel="noreferrer"
            className="text-blue-700 underline"
          >
            Model Context Protocol
          </a>
          . Drop the config snippet into your AI tool, paste your API
          key, and your assistant gets live access to Octopart pricing,
          your Altium 365 workspace, and the local Altium Designer
          relay.
        </p>
      </header>

      {/* ── Table of contents ─────────────────────────────────────── */}
      <nav className="mb-12 rounded-lg border border-slate-200 bg-slate-50 p-5 text-sm">
        <p className="font-semibold text-slate-700">On this page</p>
        <ul className="mt-2 space-y-1 text-slate-600">
          <li><a href="#quickstart" className="hover:underline">Quickstart</a></li>
          <li><a href="#tool-reference" className="hover:underline">Tool reference</a></li>
          <li className="ml-4"><a href="#tools-components" className="hover:underline">Components &amp; supply chain</a></li>
          <li className="ml-4"><a href="#tools-projects" className="hover:underline">Altium 365 projects</a></li>
          <li className="ml-4"><a href="#tools-manufacturing" className="hover:underline">Manufacturing &amp; BOM</a></li>
          <li className="ml-4"><a href="#tools-relay" className="hover:underline">Altium Designer relay</a></li>
          <li><a href="#troubleshooting" className="hover:underline">Troubleshooting</a></li>
        </ul>
      </nav>

      {/* ── Quickstart ────────────────────────────────────────────── */}
      <section id="quickstart">
        <h2 className="text-2xl font-semibold tracking-tight">Quickstart</h2>

        <Step n={1} title="Sign up + create a workspace">
          <p className="mt-2 text-sm text-slate-700">
            <Link to="/signup" className="text-blue-700 underline">
              Create an account
            </Link>
            , then go to{" "}
            <strong>Settings → Workspaces</strong>. Add a workspace
            with your Altium 365 URL (optional) and your{" "}
            <a
              href="https://nexar.com/api"
              target="_blank"
              rel="noreferrer"
              className="text-blue-700 underline"
            >
              Nexar API
            </a>{" "}
            client ID + secret. We test the credentials against Nexar
            before storing — bad credentials never get persisted.
          </p>
        </Step>

        <Step n={2} title="Create an API key">
          <p className="mt-2 text-sm text-slate-700">
            Go to <strong>Settings → API keys</strong> → Create key.
            Pick the workspace you just made as the default. Copy the
            key — it starts with <Code>pcb_</Code> and is only shown
            once.
          </p>
        </Step>

        <Step n={3} title="Drop the config into your AI tool">
          <p className="mt-2 text-sm text-slate-700">
            PCBviber speaks MCP over HTTP, so most clients reach it
            through{" "}
            <a
              href="https://github.com/geelen/mcp-remote"
              target="_blank"
              rel="noreferrer"
              className="text-blue-700 underline"
            >
              <Code>mcp-remote</Code>
            </a>
            . Paste this into your client's MCP config:
          </p>

          <CodeBlock label="Claude Desktop · ~/Library/Application Support/Claude/claude_desktop_config.json">
{`{
  "mcpServers": {
    "pcbviber": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://[Replace with your-deployment-host]/mcp",
        "--header",
        "Authorization: Bearer pcb_your_api_key_here"
      ]
    }
  }
}`}
          </CodeBlock>

          <CodeBlock label="Cursor · ~/.cursor/mcp.json">
{`{
  "mcpServers": {
    "pcbviber": {
      "url": "https://[Replace with your-deployment-host]/mcp",
      "headers": {
        "Authorization": "Bearer pcb_your_api_key_here"
      }
    }
  }
}`}
          </CodeBlock>

          <p className="mt-3 text-sm text-slate-700">
            Restart your AI tool. You should see the PCBviber tools
            available. Try asking:
          </p>
          <CodeBlock>
{`"Find me 100nF 0402 X7R caps in stock from Digi-Key or Mouser."`}
          </CodeBlock>
        </Step>
      </section>

      {/* ── Tool reference ────────────────────────────────────────── */}
      <section id="tool-reference" className="mt-16">
        <h2 className="text-2xl font-semibold tracking-tight">Tool reference</h2>
        <p className="mt-3 text-sm text-slate-600">
          Each tool's full input schema is exposed to the AI client at
          connection time, so your assistant sees argument names,
          types, and descriptions automatically. The summaries below
          are for humans skimming what's available.
        </p>
        <p className="mt-2 text-sm text-slate-600">
          Tools marked <Pill>metered</Pill> count against your plan's
          BOM-lookup quota. Tools marked <Pill kind="local">local</Pill>{" "}
          require the Altium Designer relay running on your machine.
        </p>

        {/* Components */}
        <h3 id="tools-components" className="mt-8 text-lg font-semibold">
          Components &amp; supply chain
        </h3>
        <ToolTable
          rows={[
            { name: "search_parts", desc: "Search electronic components by MPN, description, or specs. Returns stock, pricing, datasheets, and lifecycle info from Octopart/Nexar.", metered: true },
            { name: "check_part_availability", desc: "Check real-time stock and pricing for a specific MPN. Returns supplier inventory, MOQ, and pricing tiers.", metered: true },
            { name: "find_alternative_parts", desc: "Find alternative/substitute parts for a given MPN. Phase 1 uses description matching; pin-compatible cross-reference is on the roadmap.", metered: true },
            { name: "list_library_components", desc: "List all components in an Altium 365 workspace library." },
          ]}
        />

        {/* Projects */}
        <h3 id="tools-projects" className="mt-8 text-lg font-semibold">
          Altium 365 projects
        </h3>
        <ToolTable
          rows={[
            { name: "list_workspaces", desc: "List all Altium 365 workspaces the authenticated user has access to." },
            { name: "list_projects", desc: "List all projects in an Altium 365 workspace." },
            { name: "get_project_details", desc: "Get detailed info about an Altium 365 project: revision history, schematic structure, PCB configuration." },
            { name: "create_project", desc: "[Phase 2] Create a new project in an Altium 365 workspace with initial configuration." },
          ]}
        />

        {/* Manufacturing */}
        <h3 id="tools-manufacturing" className="mt-8 text-lg font-semibold">
          Manufacturing &amp; BOM
        </h3>
        <ToolTable
          rows={[
            { name: "get_project_bom", desc: "Retrieve the BOM for an Altium 365 project." },
            { name: "analyze_bom_cost", desc: "Analyze BOM cost at different production quantities." },
            { name: "export_manufacturing_data", desc: "Generate manufacturing files (Gerber, drill, pick-and-place) for a project." },
            { name: "run_drc_summary", desc: "[Stub in v1] Summarize DRC results for a project." },
            { name: "check_production_readiness", desc: "Run a production-readiness checklist for a project." },
          ]}
        />

        {/* AD relay */}
        <h3 id="tools-relay" className="mt-8 text-lg font-semibold">
          Altium Designer relay
        </h3>
        <p className="mt-2 text-sm text-slate-600">
          These tools talk to the local Altium Designer instance via
          the AltiumRelay.js script you run inside AD. They are
          local-only and never count against your BOM quota. See the
          relay README in your Altium installation for setup.
        </p>

        <h4 className="mt-4 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Diagnostics
        </h4>
        <ToolTable
          rows={[
            { name: "ad_ping", desc: "Smoke test: round-trips a ping through the relay. Returns the AD version on success.", local: true },
            { name: "ad_status", desc: "Relay connection diagnostics. Shows polling state, recent stats, queue depth.", local: true },
            { name: "ad_tail_log", desc: "Last N lines of the AltiumRelay script log.", local: true },
            { name: "pcbviber_selftest", desc: "Full diagnostic: server version, relay status, ping with latency, active project, log tail.", local: true },
          ]}
        />

        <h4 className="mt-4 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Project &amp; documents
        </h4>
        <ToolTable
          rows={[
            { name: "ad_get_active_project", desc: "Metadata about the project currently focused in AD: path, name, loaded documents, active document.", local: true },
            { name: "ad_open_project", desc: "Open a project (.PrjPcb / .PrjSch) from disk.", local: true },
            { name: "ad_new_project", desc: "Create a new empty Altium project.", local: true },
            { name: "ad_save_project", desc: "Save the active or specified project.", local: true },
            { name: "ad_list_documents", desc: "List the source documents (schematics, PCB, OutJobs, scripts) of the active project.", local: true },
          ]}
        />

        <h4 className="mt-4 text-sm font-semibold uppercase tracking-wide text-slate-500">
          PCB inspection
        </h4>
        <ToolTable
          rows={[
            { name: "ad_get_board_info", desc: "Layer count, board outline (mm), component count, net count.", local: true },
            { name: "ad_get_stackup", desc: "Ordered layer stack with name, kind, material, thickness; total stackup thickness in mm.", local: true },
            { name: "ad_screenshot", desc: "PNG screenshot of AD's main window or full virtual desktop.", local: true },
          ]}
        />

        <h4 className="mt-4 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Build &amp; verify
        </h4>
        <ToolTable
          rows={[
            { name: "ad_compile_project", desc: "Compile the project. Triggers ERC as a side effect.", local: true },
            { name: "ad_run_drc", desc: "Run Design Rule Check on the active PCB. Returns violations with rule name, location, net.", local: true },
            { name: "ad_get_messages", desc: "Current Messages-panel contents as structured entries with severity counts.", local: true },
            { name: "ad_debug_introspect_messages", desc: "Internals of the Messages panel — debug helper, not for end users.", local: true },
            { name: "ad_annotate_schematic", desc: "Run silent annotation on schematics, assigning designators in a chosen order.", local: true },
            { name: "pcbviber_audit_project", desc: "Audit the project against the 9-stage professional design flow. Returns completion status + prioritized next actions.", local: true },
          ]}
        />

        <h4 className="mt-4 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Outputs &amp; automation
        </h4>
        <ToolTable
          rows={[
            { name: "ad_generate_outputs", desc: "Run an OutJob to generate manufacturing outputs (Gerber, BOM, PDF, etc.).", local: true },
            { name: "ad_auto_place", desc: "Auto-place unplaced components. 'cluster' groups by connectivity; 'statistical' uses thermal/electrical heuristics.", local: true },
            { name: "ad_auto_route", desc: "Run Situs auto-router. Scope: 'all', 'selected', or 'net' (single named net).", local: true },
          ]}
        />
      </section>

      {/* ── Troubleshooting ───────────────────────────────────────── */}
      <section id="troubleshooting" className="mt-16">
        <h2 className="text-2xl font-semibold tracking-tight">
          Troubleshooting
        </h2>

        <h3 className="mt-6 text-base font-semibold">
          <Code>api_key_no_workspace</Code>
        </h3>
        <p className="mt-2 text-sm text-slate-700">
          Your API key isn't bound to a workspace. Open Settings → API
          keys, click your key, and set a default workspace. The key
          works as soon as you save.
        </p>

        <h3 className="mt-6 text-base font-semibold">
          <Code>workspace_not_configured</Code>
        </h3>
        <p className="mt-2 text-sm text-slate-700">
          The workspace exists but has no Nexar credentials. Open
          Settings → Workspaces, click the workspace, and add your
          Nexar client ID + secret.
        </p>

        <h3 className="mt-6 text-base font-semibold">
          <Code>quota_exceeded</Code>
        </h3>
        <p className="mt-2 text-sm text-slate-700">
          You've hit your plan's BOM-lookup quota for the current
          period. Upgrade in Settings → Billing, or wait for the next
          billing period to reset.
        </p>

        <h3 className="mt-6 text-base font-semibold">
          <Code>billing_inactive</Code>
        </h3>
        <p className="mt-2 text-sm text-slate-700">
          Your org's billing status is suspended or canceled. Settle
          the outstanding balance in Settings → Billing to restore
          access. Settings, billing, and member management remain
          accessible while data routes are blocked.
        </p>

        <h3 className="mt-6 text-base font-semibold">AD relay isn't responding</h3>
        <p className="mt-2 text-sm text-slate-700">
          Run <Code>ad_status</Code> first — it works without a live
          AD connection. If it shows the relay isn't polling, check
          that AltiumRelay.js is loaded inside Altium Designer.
          <Code>ad_tail_log</Code> returns the last log lines without
          requiring AD to be up.
        </p>
      </section>

      <footer className="mt-16 border-t border-slate-200 pt-6 text-sm text-slate-500">
        <p>
          Found a gap in this page? Email{" "}
          <a
            href="mailto:support@pcbviber.example"
            className="text-blue-700 underline"
          >
            support@pcbviber.example
          </a>
          .
        </p>
      </footer>
    </article>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-6">
      <h3 className="flex items-center gap-3 text-lg font-semibold">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-blue-600 text-sm text-white">
          {n}
        </span>
        {title}
      </h3>
      <div className="ml-10">{children}</div>
    </div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[0.85em] text-slate-800">
      {children}
    </code>
  );
}

function CodeBlock({
  label,
  children,
}: {
  label?: string;
  children: string;
}) {
  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-slate-200">
      {label && (
        <div className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs font-medium text-slate-600">
          {label}
        </div>
      )}
      <pre className="overflow-x-auto bg-slate-900 px-4 py-3 text-xs leading-relaxed text-slate-100">
        <code>{children}</code>
      </pre>
    </div>
  );
}

function Pill({
  children = "metered",
  kind = "metered",
}: {
  children?: React.ReactNode;
  kind?: "metered" | "local";
}) {
  const cls =
    kind === "local"
      ? "bg-amber-100 text-amber-800"
      : "bg-blue-100 text-blue-800";
  return (
    <span className={`rounded px-1.5 py-0.5 text-[0.7rem] font-medium ${cls}`}>
      {children}
    </span>
  );
}

function ToolTable({
  rows,
}: {
  rows: { name: string; desc: string; metered?: boolean; local?: boolean }[];
}) {
  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-slate-200">
      <table className="w-full text-sm">
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={row.name}
              className={i % 2 === 0 ? "bg-white" : "bg-slate-50"}
            >
              <td className="whitespace-nowrap px-4 py-3 align-top font-mono text-xs text-slate-800">
                {row.name}
                {row.metered && (
                  <span className="ml-2">
                    <Pill>metered</Pill>
                  </span>
                )}
                {row.local && (
                  <span className="ml-2">
                    <Pill kind="local">local</Pill>
                  </span>
                )}
              </td>
              <td className="px-4 py-3 text-slate-700">{row.desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
