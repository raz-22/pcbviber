# Roadmap: EasyEDA Online + end-to-end pipeline tooling

**Status**: proposal, not committed. Drafted 2026-04-27 as the post-Sprint-8
direction. Read alongside `SPEC.md` (which sets the v1 contract) and
`the internal design spec` §7 (which closed Sprint 8).

## Vision

A PCB engineer types into Claude / Cursor in plain English and walks the
full pipeline — ideation → architecture → schematic → BOM → placement →
routing → verification → manufacturing → ordering → bring-up — without
leaving the conversation. **Every step is an MCP tool.** PCBviber works
across both **Altium** (today) and **EasyEDA Online** (target), with a
unified tool surface that hides the platform difference where the
semantics overlap.

## Architectural commitments

These shape every sprint below; not negotiable inside the roadmap.

1. **Visual verification is built in.** Every layout-modifying tool ships
   alongside a paired screenshot tool the AI can call to verify the
   change visually — `ad_screenshot` exists today; EasyEDA gets
   `easyeda_screenshot` in Sprint 10. The expectation is the AI calls
   "do thing → screenshot → reason about screenshot → next thing" as a
   default loop, not as an opt-in.
2. **Read-before-write.** Every write tool has a corresponding read tool
   for the same data. The AI must be able to enumerate state before
   modifying it. Several P&R gaps below are write-only today (e.g.
   `ad_auto_place` mutates without exposing per-component read); we fix
   that before adding more write tools.
3. **Pagination by default for collections.** Boards routinely have
   thousands of components, traces, vias. Every "list" tool takes
   `offset` + `limit` and returns a `nextOffset`. Avoids blowing the
   AltiumRelay HTTP long-poll budget (~8s per call) and blowing token
   budgets on the AI side.
4. **Cross-platform by default, with validation as a hard PR gate.**
   Every new tool that touches a concept any EDA platform has
   (project, schematic, components, BOM, placement, routing,
   verification, manufacturing, ordering) must work across **every
   supported platform** — Altium today, EasyEDA on landing, KiCad /
   Eagle / Fusion 360 if and when they're added. Concrete rules:

   - **Tool surface is platform-agnostic.** Public name is
     `list_projects(platform)`, never `altium_list_projects` +
     `easyeda_list_projects`. Per-platform implementations live behind
     a `Platform` interface (Sprint 9 PR 9.X — pulled forward from
     the original Sprint 13.5 placement so every subsequent tool is
     built on it from day one, not retrofitted).
   - **Every new tool ships with hermetic tests on every supported
     platform.** A PR that adds `get_components` lands with both an
     Altium test and an EasyEDA test. Single-platform PRs don't pass
     review.
   - **Genuine platform exclusivity is rare and explicit.** If a
     platform truly cannot support the operation (e.g. an API surface
     doesn't exist), the tool registers a stub returning
     `{supported: false, reason: <one sentence>}` so the AI client can
     degrade gracefully and reason about the limitation. The exception
     is documented in the tool's docstring AND in `/docs`.
   - **Forward-compatibility for future EDAs.** Adding KiCad in a
     future sprint means writing a new `KicadPlatform` implementation
     — not rewriting any of the existing tool registrations.

## Where we are today (post-Sprint-8)

| Pipeline stage | Altium 365 | Altium Designer (relay) | EasyEDA |
|---|---|---|---|
| 1. Ideation | none | none | none |
| 2. Architecture | none | none | none |
| 3. Schematic | partial (read-only) | partial (compile, annotate, message-panel read) | none |
| 4. BOM / sourcing | full (Octopart) | n/a | none |
| 5. Placement | n/a | minimal (auto-place only — no per-component read or write) | none |
| 6. Routing | n/a | minimal (auto-route only — no rule mgmt, no per-net read) | none |
| 7. Verification | n/a | partial (DRC trigger only — no violation enumeration) | none |
| 8. Manufacturing outputs | partial (some stubs) | partial (OutJob runner) | none |
| 9. Ordering | none | none | none |
| 10. Bring-up | none | none | none |

## Headline findings from the research pass

### EasyEDA path is now decided

EasyEDA Pro publishes a **JavaScript in-editor Extension API** with
TypeScript types (`pro-api-types`) covering schematic objects, PCB
objects (layers, traces, pads, vias), library access, and editor UI
integration. Loaded via Advanced → Extensions → Load Extension. This
is the EasyEDA equivalent of the AD relay model — except documented,
sandboxed in a friendly way, and stable across UI updates. **Sprint 9's
"spike" mostly disappears** — the path is the in-editor extension.
Spike just verifies our specific tool surface fits within the
sandbox's HTTP / cross-origin rules.

What this means for the architecture: PCBviber ships an `eda-script/`
sibling to `ad-script/`, containing a PCBviber EasyEDA extension that
loads inside the editor and calls back to our server. The tool
registrations parallel the AD relay tools. We do NOT need to reverse-
engineer EasyEDA's session API or do browser automation.

### JLCPCB ordering API is real

Public REST API at `api.jlcpcb.com`, four product surfaces (PCB, SMT
Stencil, 3D Printing, Components). Auth is `appKey` + `appSecret` with
HMAC-style signing. **Application is gated on past order history** —
that's a meaningful pre-requisite for Sprint 14 (we may need to
actually place a few orders manually before applying for API access).
No formal partner program for tools that route orders; only marketing
affiliates.

