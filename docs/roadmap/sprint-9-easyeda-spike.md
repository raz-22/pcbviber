# Sprint 9 PR 9.1 — EasyEDA Pro Extension API spike

**Status**: desk-research spike. Two parallel research passes against
the public docs at `prodocs.easyeda.com`, the published TypeScript
types `@jlceda/pro-api-types` v0.2.30, and 5 representative
community extensions on GitHub. Items requiring an actual EasyEDA
Pro account to verify are flagged `[NEEDS HANDS-ON]`.

**Recommendation**: **Proceed with the in-editor extension as the
EasyEDA integration path.** The API is more capable than the v1
roadmap assumed, distribution mechanics are real, and a precedent
extension (`FrancoisTaisne/ai_eda`) already does exactly the
WebSocket-to-our-backend pattern we'd build.

## Why this spike exists

The roadmap committed to "in-editor extension" as the EasyEDA path
(over file-import, reverse-engineered REST, or browser automation).
This PR's job is to verify that commitment holds up against the
actual published API surface — not to merge code. The deliverables
are:

1. A concrete mapping from every PCBviber pipeline-stage tool to
   the EasyEDA Pro API method that implements it.
2. Verification that the sandbox lets us reach our backend and
   maintain a long-poll-equivalent bridge.
3. An honest list of risks and open questions before Sprint 9 PR
   9.2 (which adds the workspace platform model and starts shipping
   real code).

No code lands in this PR — it's a markdown doc plus a decision.

## What the API actually looks like

### Runtime model

Each extension is an independent JS scope, loaded when the editor
opens, declaring `activationEvents` in its `extension.json` manifest.
All API calls go through global classes auto-instantiated under
`eda.*`, namespaced into 6 groups:

| Namespace | Purpose |
|---|---|
| `sys_*` | OS / runtime — HTTP, WebSocket, timers, storage, dialogs, iframes, panels, file save |
| `dmt_*` | Document management — projects, schematics, PCBs, library docs, editor tabs |
| `sch_*` | Schematic objects + DRC + manufacture |
| `pcb_*` | PCB objects + DRC + manufacture |
| `pnl_*` | Panel (multi-board) primitives |
| `lib_*` | Library access — devices, symbols, footprints, 3D models |

Call shape (verbatim from docs):

```ts
import { ESYS_ToastMessageType } from '@jlceda/pro-api-types';

eda.sys_ToastMessage.showMessage(
  eda.sys_I18n.text('Done'),
  ESYS_ToastMessageType.INFO,
);
```

Source: <https://prodocs.easyeda.com/en/api/guide/invoke-apis.html>.

### TypeScript types — `@jlceda/pro-api-types`

Verified package identity (npm registry):

| Field | Value |
|---|---|
| npm name | `@jlceda/pro-api-types` |
| Latest version | **0.2.30** |
| Last published | **2026-04-14** (two weeks ago at time of writing) |
| Maintainer | `yanranxiaoxi` (also publishes `easyeda/InteractiveHtmlBom`; treat as JLCEDA-affiliated single-developer publish) |
| Artifact | Single bundled `index.d.ts`, 20,218 lines, ambient `declare global` |
| License | Apache-2.0 |
| Repository field | **not set** (bus-factor risk — flagged below) |

Two ancillary packages exist for development (per docs):
- `@jlceda/pro-api-types` — type defs (this one)
- `pro-api-sdk` — SDK helpers (https://github.com/easyeda/pro-api-sdk,
  last push 2026-04-23)

### Sandbox model

The sandbox is **moderately permissive once granted**, restrictive
by default. From the type definition's own JSDoc:

| Capability | Surface | Conditions |
|---|---|---|
| HTTP | `eda.sys_ClientUrl.request(url, method, data, options, callback): Promise<Response>` | (a) target site must enable CORS; (b) user must enable extension's "External Interactions" permission, else throws `Error` |
| WebSocket | `eda.sys_WebSocket.register/send/close` | Same External-Interactions gate |
| Persistent KV | `eda.sys_Storage.{get,set,delete,getAll,setAll,clear}ExtensionUserConfig` | Always allowed; per-extension scoped |
| Local files | `eda.sys_FileSystem.saveFile(file, defaultName)` (save dialog) | No silent write — user picks location |
| Document files | `eda.sys_FileManager.{getDocumentFile,getProjectFile,getFootprintFileByFootprintUuid,setDocumentSource,...}` | Within EasyEDA's document system only |
| Custom UI | Three mechanisms: `SYS_IFrame` (HTML/JS), `SYS_PanelControl` (dock panels), `SYS_Dialog` (info/confirm/input/select) | Always allowed |
| Background timers | `SYS_Timer.setIntervalTimer(id, timeoutMs, callbackFn, args)` and `clearIntervalTimer(id)` | Always allowed; concrete throttle limits `[NEEDS HANDS-ON]` |

