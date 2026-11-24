# PCBviber

An MCP server that lets Claude, Cursor, or any MCP client work inside a live
**Altium Designer** session: read the active project, list components and
nets, run DRC, check production readiness, export manufacturing outputs, and
look up parts on Octopart.

> **Status: alpha.** The MCP server, the tool surface and the relay protocol
> are covered by automated tests. Most of the Altium-side commands were
> written against Altium's documented scripting API and have **not** yet been
> exercised on a wide range of real designs. Use it on a copy of your project,
> and please [open an issue](https://github.com/raz-22/pcbviber/issues) with
> what works and what does not. See [Verification status](#verification-status).

## Quick start

Requirements: Node.js 20+, Altium Designer 24 on Windows.

**1. Add the server to your MCP client.**

Claude Code:

```bash
claude mcp add pcbviber -- npx -y pcbviber
```

Claude Desktop / Cursor (`mcpServers` in the client's config file):

```json
{
  "mcpServers": {
    "pcbviber": { "command": "npx", "args": ["-y", "pcbviber"] }
  }
}
```

**2. Load the relay script in Altium.**

```bash
npx -y pcbviber --relay-script
```

prints the path of `AltiumRelay.js`. In Altium Designer: **File → Run Script…**,
choose *JavaScript Script*, pick that file, put the caret inside `function Main()`
and press **F9**. Details and troubleshooting: [`ad-script/README.md`](ad-script/README.md).

**3. Ask your client to call `ad_ping`.** A reply with Altium's version means
the loop is closed. Then try *"audit the active project"* or the
`pcb_project_audit` prompt.

No account, no database, no cloud: the server runs on your machine and talks
to Altium over `127.0.0.1` only.

### Optional: part data

Part search, stock, pricing and Altium 365 library tools use the
[Nexar API](https://nexar.com/api). Set these in your MCP client's `env` block
to enable them; everything else works without them.

| Variable | Purpose |
|---|---|
| `NEXAR_CLIENT_ID`, `NEXAR_CLIENT_SECRET` | Octopart / Altium 365 data |
| `ALTIUM_WORKSPACE_URL` | Your Altium 365 workspace, for `list_projects` and library tools |
| `PCBVIBER_RELAY_PORT` | Loopback port Altium polls (default `3000`; change `RELAY_URL` in `AltiumRelay.js` to match) |

## What it can do

57 tools and 3 prompts. Full reference with per-tool platform notes:
[`docs/tools.md`](docs/tools.md).

| Stage | Representative tools |
|---|---|
| Project | `get_active_project`, `ad_list_documents`, `screenshot`, `pcbviber_audit_project` |
| Parts | `search_parts`, `check_part_availability`, `find_alternative_parts`, `analyze_bom_cost` |
| Layout | `get_components`, `move_component`, `rotate_component`, `lock_component`, `place_by_group` |
| Routing | `get_net_routing`, `get_design_rules`, `unroute_net`, `route_diff_pair`, `via_stitch_plane` |
| Verification | `validate_placement`, `run_drc`, `production_readiness_check` |
| Manufacturing | `export_gerbers`, `export_drill`, `export_bom`, `export_pick_and_place` |

Prompts turn the tool list into a workflow:

| Prompt | Use when |
|---|---|
| `pcb_design_flow` | Starting a board; walks the nine stages from project setup to manufacturing docs |
| `pcb_project_audit` | Assessing a half-built project; produces a prioritized fix list |
| `pcb_dfm_review` | Final production-readiness gate against your fab's capabilities |

A tool that cannot do its job on your setup returns `supported: false` with the
reason, rather than guessing.

## How it works

```
MCP client ── stdio ──► pcbviber ◄── HTTP poll (127.0.0.1) ── AltiumRelay.js inside Altium Designer
                           │
                           └── HTTPS ──► Nexar / Octopart (optional)
```

Altium's script engine cannot open sockets or WebSockets, so the relay script
polls a loopback endpoint for commands and posts results back. The listener
binds to `127.0.0.1` and has no authentication: anything running on your
machine can reach it. Do not forward that port.

## Verification status

| Area | State |
|---|---|
| MCP server start-up, tool and prompt registration | Automated smoke test (`apps/local/test/smoke.mjs`) |
| Relay protocol: command dispatch, result round-trip, malformed input | Automated smoke test with a simulated Altium |
| Tool handlers, platform layer | Unit tests under `apps/server/src` |
| `ping` against real Altium Designer 24 | Verified during development |
| Other Altium-side commands | Written from the documented scripting API; per-command status in [`ad-script/README.md`](ad-script/README.md) |
| EasyEDA Pro | Experimental; needs the hosted server, see below |

## Repository layout

| Path | What |
|---|---|
| `apps/local` | The `pcbviber` npm package: single-user, stdio + loopback relay |
| `apps/server` | Tool handlers and the multi-tenant HTTP server |
| `ad-script` | `AltiumRelay.js`, the script that runs inside Altium Designer |
| `eda-script` | EasyEDA Pro extension (experimental) |
| `apps/web`, `packages/*` | Browser UI, auth, billing and metering for the hosted server |

The hosted, multi-user server (Postgres, SSO, browser UI, EasyEDA bridge) is
documented in [`docs/hosted-server.md`](docs/hosted-server.md). You do not need
it to use PCBviber locally.

## Development

```bash
pnpm install
pnpm -F pcbviber test     # bundles apps/local and runs the end-to-end smoke test
```

## Contributing

Reports from real boards are the most useful contribution right now: which
tool, which Altium version, what happened. Fixes to individual relay commands
in `ad-script/AltiumRelay.js` are welcome as small pull requests. See
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

MIT. PCBviber is an independent project and is not affiliated with or endorsed
by Altium.
