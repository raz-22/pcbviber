# PCBviber tool reference

Canonical reference for every MCP tool the server exposes. Organized by **pipeline stage** instead of category — the natural reading order if you're building a board from scratch (project setup → schematic → layout → routing → verification → manufacturing).

Each tool's **platform support** is noted as a pill:

- **`[Both]`** — fully cross-platform; same contract on Altium and EasyEDA Pro.
- **`[Altium only]`** / **`[EasyEDA only]`** — genuine platform exclusivity OR work-in-progress on one side. Where it's WIP, the per-tool note explains what's pending.
- **`[Both — partial]`** — one side is fully wired, the other returns `supported: false` with an actionable reason. The AI client degrades gracefully via the standard cross-platform contract.

For the architectural rationale behind cross-platform support, see [`roadmap/easyeda-and-pipeline.md`](roadmap/easyeda-and-pipeline.md).

---

## 1. Project & Library

Read project state, screenshot the editor, search the parts catalog.

### `get_active_project` `[Both]`

Returns id + name + the platform's raw project payload for the currently-active project. Works across both — Altium reads via the AD relay; EasyEDA via `eda.dmt_Project.getCurrentProjectInfo()`.

### `list_projects` `[Both]`

Lists every project the workspace exposes. Altium reads from Altium 365 via Nexar (requires the workspace's Altium 365 URL be configured). EasyEDA reads via the in-editor extension's `eda.dmt_Project.getAllProjectsUuid()` walk.

### `screenshot` `[Both]`

PNG of the active EDA editor window, returned inline so the AI sees the pixels. Altium uses local PowerShell + System.Drawing; EasyEDA uses the extension's canvas-capture API.

### `list_library_components` `[Both — with LCSC enrichment on EasyEDA]`

Paginated catalog of components in the workspace's library. Altium reads `desLibrary` via Nexar; EasyEDA reads `eda.lib_Device.search()`. EasyEDA results are optionally enriched with Octopart per-distributor stock + pricing (looks up each entry by MPN/LCSC via Nexar). Pass `enrichWithLcsc: false` to skip the lookup hop.

### `search_parts` / `check_part_availability` / `find_alternative_parts` `[Both — Nexar/Octopart]`

Cloud-side parts search through Nexar's Octopart gateway. Returns stock, pricing, datasheets, lifecycle. Platform-agnostic — these query the supply chain, not the EDA.

---

## 2. Schematic

Read schematic-side state and DRC/ERC output.

### `list_schematic_components` `[EasyEDA only — AD wiring follow-up]`

Paginated read of every component on the active schematic. EasyEDA via `eda.sch_PrimitiveComponent`; Altium returns `supported: false` with a reason naming the missing AD relay command (Sprint 11 follow-up extends `AltiumRelay.js` for SchDoc walks).

### `get_messages` `[Both]`

Reads DRC/ERC/compile output from the platform's messages panel. Altium reads accumulated panel state; EasyEDA actively runs `sch_Drc.check + pcb_Drc.check` (the Pro API doesn't expose accumulated state). Same logical answer either way — "what's wrong with this design?" — but EasyEDA latency is higher because the engine runs synchronously per call.

`minSeverity` filter (default `warning`) drops info-class noise. Pass `info` to see everything.

---

## 3. PCB Layout

Read placement state and mutate component positions.

### `list_pcb_components` `[EasyEDA only — AD wiring follow-up]`

Lightweight BOM-style read: designator + footprint per component. EasyEDA via `eda.pcb_PrimitiveComponent`; Altium pending the AD relay BoardIterator/eComponentObject walk (Sprint 11 PR 11.1 ships it).

### `get_components` `[Both]`

Full placement-aware read: `{designator, mpn, footprint, x, y, layer, rotation, locked}`. Foundation for the placement write tools below. Coordinates in mm (Altium converts at the relay boundary). Layer normalized to `top|bottom|inner|unknown`.

### `move_component` / `rotate_component` / `lock_component` `[Both]`

Three primitive write tools. All address by **designator** (cross-platform stable identity). Locked components reject move/rotate; the AI must call `lock_component(false)` first to unlock. Multiple components sharing a designator → tool rejects with `"refusing to mutate ambiguously"` rather than silently mutating the first match.

### `place_by_group` `[Both]`

LLM-friendly placement helper. Filter components by an AND-joined `key=value` expression with glob support (`"footprint=0402 AND designator=R*"`), then apply a strategy (`grid` / `around-component` / `on-edge`). Locked components are obstacles, never targets. Returns `matched`/`moved`/`skipped` lists.

---

## 4. Validation & Rules

Inspect placement for collisions, read/write design rules.

### `get_keepouts` `[Both — EasyEDA pending API confirmation]`