The "External Interactions" permission is a one-time toggle in the
extension manifest plus a runtime user grant. It's the same model as
Chrome extension hostPermissions — friction at install, transparent
afterwards.

**Real-world precedent — `FrancoisTaisne/ai_eda`** (last commit
2026-02-20): a Python `bridge_server.py` listens on `localhost:8787`;
the in-EDA plugin reads an auth token and connects via
`SYS_WebSocket` to the local bridge. This confirms WebSocket egress
to a non-EasyEDA host works once External Interactions is granted.
This is exactly the architecture PCBviber's extension would use,
except connecting to our cloud backend instead of localhost.

Source: <https://github.com/FrancoisTaisne/ai_eda>.

## Concrete tool mapping by pipeline stage

The roadmap (post-amendment #50) requires every tool to be
platform-agnostic — `get_components(platform)` not
`easyeda_get_components`. The table below maps each PCBviber tool to
both the existing Altium implementation and the corresponding
EasyEDA implementation, so Sprint 11+ PRs land cross-platform from
day one.

### Pipeline 1 — Ideation / architecture

LLM-structured-output only. No EDA tool involved at this stage. Both
platforms identical (`propose_architecture`, `architecture_to_skeleton`,
etc., land in Sprint 15 unchanged).

### Pipeline 3 — Schematic introspection (read)

| Tool | Altium (existing) | EasyEDA (proposed) |
|---|---|---|
| `list_projects(platform)` | `ad_get_active_project` + Nexar `desWorkspaces` | `eda.dmt_Project.getAllProjectsUuid()` + `getProjectInfo()` per uuid |
| `get_active_project(platform)` | `ad_get_active_project` | `eda.dmt_Project.getCurrentProjectInfo()` |
| `list_schematic_components(platform)` | `ad_list_documents` + per-doc parse `[gap today]` | `eda.sch_PrimitiveComponent.getAll()` |
| `get_pin_connections(platform, designator)` | `[gap today]` | `eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(primitiveId)` |
| `get_netlist(platform)` | `[gap today]` | `eda.sch_Netlist.getNetlist(type)` (BETA) |
| `get_messages(platform)` | `ad_get_messages` | `eda.sch_Drc.check(strict, ui, includeVerboseError=true)` returns `Promise<Array<any>>` |

### Pipeline 5 — Placement (Sprint 11)

| Tool | Altium (Sprint 11) | EasyEDA (Sprint 11) |
|---|---|---|
| `screenshot(platform)` | exists as `ad_screenshot` | `[NEEDS HANDS-ON]` — likely via canvas capture inside extension or `SYS_IFrame` overlay; existing `easyeda/eext-pad-fanout` reads selected pads visually so the surface exists |
| `get_components(platform)` | new — DelphiScript `BoardIterator` over `eComponentObject` | `eda.pcb_PrimitiveComponent.getAll()` returns `Array<{primitiveId, position, rotation, layer, locked, ...}>` (exact field set `[NEEDS HANDS-ON]` against types) |
| `move_component(platform, designator, x, y)` | new — `Component.SetState_XLocation` / `SetState_YLocation` | `eda.pcb_PrimitiveComponent.modify(primitiveId, property)` |
| `rotate_component(platform, designator, deg)` | new — `Component.SetState_Rotation` | same `modify(...)` |
| `lock_component(platform, designator, locked)` | new — `Component.SetState_Locked` | same `modify(...)` |
| `get_keepouts(platform)` | new | `[NEEDS HANDS-ON]` — `PCB_PrimitiveRegion` is the likely carrier, not yet enumerated in docs |
| `set_keepout(platform, region)` | new | same |
| `validate_placement(platform)` | computed locally from `get_components` | computed locally from `get_components` |
| `place_by_group(platform, filter, strategy)` | helper over the primitives above | helper over the primitives above |

### Pipeline 6 — Routing (Sprint 12)

| Tool | Altium (Sprint 12) | EasyEDA (Sprint 12) |
|---|---|---|
| `get_net_routing(platform, net)` | new — iterate `eTraceObject` + `eViaObject` per net | `eda.pcb_PrimitiveLine.getAll(net)`, `eda.pcb_PrimitiveVia.getAll(net)`, `eda.pcb_Net.getNetLength(net)` |
| `list_design_rules(platform)` | new — `DM_DesignRules` | `eda.pcb_Drc.getCurrentRuleConfiguration()` |
| `set_route_rule(platform, rule)` | new — `DM_DesignRules` setters | `eda.pcb_Drc.overwriteCurrentRuleConfiguration(...)` + `createNetClass`, `addNetToNetClass`, `overwriteNetRules` |
| `unroute_net(platform, net)` | new — delete traces matching net | `eda.pcb_PrimitiveLine.delete(primitiveIds)` |
| `route_diff_pair(platform, posNet, negNet)` | new — DXP "Interactive Differential Pair Routing" | `eda.pcb_Drc.*` differential-pair group methods + `pcb_Document.autoRouting(props)` (BETA) |
| `via_stitch_plane(platform, net, density)` | new — generate vias on grid | `eda.pcb_PrimitiveVia.create(net, x, y, ...)` in a loop |
| `xsignals_status(platform)` | best-effort — Messages-panel parse | **`{supported: false, reason: "EasyEDA does not expose xSignals/length-tuning state"}`** — confirmed gap |

### Pipeline 7 — Verification (Sprint 13)

| Tool | Altium (Sprint 13) | EasyEDA (Sprint 13) |
|---|---|---|
| `run_drc(platform)` | exists as `ad_run_drc` (trigger only) | `eda.pcb_Drc.check(strict, userInterface, includeVerboseError=true): Promise<Array<any>>` (BETA — return shape is `any`; `[NEEDS HANDS-ON]` to confirm structured fields) |
| `enumerate_drc_violations(platform)` | new — Messages-panel parse | same `check(...)` call with verbose=true |
| `run_erc(platform)` | exists | `eda.sch_Drc.check(...)` — same shape as PCB DRC |

The DRC-violation-enumeration win is the biggest research-pass
finding. The agent confirms `pcb_Drc.check` with `includeVerboseError=true`
returns a structured array — not just a boolean pass/fail. That
removes what would otherwise be the gnarliest item in Sprint 13.

### Pipeline 8 — Manufacturing outputs (Sprint 13)

| Tool | Altium (Sprint 13) | EasyEDA (Sprint 13) |
|---|---|---|
| `export_gerbers(platform)` | exists as `ad_generate_outputs` (OutJob) | `eda.pcb_ManufactureData.getGerberFile(fileName, colorSilkscreen, unit, digitalFormat, other, layers, objects): Promise<File>` (BETA) |
| `export_drill(platform)` | OutJob | `eda.pcb_ManufactureData.getDsnFile()` / `getIdxFile()`; full Excellon `[NEEDS HANDS-ON]` |
| `export_pick_and_place(platform)` | OutJob | `eda.pcb_ManufactureData.getPickAndPlaceFile(fileName, fileType, unit)` |
| `export_bom(platform, withLcsc=true)` | new | `eda.sch_ManufactureData.getBomFile(fileName, fileType, template, filterOptions, statistics, property, columns, assemblyVariantsConfig)` (BETA) — LCSC fields via `columns` parameter |
| `production_readiness_check(platform)` | helper | helper |

`getGerberFile()` returns a browser `File` object, not a path. The
extension hands it to `eda.sys_FileSystem.saveFile(gerberFile, 'Gerber.zip')`
for user save, OR uploads it to our backend via
`eda.sys_ClientUrl.request(url, 'POST', file, ...)`. **Latter is
what we want** — the AI client never sees the file content; the
PCBviber backend stores the artifact and returns a URL the AI can
reference downstream.

### Pipeline 4 — Library access (Sprint 10)

| Tool | Altium (existing) | EasyEDA (Sprint 10) |
|---|---|---|
| `list_library_components(platform)` | exists via Nexar `desComponents` | `eda.lib_Device.search(key, libraryUuid, classification, symbolType, itemsOfPage, page)` |
| `get_component_by_lcsc(lcsc_id)` | n/a | `eda.lib_Device.getByLcscIds(lcscIds, libraryUuid, allowMultiMatch)` — direct, first-class |
| `get_3d_model(platform, modelUuid)` | n/a | `eda.lib_3DModel.get(modelUuid, libraryUuid)` |

`getByLcscIds()` is a direct first-class call from the extension
into the EasyEDA library. Combined with `eda.sch_ManufactureData.placeComponentsOrder(interactive, ignoreWarning)`,
this gives a path for one-click LCSC-to-JLC ordering that's tighter
than anything Altium has today. **Worth highlighting in the Sprint
14 (JLCPCB ordering) plan** — `placeComponentsOrder` may obviate
some of the JLCPCB-API-direct work.

## Distribution

| Mechanism | Source | Use |
|---|---|---|
| Marketplace | <https://ext.easyeda.com> (global) / <https://ext.lceda.cn> (China) | Once we publish, primary discovery path |
| Manual import | EasyEDA → Advanced → Extensions → Import | Early-adopter / preview / beta-tester path |
| Package format | `.eext` (zip with `extension.json`, icon, README, dist code) | Both paths use this |

`extension.json` required fields:
- `name` (5–30 chars, lowercase / digits / hyphens)
- `uuid` (32-char)
- `displayName`
- `version` (semver)
- `publisher`

Optional we'd care about:
- `engines.eda` (semver range — pin our min API version, e.g. `^2.3.0`)
- `headerMenus` (per-context: home / blank / sch / symbol / pcb / footprint / pcbView / panel / panelView)
- `activationEvents`
- `repository`, `homepage`, `bugs`

Source: <https://prodocs.easyeda.com/en/api/guide/extension-json.html>.

## Auth / how the extension talks to PCBviber

**Recommended pattern**: WebSocket connection from `SYS_WebSocket`
to our backend, mirroring the AD relay's HTTP long-poll architecture
but using a real WS instead. Concrete:

1. User installs the PCBviber EasyEDA extension. On first launch, the
   extension prompts via `SYS_Dialog.showInputDialog` for an API key
   — same `pcb_*` key shape we already use for AD relay + MCP.
2. Extension stores the key via `SYS_Storage.setExtensionUserConfig('apiKey', ...)`.
3. Extension calls `SYS_WebSocket.register('pcbviber', 'wss://[host]/eda-relay/ws',
   onMessage, onConnected, ['Bearer.<token>'])` — using the `protocols`
   parameter to smuggle the bearer token (the standard pattern the
   browser WS API forces).
4. Our backend authenticates the WS handshake via the
   subprotocol; from there, JSON messages flow both directions.
5. AI client calls `screenshot(platform="easyeda")` → MCP server
   sends `{type: "screenshot", reqId}` over the WS → extension
   captures the canvas, base64-encodes, sends back over WS → MCP
   server returns to the AI client.

**Why WebSocket and not HTTP**: `SYS_ClientUrl.request` requires CORS
on our origin AND the External Interactions permission. WS only
requires External Interactions. Both work, but WS avoids the CORS
preflight surface entirely and is the right shape for a bidirectional
command channel.

**Auth caveat `[NEEDS HANDS-ON]`**: subprotocol-as-bearer is a
common but not universal pattern. If the browser strips/normalizes
the value, fall back to a server-side challenge: WS connects with
no auth, sends `{type: "auth", token}` as first message, server
closes the connection if invalid.

## Risks

Listed in rough order of how likely each is to bite Sprint 9–13.

1. **`@beta` markers everywhere.** `pcb_Drc.check`, `getGerberFile`,
   `getNetlist`, `getAllSchematicsInfo`, `getPrimitivesInRegion`,
   most `autoLayout` / `autoRouting` calls — all `@beta` in the
   types. Behavior may change between EasyEDA Pro releases without
   semver respect. **Mitigation**: pin to a specific `@jlceda/pro-api-types`
   version in our build; gate the extension's `engines.eda` to a
   tested min version; subscribe to the GitHub repos for change
   visibility.
2. **DRC violation return shape is `Array<any>`.** The fact that
   `check(verbose=true)` returns an array is great; the lack of a
   typed entry shape means the structure has to be discovered
   empirically. **Mitigation**: Sprint 13 PR for `enumerate_drc_violations`
   includes a hands-on schema-discovery step before tool implementation.
3. **External Interactions permission is install-time friction.**
   Users must toggle a permission in the extension manager before
   the WebSocket can connect. **Mitigation**: SPA install flow shows
   a screenshot of the toggle; first-run dialog inside the extension
   reminds the user if egress fails.
4. **Single-maintainer types package, no public source repo.**
   `@jlceda/pro-api-types` is published from one personal npm
   account; `repository` field is empty. If that maintainer
   disappears, we're frozen on whatever version we have. **Mitigation**:
   vendor the `index.d.ts` into our repo at known-good version;
   re-import on each upgrade after smoke-testing.
5. **Some methods marked `@internal`.** `copyProject`, `deleteProject`,
   and a handful of others exist in types but are explicitly
   internal — may be removed without notice. **Mitigation**: don't
   call them. They're not on our roadmap anyway.
6. **No documented localhost blocklist** but no confirmation of
   localhost being allowed either. The `ai_eda` precedent shows it
   works for at least one developer; different EasyEDA Pro
   environments may differ. **Mitigation**: PCBviber backend is
   public (production hostname); localhost only matters for our own
   dev environment.

## Decision

**Proceed.** The path the v1 roadmap committed to (in-editor
extension, not file-import or REST reverse-engineering) is fully
viable. The API surface covers every pipeline stage we plan, with
better DRC-enumeration capability than expected. The
WebSocket-to-backend pattern has a working precedent in the wild.
Sprint 9 PR 9.2 (workspace platform model) starts shipping real
code.

## Open questions for hands-on validation

These are the items I genuinely cannot answer from public sources.
None of them block Sprint 9 PR 9.2; all should be answered during
Sprint 9 PRs 9.3–9.5 when the extension scaffolding is being built
and tested against a real EasyEDA Pro install.

1. **Subprotocol-as-bearer-token works?** If not, fall back to
   `{type: "auth"}` first message.
2. **Background `SYS_Timer.setIntervalTimer` throttle ceiling?** We
   need it to fire at ~5s intervals for keepalive; if EasyEDA caps
   intervals after the editor backgrounds, plan for it.
3. **`pcb_Drc.check(verbose=true)` return shape?** Array of what?
   Need to see real output to design `enumerate_drc_violations`.
4. **`pcb_PrimitiveComponent.getAll()` return field set?** The
   types declare `Array<I_PrimitiveComponent>` but the position /
   rotation / lock fields' exact names need confirmation.
5. **`SYS_FileSystem.saveFile` vs upload-via-WebSocket for Gerber
   output**? The latter is preferred but file size limits over WS
   may force the former. Probably fine up to ~10 MB.
6. **Extension reload on project switch?** If the extension's state
   resets every time the user opens a different project, the WS
   connection re-handshakes — fine, but we need to design for it.
7. **CORS on `eda.sys_ClientUrl.request` to our backend?** WebSocket
   sidesteps this, but if we ever want a one-shot HTTP call (e.g.
   for the API key validation), we need CORS configured on the
   server.

## Cross-platform validation plan for downstream sprints

Per the roadmap amendment (#50), every PR in Sprints 11+ must add a
tool that works on both Altium AND EasyEDA. The mapping table above
gives us, for each tool, a concrete EasyEDA API call to wire up.
Sprint 9 PR 9.3 will lock these mappings into the `Platform`
interface so subsequent PRs can't drift.

For tools where EasyEDA's surface is genuinely missing (xSignals
being the only confirmed one so far), the `{supported: false,
reason: ...}` contract from the roadmap kicks in.

## Sources

- EasyEDA Pro API guide: <https://prodocs.easyeda.com/en/api/guide/>
- EasyEDA Pro API reference (per-class pages): <https://prodocs.easyeda.com/en/api/reference/pro-api.html>
- TypeScript types: <https://www.npmjs.com/package/@jlceda/pro-api-types>
  (v0.2.30, 2026-04-14, Apache-2.0, single bundled `index.d.ts`)
- SDK helpers: <https://github.com/easyeda/pro-api-sdk>
- Marketplace: <https://ext.easyeda.com>
- Reference extensions:
  - <https://github.com/FrancoisTaisne/ai_eda> — WebSocket-to-localhost
    bridge precedent (the architectural pattern we'd reuse)
  - <https://github.com/biosshot/easyeda-copilot> — NL→schematic
    extension confirming External Interactions permission flow
  - <https://github.com/easyeda/eext-circuitjs1-simulator> — IFrame
    + postMessage UI pattern
  - <https://github.com/easyeda/eext-pad-fanout> — pure-local
    PCB-write extension, no network
  - <https://github.com/easyeda/eext-knowledge-base> — RAG-in-iframe
    pattern
