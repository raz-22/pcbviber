# PCBviber

MCP (Model Context Protocol) server for **live command & control of Altium
Designer**, plus Altium 365 + Octopart supply data, plus a browser UI for
engineers who'd rather click than prompt.

Connect Claude (or any MCP client) and it can see your Altium window, read
the Messages panel, open/save projects, run compile / DRC, generate
manufacturing outputs, and more — all in natural language.

## Monorepo layout

```
apps/
  server/      MCP server (stdio + HTTP transports, Fastify REST BFF, AD relay)
  web/         Vite + React + Tailwind UI
packages/
  shared/      Zod schemas + TypeScript types shared by both sides
ad-script/     AltiumRelay.js — runs inside Altium Designer (Phase 3)
SPEC.md        Phase 2 + Phase 4 implementation spec
```

## Prereqs

- Node 20+
- pnpm 9+ (`npm install -g pnpm@9`)
- Nexar API credentials from [nexar.com/api](https://nexar.com/api) (sign in with Altium Live)

## First-time setup

```powershell
pnpm install
Copy-Item .env.example .env    # fill NEXAR_CLIENT_ID and NEXAR_CLIENT_SECRET
pnpm -r build
```

Env vars are read by `apps/server` only. The browser never sees them.

## Running

### UI + BFF (recommended)

```powershell
# Terminal 1 — HTTP server (Fastify on :3000, serves /mcp and /api/*)
pnpm -F "@altium-mcp/server" start:http

# Terminal 2 — Vite dev server (:5173, proxies /api and /mcp to :3000)
pnpm -F "@altium-mcp/web" dev
```

Open `http://127.0.0.1:5173`. The server is bound to `127.0.0.1` only;
**do not expose it to the network without adding auth** (see Deployment).

### MCP stdio (for Claude Code / Desktop / Cursor)

```powershell
pnpm -F "@altium-mcp/server" start            # stdio (default)
pnpm -F "@altium-mcp/server" inspect          # MCP Inspector
```

## HTTP endpoints

`POST /mcp` speaks MCP's StreamableHTTP transport — same tools as stdio.

REST BFF (used by the UI, also usable from any HTTP client). All
data routes are tenant-scoped: pick the org + workspace via the
SPA's Settings page or the workspace CRUD endpoints, then call the
Nexar / Altium-365 routes under that workspace's id.

| Method | Path | Query / body |
|---|---|---|
| GET | `/api/health` | — |
| GET | `/api/orgs/:orgId/workspaces/:workspaceId/parts/search` | `query`, `limit` |
| GET | `/api/orgs/:orgId/workspaces/:workspaceId/parts/availability` | `mpn` |
| GET | `/api/orgs/:orgId/workspaces/:workspaceId/parts/alternatives` | `mpn`, `criteria` |
| GET | `/api/orgs/:orgId/workspaces/:workspaceId/library/components` | `altiumWorkspaceUrl?` |
| GET | `/api/orgs/:orgId/workspaces/:workspaceId/altium-365/workspaces` | — |
| GET | `/api/orgs/:orgId/workspaces/:workspaceId/altium-365/projects` | `altiumWorkspaceUrl?` |

## Tool surface

PCBviber exposes ~30 MCP tools spanning project setup, schematic, PCB layout, routing, validation, and manufacturing — most of them **cross-platform** (work on both Altium Designer and EasyEDA Pro). Highlights:

| Stage | Representative tools |
|---|---|
| Project & Library | `get_active_project`, `list_projects`, `screenshot`, `list_library_components`, `search_parts` |
| PCB Layout | `get_components`, `move_component` / `rotate_component` / `lock_component`, `place_by_group` |
| Routing | `get_net_routing`, `unroute_net`, `route_diff_pair`, `via_stitch_plane` |
| Verification | `validate_placement`, `run_drc`, `production_readiness_check` |
| Manufacturing | `export_gerbers` / `export_drill` / `export_bom` / `export_pick_and_place` |

**Full tool reference**: [`docs/tools.md`](docs/tools.md) — every tool with platform support pills (`[Both]` / `[Altium only]` / `[EasyEDA only]` / `[Both — partial]`) and notes on what's wired vs. pending.

Connect AD 24 with `ad-script/AltiumRelay.js` loaded for live Altium command & control; install the PCBviber EasyEDA Pro extension (see [`eda-script/README.md`](eda-script/README.md)) for EasyEDA workspaces. The cross-platform tools route through whichever platform the workspace is bound to.

## Professional PCB design flow (MCP prompts)

PCBviber ships three MCP **prompts** that turn the ad-hoc tool
inventory into a disciplined professional workflow. An MCP client (like
Claude Code) surfaces these as slash-commands.

| Prompt | Use when |
|---|---|
| `pcb_design_flow` | Starting a new PCB from scratch. Guides through all 9 stages: project infrastructure → managed components → schematic → physical setup → rules → placement → routing → verification → manufacturing docs. Accepts `project_name`, `board_type`, `target_layers`, `target_quantity`. |
| `pcb_project_audit` | Assessing a half-built project. Calls `pcbviber_audit_project`, interprets results, produces a prioritized fix list. Accepts a `focus` parameter (`all` / `layout` / `electrical` / `manufacturability`). |
| `pcb_dfm_review` | Final production-readiness gate. Runs the DFM checklist: fiducials, solder-mask sliver, thermal relief, silkscreen clearance, etc. Accepts `fab_capabilities` for numeric thresholds. |

### Audit tool

`pcbviber_audit_project` — the analyzer under `pcb_project_audit` — is
also available as a standalone tool. It calls all the read-only AD tools
in parallel, maps findings against the 9-stage flow, and returns:

```
{
  summary: { hasProject, projectPath, completedStages, totalStages, nextAction },
  stages:  [ { stage, name, status, observations, recommendations } × 9 ],
  raw:     { activeProject, documents, boardInfo, stackup, messages }
}
```

Stage statuses: `done`, `in_progress`, `pending`, `blocked`, `unknown`.
An `unknown` stage means PCBviber can't introspect that AD capability yet
— it's not a silent "everything's fine."

## Roadmap — capability gaps

PCBviber today covers stages 1, 2, 3 (partial), 4, 6 (partial), 9
(partial) of the pro flow. These are the Phase-4 gaps, in rough
priority order:

- **Messages panel enumeration** — `DM_MessageCount` is unavailable on
  AD 24; use `ad_debug_introspect_messages` against live AD to find
  the real API shape, then patch.
- **Design rules introspection + CRUD** — read and edit constraints
  via a script API.
- **DRC violation enumeration** — walk PCBServer.GetCurrentPCBBoard()
  for `eViolationObject` entries.
- **xSignals / length tuning** — no scripting surface currently known.
- **Variant Manager** — read/write Variant definitions.
- **Draftsman document generation** — likely scriptable via OutJob,
  needs verification.
- **Signal/Power Integrity simulation** — SI panel + Power Analyzer
  have limited script surface; may require GUI automation.
- **Ansys EDB export** — extension-dependent; investigation needed.

## Architecture

```
┌──────────────┐            ┌────────────────────────────────┐
│  Browser UI  │───────────▶│  Fastify (apps/server)         │        ┌──────────┐
│  (apps/web)  │  /api/*    │   ├─ /api/* (REST BFF)         │───────▶│  Nexar   │
│              │            │   ├─ /mcp   (MCP HTTP)         │  GQL   │  Gateway │
└──────────────┘            │   ├─ /ad-relay/* (long-poll)   │        └──────────┘
                            │   └─ stdio  (default transport)│
                            └───────────┬───────────┬────────┘
                                        │           │  HTTP long-poll
                                        ▼           ▼
                            handlers/*.ts    ┌──────────────────────┐
                            (single source   │  Altium Designer 24  │
                             of truth)       │  + AltiumRelay.js    │
                                             │  (ad-script/)        │
                                             └──────────────────────┘
```

## Deployment (Fly.io)

Dockerfile + `fly.toml` are present but **not yet deployed**. Add auth before
`fly deploy`; the server currently has no access control.

## License

MIT