### Altium P&R surface has obvious gaps

Today: only `ad_auto_place` and `ad_auto_route` — both write-only,
neither exposes the underlying state. The agent surveyed and produced:

- 7 placement gaps (per-component read, move/rotate/lock, keepouts,
  constraints, place-by-group, validation, 3D)
- 9 routing gaps (per-net state, rule CRUD, manual route, unroute,
  diff-pair, xSignals, via stitching, impedance, selective deletion)

These warrant **dedicated sprints** (one for placement, one for
routing), not a generic "AD enhancements" bucket. They land in Tier 1
because the P&R surface is the single biggest reason a serious customer
would say "this isn't ready for real work yet."

---

## Tier 1 — EasyEDA core integration + Altium P&R parity

5 sprints. Each follows the existing convention (one PR at a time, hermetic tests, self-review pass before merge).

### Sprint 9 — EasyEDA spike + Platform interface foundation

Confirm the EasyEDA path, plumb the workspace model, **and introduce the
`Platform` interface** that every subsequent tool registers through.
Pulled forward from the original Sprint 13.5 placement so every tool
from Sprint 10 onward is built cross-platform from day one, not
retrofitted.

- **PR 9.1 — Spike report.** Load EasyEDA Pro, register a hello-world
  extension, exercise the API surface for read (schematic objects +
  PCB objects) and write (place/move a single component). Document
  what works, what doesn't, what's risky. Output is a markdown
  decision doc in `docs/roadmap/`. **No code shipped to main yet.**
- **PR 9.2 — Workspace platform model.** Add `platform: "altium" | "easyeda"`
  to `Workspace` schema, migration, tenant tx coverage. Existing
  workspaces default to `"altium"`. SPA shows a platform pill in
  Settings → Workspaces.
- **PR 9.3 — `Platform` interface + Altium implementation.** New
  TypeScript `Platform` interface defining the cross-platform surface:
  `listProjects`, `getProject`, `getComponents`, `moveComponent`,
  `runDrc`, etc. Each method returns a `PlatformResponse` with either
  data or `{supported: false, reason}`. Refactor existing AD relay
  handlers to register through `AltiumPlatform extends Platform`.
  Existing tool registrations (`ad_*`) keep working — they're just
  thin adapters over the interface now. All existing hermetic tests
  must still pass.
- **PR 9.4 — `eda-script/` scaffolding + `EasyedaPlatform` skeleton.**
  PCBviber EasyEDA extension skeleton (manifest, build, install
  instructions in `eda-script/README.md`). Long-poll bridge mirroring
  `ad-relay/relay.ts`. Server-side `EasyedaPlatform implements Platform`
  with every method returning `{supported: false, reason: "not yet
  implemented"}` — Sprint 10 fills these in.
- **PR 9.5 — SPA install flow.** New "Connect EasyEDA" panel under
  Settings → Workspaces; downloads the extension package and shows the
  load-into-EasyEDA steps. Mirrors AD relay's setup flow.

**Exit**: a workspace declares its platform; the `Platform` interface
exists with both Altium (real) and EasyEDA (stub) implementations;
every subsequent tool registers through it.

### Sprint 10 — EasyEDA read parity (fill the `EasyedaPlatform` stub)

Sprint 9's `EasyedaPlatform` returns `{supported: false}` for everything.
Sprint 10's PRs implement the read surface so the platform-agnostic
tools introduced through `Platform` work on EasyEDA too. Existing
Altium tests and new EasyEDA tests both pass after every PR.

- **PR 10.1 — `screenshot(platform)`.** Single tool, two implementations:
  `AltiumPlatform.screenshot()` already exists (renamed from
  `ad_screenshot`); `EasyedaPlatform.screenshot()` is new (extension
  captures the editor canvas). Cross-platform test asserts both work.
  **Architectural foundation**: every subsequent layout-modifying tool
  pair will use this in its test for visual verification.