Returns every keepout polygon on the active PCB with `kind` (placement/routing/via/all), `layer`, `vertices` (mm). Altium reads via `eRegionObject` + `IsKeepOut`. EasyEDA path uses `pcb_PrimitiveRegion` (Sprint 9 spike question #4 still open — extension returns `supported: false` cleanly when the API isn't exposed in the current Pro build).

`set_keepout` (write) is deferred to a follow-up PR pending hands-on confirmation of the EasyEDA write API.

### `validate_placement` `[Both]`

Computes overlap + spacing-rule violations across all placed components. Pure server-side computation from `get_components` data; both platforms produce bit-for-bit identical results from identical inputs. Default spacing rule: 0.2mm edge-to-edge clearance (typical IPC-7351 hand-placed). Components missing bounding-box data trigger a 1mm heuristic fallback flagged in the violation message.

### `get_design_rules` `[Both]`

All design rules on the active PCB. Each entry has `kind` (clearance/width/via/other), `scope` (all/net/net-class), and kind-specific value fields. Altium reads `Board.DesignRules`; EasyEDA reads `pcb_Drc.getCurrentRuleConfiguration()`.

### `set_route_rule` `[Both]`

Update an existing rule by name. Discriminated by `kind`: `clearance` (single mm), `width` (min/preferred/max), `via` (hole + pad diameter). EasyEDA does an internal read-modify-write (Pro API only exposes full-config writes); race-window if two callers write simultaneously, last-write-wins on the full config. Rule **creation** is deferred — `setRouteRule` errors cleanly when the named rule doesn't exist.

---

## 5. Routing

Read per-net routing state, mutate routes, run differential-pair routing, stitch via planes.

### `get_net_routing` `[Both]`

Paginated per-net summary: total trace length, layer split (mm per layer), via count, unrouted-segment count. Altium walks `BoardIterator` over `eTrackObject + eViaObject + eRatNestObject`. EasyEDA enumerates via `pcb_Net.getAll()` + per-net length/line/via reads.

### `unroute_net` `[Both]`

Deletes all traces + vias on a given net. Locked items are skipped + counted separately so the AI knows whether to unlock + retry. Net-not-found and "net has no traces" both succeed with zero-count results.

### `route_diff_pair` `[Both — best-effort]`

Triggers the platform's native differential-pair router. **Diff pair must be declared in the project first** — Altium: PCB > Design > Differential Pair Editor; EasyEDA: pair config UI. Returns a two-axis status: `supported` (tool ran) and `routed` (router laid traces). `routed: false` is NOT a tool failure — AI clients retry with adjusted layer/spacing rather than abort.

Both platforms ship as best-effort wrappers; the AD invocation strategy (`Server.DispatchDocument` → `Board.RouteNets` fallback) and EasyEDA's BETA `pcb_Document.autoRouting` shape are confirmed via live test.

### `via_stitch_plane` `[Both]`

Generates a grid of vias tied to a target net (typically `GND`) across the board area. Server-side planner reads `getComponents` + `getKeepouts` + `getNetRouting`, runs collision filtering (component bbox, keepouts, existing vias, edge clearance), then dispatches the survivor positions to the relay/extension's `create_vias` primitive. Default density 5mm, edge clearance 1.5mm. Sub-1mm density rejected as pathological.

### `xsignals_status` `[Altium only — by design]`

Reads xSignal length-tuning state. **First genuine platform-exclusivity case** — EasyEDA Pro doesn't expose xSignals/length-tuning at all; the EasyEDA implementation deliberately returns `supported: false` with a constant reason naming the architectural difference. Even with a connected bridge, the EasyEDA result is `supported: false` — pinned by test as an architectural contract.

Altium parses status from the Messages panel (best-effort regex over `xSignal NAME: N.NNmm of N.NNmm`-style entries). Pair with `run_drc` first to refresh the panel.

---

## 6. Manufacturing & Verification

Run DRC, export manufacturing files, check production readiness.

### `run_drc` `[Both]`

Trigger DRC + return structured violations. Each `DrcViolation` has `category` (Clearance/Width/etc.), `severity` (info/warning/error), `message`, optional `location` (mm), and optional `objects` (designators/nets). The result's `passed` field is `true` iff zero error-severity violations — warnings + info don't block.

Altium triggers DRC then reads the Messages panel + parses entries via the shared parser (reuses PR 10.5's `getMessages` infrastructure). EasyEDA uses `pcb_Drc.check(strict, false, true)` for verbose-error output.

### `export_gerbers` / `export_drill` / `export_bom` / `export_pick_and_place` `[Both — partial]`

Export manufacturing files. AI clients get metadata + an artifact `downloadUrl` (authed by the same workspace API key). Bytes never pass through the AI's context window.

| Path | Status |
|---|---|
| EasyEDA | Fully wired. Extension calls the appropriate `sch/pcb_ManufactureData` accessor + uploads to the server's `/api/artifacts` route. |
| Altium | Architecture wired; OutJob output-path resolution needs hands-on confirmation against an AD build. The four `Cmd*Export*` handlers in `AltiumRelay.js` throw a clear "needs hands-on wiring" error that surfaces as `supported: false` naming the EasyEDA fallback. |

The artifact store is in-memory with 1-hour default TTL, scoped to the creating org (cross-org retrieval returns 404, preventing enumeration). v1 limitation: process-singleton. Production deployment behind a load balancer needs sticky sessions OR a shared store (Redis/S3).

`export_bom` accepts `withLcsc: boolean` (EasyEDA only — Altium BOMs follow project template config).

### `production_readiness_check` `[Both]`

**Composite tool** — orchestrates DRC + manufacturing-output exports + three DFM rules (drill-aspect / copper-edge / fiducials) into a single "is this board ready for fab?" answer. Returns per-category status with severity tagging. The `ready` field is `true` iff zero error-severity checks failed; warnings (export failures, fiducial count below recommendation) surface but don't block.

Caller-tunable thresholds: `drillAspectThreshold` (default 0.4), `copperEdgeClearanceMm` (default 0.2), `minFiducials` (default 3), `boardThicknessMm` (default 1.6). DFM checks are heuristic in v1 — drill-aspect is informational only (real hole-geometry reads land in a future PR); copper-edge uses component-bbox proxy for copper presence; fiducials match `/fiducial|fid|fmark/i` patterns.

---

## Legacy Altium-only tools (pre-Sprint 9)

The legacy `ad_*` tools predate the cross-platform refactor. They still work but generally have a cross-platform replacement above; prefer the new tools for new code.

| Legacy tool | Cross-platform replacement |
|---|---|
| `ad_get_active_project` | `get_active_project` |
| `ad_screenshot` | `screenshot` |
| `ad_get_messages` | `get_messages` (PR 10.5 removed `ad_get_messages`) |
| `ad_run_drc` | `run_drc` (PR 13.2 removed `ad_run_drc`) |
| `ad_generate_outputs` | `export_gerbers` / `export_drill` / `export_bom` / `export_pick_and_place` |

Still-relevant Altium-specific tools without a cross-platform equivalent:

| Tool | Purpose |
|---|---|
| `ad_ping` / `ad_status` / `ad_tail_log` / `pcbviber_selftest` | Relay diagnostics |
| `ad_open_project` / `ad_new_project` / `ad_save_project` | Project lifecycle (opening / creating / saving `.PrjPcb` files) |
| `ad_list_documents` | Enumerate schematic / PCB / OutJob / script documents |
| `ad_get_board_info` / `ad_get_stackup` | PCB-level metadata reads |
| `pcbviber_audit_project` | Composite read-only audit against the 9-stage flow |
| `ad_debug_introspect_messages` | Diagnostic for when DRC enumeration breaks |
| `ad_compile_project` | Run AD's compile (ERC) |
| `ad_annotate_schematic` | Silent annotation with configurable order |
| `ad_auto_place` / `ad_auto_route` | Built-in auto-place + Situs auto-router |

## Legacy Phase 2 stubs (deprecated)

The Nexar-only Phase 2 stubs in `manufacturing.ts` (`get_project_bom`, `analyze_bom_cost`, `export_manufacturing_data`, `run_drc_summary`, `check_production_readiness`) predate the cross-platform infrastructure and operate against Altium 365 cloud only. They're superseded by:

- **`production_readiness_check`** instead of `check_production_readiness` — the new composite is cross-platform and uses the structured DRC + DFM checks rather than a Nexar query.
- **`export_*`** family instead of `export_manufacturing_data` — actually wired to the platforms' output systems instead of returning a mock URL.
- **`run_drc`** instead of `run_drc_summary` — returns structured violations vs. a summary pass/fail.

These remain registered but should be considered candidates for removal in a future PR.

---

## Architectural notes

- **Cross-platform contract**: every tool registered in `platform.ts` returns `PlatformResponse<T>` — either `{supported: true, data: T}` or `{supported: false, reason: string}`. AI clients degrade gracefully via the `supported: false` branch — same path for "tool not built yet on this platform" and for "deliberate exclusivity".
- **Shared algorithms**: where both platforms compute the same answer from the same data, the logic lives in a shared module (`platforms/placement-validation.ts`, `place-by-group.ts`, `via-stitching.ts`, `drc.ts`, `production-readiness.ts`). Both platforms call the same function — results are bit-for-bit identical.
- **Defensive extraction**: every relay/extension response goes through defensive shape extraction. BETA APIs from EasyEDA Pro may shift across versions; multi-fallback parsing keeps tools usable across the variation. Unparseable entries surface in `raw` for AI debugging rather than crashing the call.
