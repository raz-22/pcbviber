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

REST BFF (used by the UI, also usable from any HTTP client):

| Method | Path | Query |
|---|---|---|
| GET | `/api/health` | — |
| GET | `/api/parts/search` | `query`, `limit` |
| GET | `/api/parts/availability` | `mpn` |
| GET | `/api/parts/alternatives` | `mpn`, `criteria` |
| GET | `/api/library/components` | `workspaceUrl` |
| GET | `/api/workspaces` | — |
| GET | `/api/workspaces/projects` | `workspaceUrl` |

## Tool surface

Working (Phase 1): `search_parts`, `check_part_availability`,
`list_library_components`, `find_alternative_parts`, `list_workspaces`,
`list_projects`.

Stubbed (Phase 2, see [SPEC.md](SPEC.md)): `get_project_bom`,
`analyze_bom_cost`, `export_manufacturing_data`, `run_drc_summary`,
`check_production_readiness`, `get_project_details`, `create_project`.

Desktop command & control (requires AD 24 running with
`ad-script/AltiumRelay.js` loaded):

| Tool | What it does |
|---|---|
| `ad_ping` | Smoke test. Round-trips AD's version string. |
| `ad_status` | Relay diagnostics. Safe to call without AD. |
| `ad_screenshot` | **PNG of Altium's window** — Claude actually sees the pixels. Server-side via PowerShell; no relay needed. |
| `ad_get_active_project` | Current project's path, name, documents. |
| `ad_list_documents` | Enumerate schematic / PCB / OutJob / script documents. |
| `ad_get_messages` | Read the Messages panel as structured data. Filter by severity + source. |
| `ad_open_project` | Open a `.PrjPcb` / `.PrjSch` by path. |
| `ad_new_project` | Create a fresh PCB project (+ optional blank schematic). |
| `ad_save_project` | Save the active or named project. |
| `ad_compile_project` | Compile + return ERC messages. |
| `ad_run_drc` | Trigger the DRC on the active PCB. |
| `ad_annotate_schematic` | Silent annotation with configurable order. |
| `ad_generate_outputs` | Run an OutJob. |
| `ad_auto_place` / `ad_auto_route` | Altium's built-in auto-placement / Situs auto-router. |

See [ad-script/README.md](ad-script/README.md) for installing the
in-Altium half of the relay.

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
