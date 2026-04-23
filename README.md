# Altium MCP

MCP (Model Context Protocol) server for Altium 365 + Octopart, plus a browser
UI for engineers who'd rather click than prompt.

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

Desktop command & control (Phase 3, requires AD24 running with
`ad-script/AltiumRelay.js` loaded): `ad_ping`, `ad_status`,
`ad_get_active_project`, `ad_open_project`, `ad_compile_project`,
`ad_run_drc`, `ad_annotate_schematic`, `ad_generate_outputs`,
`ad_auto_place`, `ad_auto_route`. See [ad-script/README.md](ad-script/README.md).

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