- **PR 10.2 — `list_projects(platform)` / `get_active_project(platform)`.**
- **PR 10.3 — `get_schematic(platform)` / `get_pcb(platform)`** (paginated)
- **PR 10.4 — `list_library_components(platform)`** with LCSC enrichment
  on the EasyEDA side (cross-references to Octopart's per-distributor
  stock).
- **PR 10.5 — `get_messages(platform)`** (DRC + ERC outputs from the
  platform's messages panel).

**Exit**: every read tool the platform abstraction exposes works on
both Altium and EasyEDA, with hermetic tests on both. Tool reference
in `/docs` shows one tool per row, not two.

### Sprint 11 — Placement deep dive (cross-platform)

Closes the 7 placement gaps the research surfaced. Each PR adds a tool
that works on **both** Altium and EasyEDA, with hermetic tests on both.
Per-PR scope is sized to land the Altium implementation, the EasyEDA
implementation, and the screenshot-verified test in a single review.

- **PR 11.1 — `get_components(platform)`.** Paginated read. Returns
  `[{designator, mpn, footprint, x, y, layer, rotation, locked}, ...]`.
  Closes the single biggest current gap (today only `componentCount`
  is exposed on Altium; nothing on EasyEDA).
- **PR 11.2 — `move_component` / `rotate_component` / `lock_component`.**
  Three primitive write tools. Each PR's test asserts: read state →
  mutate → screenshot → state confirms change.
- **PR 11.3 — `get_keepouts` / `set_keepout`** (CRUD on both platforms).
- **PR 11.4 — `validate_placement`.** Overlap + spacing-rule check.
  Returns structured violations the AI can reason about.
- **PR 11.5 — `place_by_group`.** LLM-friendly helper: filter
  (`"footprint=0402 AND net=VCC*"`) + strategy (`"near-net-source"`,
  `"around-component"`, `"on-edge"`). Built on the primitives from
  11.1–11.2; one implementation, both platforms covered automatically
  via the `Platform` interface.

**Exit**: AI can place a board with concrete commands on both Altium
and EasyEDA — no platform-conditional prompts, no per-platform tool
selection.

### Sprint 12 — Routing deep dive (cross-platform)

Closes the 9 routing gaps. Same cross-platform pattern as Sprint 11.

- **PR 12.1 — `get_net_routing(platform)`.** Per-net read: total length,
  layer split, via count, list of unrouted segments. Paginated by net.
- **PR 12.2 — `get_design_rules` / `set_route_rule`.** Net class CRUD
  + per-class clearance / width / via style.
- **PR 12.3 — `unroute_net` / `unroute_selection`** with screenshot
  confirmation in each test.
- **PR 12.4 — `route_diff_pair`.** Altium implementation wires the GUI
  command via DXP; EasyEDA implementation uses the extension's
  diff-pair-router invocation. Both tested.
- **PR 12.5 — `via_stitch_plane`.** Rule-driven via stitching (target
  net, density, edge clearance) on both platforms.
- **PR 12.6 — `xsignals_status`.** **Genuine platform exclusivity**:
  Altium implementation reads length-tuning state via the Messages
  panel (best-effort workaround per agent research); EasyEDA
  implementation returns `{supported: false, reason: "EasyEDA does
  not expose xSignals/length-tuning state"}`. The AI client degrades
  gracefully via the standard `supported: false` contract.

**Exit**: AI can read routing state, mutate route rules, route diff
pairs, and unroute on both platforms.

### Sprint 13 — Manufacturing + outputs (cross-platform)

Closes the manufacturing-output side. The original Sprint 13.5
("platform abstraction") is gone — abstraction landed in Sprint 9.

- **PR 13.1 — `export_gerbers(platform)` / `export_drill` /
  `export_bom` / `export_pick_and_place`.** All four cross-platform.
  Altium uses the existing OutJob runner; EasyEDA uses the extension's
  export API.
- **PR 13.2 — `run_drc(platform)` + violation enumeration on both.**
  Closes the README's long-standing DRC-violation-enumeration gap on
  Altium (Messages-panel parsing) and adds EasyEDA support via the
  extension API.
- **PR 13.3 — `production_readiness_check(platform)`.** Cross-platform
  DFM helper that runs the export pipeline + DRC + manufacturing-rule
  checks (drill aspect, copper-near-edge, fiducial presence).
- **PR 13.4 — `/docs` update.** Tool reference reorganized by
  pipeline stage instead of category. Each tool shows the platforms
  it supports as pills (every cross-platform tool shows
  Altium + EasyEDA; the rare exclusives are flagged).

**Exit**: a customer on either platform can carry a project from
"ready for fab" through manufacturing-output generation. Tool surface
reads as one product, not a marriage of two.

---

## Tier 2 — Pipeline expansion

4 sprints. Sketchier — exact PR breakdown depends on Tier 1 outcomes.

### Sprint 14 — JLCPCB ordering

Sprint 8's launch toolkit + Sprint 13's manufacturing output paths
both point at "and then what?" — this sprint closes the loop.

**Pre-work**: Apply for JLCPCB API access (gated on past order history).
That happens BEFORE the sprint starts; we may need to manually place
2–3 PCB orders to qualify. Carry the cost ourselves; treat as user
research.

- PR 14.1 — JLCPCB API client (auth, request signing, error mapping)
- PR 14.2 — `quote_jlcpcb_pcb(gerber_zip)` → quote with options
  (layers, finish, mask color, qty)
- PR 14.3 — `quote_jlcpcb_pcba(gerber_zip + bom + cpl)` → PCBA quote
  with parts substitution preview
- PR 14.4 — `place_jlcpcb_order(quote_id)` — Stripe-pass-through for
  payment; PCBviber takes the affiliate-program cut, **not** a markup
- PR 14.5 — `track_jlcpcb_order(order_id)` — full lifecycle status
- PR 14.6 — SPA flow: orders list, quote review, payment, tracking

**Business model decision** (committed): **affiliate-only, no markup,
transparent pricing.** Reasons:
- Aligned with customer (we don't make money on fab volume)
- Avoids markup-related dispute / refund / cash-flow pain
- JLCPCB has a real marketing affiliate program (commission)
- Trust is the moat; markup-on-procurement burns trust fast

**Exit**: an AI assistant can carry a project from "ready for fab" to
"ordered and tracking" inside one conversation.

### Sprint 15 — Ideation + architecture

The pipeline stages that have no tooling today (1, 2 in the table
above). Pure LLM-structured-output tools — no EDA integration needed,
which makes this sprint cheap relative to the value.

- PR 15.1 — `propose_architecture(requirements_text)` → block diagram
  JSON + suggested key components (MCU, regulators, connectors)
- PR 15.2 — `list_reference_designs(domain)` — pull from indexed
  open-source repos (KiCad/Altium libraries on GitHub, Octopart
  reference designs)
- PR 15.3 — `architecture_to_skeleton(arch, platform)` — seed an
  EasyEDA or Altium project with the architecture's key components
  pre-placed and the major nets drawn. **Highest-leverage tool in
  Tier 2.** Replaces "blank schematic, where do I start?" with a
  warm start grounded in the requirements.
- PR 15.4 — SPA flow: guided ideation walkthrough — 5-turn
  conversation that ends with a project skeleton in your Altium 365
  / EasyEDA workspace

**Exit**: a user can start from a one-paragraph product description
and have a runnable project skeleton in their EDA tool of choice.

### Sprint 16 — Cross-platform DFM (beyond DRC)

Sprint 13 covered DRC enumeration cross-platform. Sprint 16 covers
**design-for-manufacturability** — the checks fab houses run after
DRC passes.

- PR 16.1 — `dfm_check(platform, project_id)`. Cross-platform via
  exported Gerbers + BOM. Checks: minimum trace/space, drill aspect
  ratio, silkscreen-on-pad, copper-near-edge, fiducials present.
  Single tool, both platforms tested.
- PR 16.2 — `design_for_assembly_check(platform, project_id)`.
  BOM-vs-LCSC-stock, MOQ-vs-quantity, part-rotation-tolerance,
  panel-yield estimate. Single tool, both platforms tested.
- PR 16.3 — Pre-flight cross-check that reads JLCPCB's manufacturing
  capability matrix (Sprint 14 client) and warns about any spec the
  current design exceeds (e.g. "you have 4-mil traces; JLCPCB 2-layer
  default is 5-mil"). Cross-platform.

**Exit**: AI can answer "is this ready to send to fab?" with a real
check on both platforms.

### Sprint 17 — Bring-up + iteration

Last stage of the pipeline (10 in the table above). Mixed
LLM-structured + optional hardware-relay work. Cross-platform
throughout — every tool tested on both Altium and EasyEDA.

- PR 17.1 — `generate_test_plan(platform, project)` → testpoints +
  procedures. Pure LLM-structured output.
- PR 17.2 — `trace_signal(platform, net, scope)` — best-effort visual
  trace through layers, using `screenshot(platform)` +
  `get_net_routing(platform)` from earlier sprints. Helps debug
  "why isn't this signal where I expect?"
- PR 17.3 — `propose_iteration(platform, observed_failure, project)`
  — feedback loop that suggests schematic edits from observed test
  results. Pure LLM-structured.
- PR 17.4 — **Optional / parking lot**: SCPI relay for benchtop
  instruments (parallel to AD relay model). `read_voltage`,
  `set_supply`. Defer if Tier 1 stretches.

**Exit**: AI can support the engineer through bring-up, not just
through design.

---

## Sequencing notes

- **Sprint 9 is the gate for everything.** The `Platform` interface
  (PR 9.3) is shared infrastructure — every Sprint 10+ PR registers
  through it. No Sprint 10–17 work starts until 9 is in.
- **Sprints 11–13 are sequential, not parallel.** Cross-platform
  validation per PR (each PR adds a tool to both `AltiumPlatform`
  AND `EasyedaPlatform` with hermetic tests on both) means Sprint 11
  PRs cannot merge until Sprint 10 has filled in the EasyEDA read
  primitives those tests depend on.
- **Tier 2 sequencing decision**: ordering before ideation. JLCPCB
  API is concrete and ready; ideation needs design (lots of LLM-prompt
  iteration). Revenue first, AI-native differentiation second. Sprints
  15 and 16 are independent of Sprint 14 and can swap if budget
  shifts mid-quarter.

## Estimate

The cross-platform-by-default rule means each PR in Sprints 11+ does
~2× the implementation work it would for a single platform — but the
result is twice the customer-visible value per PR, and the tool
surface stays unified instead of bifurcated. Sprint length doesn't
double; PR count per sprint shrinks slightly (4–6 instead of 5–7) and
each PR is denser.

- Tier 1: 5 sprints × ~1.5 weeks/sprint at the current cadence ≈ **2 months**
- Tier 2: 4 sprints × ~1.5 weeks/sprint ≈ **1.5 months**
- **Total: ~3.5 months of engineering** to "ideation → ordered fab"
  for a single user across both EDA platforms

This excludes go-to-market (more design partners, more pricing-tier
work, copy iterations) and the non-engineering items that are still
open from Sprint 8 (production deploy, counsel review of legal,
branch protection, secret rotation).

## Risks / open questions

1. **EasyEDA Pro is a paid tier.** Free tier is EasyEDA Standard, which
   has a different (older, less documented) API surface. Decision
   needed early in Sprint 9: do we support Standard, or require Pro?
   Recommendation: Pro only at first; Standard is a fast-follow
   if there's demand.
2. **JLCPCB API approval timeline.** Could be days, could be weeks.
   The "previous orders" criterion may push us to start manual
   ordering in our own name during Sprint 11/12 to qualify in time
   for Sprint 14.
3. **xSignals + length tuning** — confirmed not-scriptable in the
   research pass. Sprint 12 PR 12.6 ships with a `{supported: false}`
   stub. Real fix is upstream Altium feature work, out of our hands.
4. **Going down-market.** EasyEDA's audience is hobbyists + JLCPCB
   customers, not the Altium professional segment. Same product,
   different ARPU. Decision (committed): single pricing tier across
   both platforms; quotas are the differentiator, not platform
   eligibility.
5. **In-editor extension distribution.** EasyEDA extensions install via
   "Advanced → Extensions → Load Extension" — manual file load. No
   marketplace today. Friction for first-time setup; pre-Sprint-9
   research on whether EasyEDA Pro is moving toward an extension
   marketplace would inform priority.

---

## Decisions committed in this revision

These were "open questions" in the v1 draft; calling them resolved here
so the sprint planning doesn't have to relitigate them.

| Question | Decision | Reasoning |
|---|---|---|
| Browser-extension territory? | **Yes — but in-editor extension, not Chrome extension.** | EasyEDA Pro publishes a documented in-editor JS Extension API; that's the path. Chrome-extension reverse-engineering is unnecessary. |
| Pricing tier per platform? | **Single tier across both platforms.** | Quotas differentiate; platform eligibility doesn't. Simpler GTM, simpler product. |
| Ordering business model? | **Affiliate-only, no markup, transparent pricing.** | Aligned with customer, avoids dispute/refund pain, trust-as-moat. JLCPCB has a real affiliate program; we lean on it. |
| Tier 2 sequencing? | **Ordering before ideation.** | Concrete API + real revenue path before speculative AI-native tools. Sprints 15/16 can swap if priorities shift mid-quarter. |
