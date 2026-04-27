# PCBviber EasyEDA Pro extension

In-editor extension that connects an EasyEDA Pro workspace to the
PCBviber server. Once installed and enabled, your AI assistant
(Claude / Cursor / any MCP client wired to PCBviber) can drive the
EasyEDA Pro editor: list projects, run DRC, export Gerbers, etc.

> **Status (Sprint 9 PR 9.4c)**: the extension installs, authenticates,
> and connects. **No tool handlers are wired up yet** — every command
> the server pushes resolves with `{ok: false, error: {code:
> "tool_not_implemented"}}`. Sprint 10+ adds handlers one at a time as
> each cross-platform tool lands its EasyEDA half. The connection
> bridge being live is the prerequisite.

## Install (production hostname)

1. Sign up at the PCBviber web app and create a workspace with
   `platform = EasyEDA`.
2. In **Settings → API keys**, create a key and bind it to the
   workspace you just made. Copy the key — it starts with `pcb_`.
3. Download `pcbviber-easyeda.eext` from the PCBviber web app
   (Settings → Workspaces → "Connect EasyEDA" — Sprint 9 PR 9.5).
4. In EasyEDA Pro: **Advanced → Extensions → Import**. Pick the
   `.eext` file. The PCBviber extension should appear in the list.
5. EasyEDA prompts for the **External Interactions** permission.
   Grant it — without it, the extension can't reach the PCBviber
   server.
6. The first time the extension activates, it prompts for your
   API key. Paste it. The bottom-of-editor panel should show
   "PCBviber: Connected" within a second or two.

## Install (local dev / self-hosted)

Same steps as above, but:

- **Step 3**: build the `.eext` from this repo (see "Building the
  package" below) instead of downloading a release.
- **Between step 5 and step 6**: open the extension's settings and
  set `pcbviber.apiBaseUrl` to your local backend
  (e.g. `http://localhost:3000`). Stored via `SYS_Storage`. The
  extension defaults to the production hostname; setting this
  override in storage points it elsewhere.

## Building the package

EasyEDA loads the extension as a `.eext` archive. The `.eext` is a
zip containing `extension.json`, `src/`, and any assets.

This package ships **plain JavaScript** — no TypeScript build, no
node_modules. To package it:

```sh
cd eda-script
zip -r pcbviber-easyeda.eext extension.json src/ README.md
```

That's it. Drop the resulting `.eext` into EasyEDA Pro's import
flow.

If we ever grow the extension past a few hundred lines, switch to
TypeScript with `@jlceda/pro-api-types` and a tsc → dist build.
For Sprint 9 the surface is small enough that the extra tooling
costs more than it pays.

## How it works

```
┌────────────────────┐      long-poll       ┌─────────────────────────┐
│  PCBviber server   │  /api/eda-relay/poll │ EasyEDA Pro extension   │
│  /api/eda-relay/*  │ ◄──────────────────  │  (this package)          │
│                    │                      │                          │
│  EdaRelay broker   │  ───── command ────► │  dispatches to handler   │
│  (per-workspace)   │                      │  (registry: empty today) │
│                    │                      │                          │
│                    │ ◄──── result ──────  │  posts result back       │
└────────────────────┘     /eda-relay/result└─────────────────────────┘
```

- Extension reads `apiKey` and `apiBaseUrl` from
  `eda.sys_Storage`. Prompts via `eda.sys_Dialog` if either is
  missing.
- A `eda.sys_Timer.setIntervalTimer` ticks every second and issues a
  long-poll against the server (capped at 25s server-side).
- When the server returns a command, the extension routes it
  through a handler registry. Sprint 10+ PRs populate that registry;
  today every command falls through to a `tool_not_implemented`
  result.
- Status (`Connecting`, `Connected`, `Unauthorized`, `Error`) is
  reflected in the bottom-dock panel via
  `eda.sys_PanelControl.openBottomPanel`.

## What's NOT in this PR

- The `.eext` is built ad-hoc with `zip`; no automated build job.
  When the SPA's "Connect EasyEDA" flow lands (PR 9.5), it'll
  serve the `.eext` from a `/eda-script/pcbviber-easyeda.eext`
  endpoint — that's where build-and-publish gets formalized.
- Tool handlers. The map at the top of `src/index.js` is empty;
  every command currently falls through to `tool_not_implemented`.
- Auth flows beyond the API-key paste-on-first-run. OAuth-style
  flows are out of scope for v1.

## Sources / references

- EasyEDA Pro Extension API: https://prodocs.easyeda.com/en/api/
- TypeScript types: `@jlceda/pro-api-types` (npm)
- Spike report (this repo): `docs/roadmap/sprint-9-easyeda-spike.md`
