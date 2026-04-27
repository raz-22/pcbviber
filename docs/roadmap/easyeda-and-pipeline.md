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
4. **Platform-agnostic where the semantics match.** `list_projects(platform)`
   not `altium_list_projects` + `easyeda_list_projects`. Per-platform
   tools only when the operation is genuinely platform-specific (e.g.
   `ad_run_drc` is Altium-only because EasyEDA's DRC has different
   inputs).

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

### Sprint 9 — EasyEDA spike + extension foundation

Confirm the path, scaffold the extension, plumb the workspace model.

- **PR 9.1 — Spike report.** Load EasyEDA Pro, register a hello-world
  extension, exercise the API surface for read (schematic objects +
  PCB objects) and write (place/move a single component). Document
  what works, what doesn't, what's risky. Output is a markdown
  decision doc in `docs/roadmap/`. **No code shipped to main yet.**
- **PR 9.2 — Workspace platform model.** Add `platform: "altium" | "easyeda"`
  to `Workspace` schema, migration, tenant tx coverage. Existing
  workspaces default to `"altium"`. SPA shows a platform pill in
  Settings → Workspaces.
- **PR 9.3 — `eda-script/` scaffolding.** PCBviber EasyEDA extension
  skeleton: manifest, build, install instructions in
  `eda-script/README.md`. Long-poll bridge mirroring `ad-relay/relay.ts`
  on the server side, with a fresh `EdaRelay` class. **No tools
  registered yet** — just the bridge.
- **PR 9.4 — SPA install flow.** New "Connect EasyEDA" panel under
  Settings → Workspaces; downloads the extension package and shows the
  load-into-EasyEDA steps. Mirrors AD relay's setup flow.

**Exit**: a workspace declares its platform; the EasyEDA extension is
loadable; the long-poll bridge connects but speaks no tools yet.

### Sprint 10 — EasyEDA read tools

Parity with the read side of Altium 365 + AD relay, plus the visual-
verification commitment.

- **PR 10.1 — `easyeda_screenshot`.** First tool in the new namespace.
  Architectural commitment: every other EasyEDA tool that lands in
  this sprint and the next is verified via screenshot in its hermetic
  test.
- **PR 10.2 — `easyeda_list_projects` / `easyeda_get_active_project`**
- **PR 10.3 — `easyeda_get_schematic` / `easyeda_get_pcb`** (paginated)
- **PR 10.4 — `easyeda_list_library_components`** with LCSC enrichment
  (cross-reference to Octopart's per-distributor stock)
- **PR 10.5 — `easyeda_get_messages`** (DRC + ERC outputs from the
  EasyEDA panel — pattern-match `ad_get_messages`)

**Exit**: AI client can read an EasyEDA project end-to-end and get the
same BOM-quality data as on Altium. Every read result can be visually
spot-checked via `easyeda_screenshot`.

### Sprint 11 — Altium **placement** deep dive

Closes the 7 placement gaps. This is where "AI assistant for hardware
engineers" stops being a marketing phrase and becomes a real layout-
helper surface.

- **PR 11.1 — `ad_get_components`.** Paginated read. Returns
  `[{designator, mpn, footprint, x, y, layer, rotation, locked}, ...]`.
  Closes the single biggest current gap: today we expose
  `componentCount` but not per-component placement.
- **PR 11.2 — `ad_move_component` / `ad_rotate_component` / `ad_lock_component`**
  Three primitive write tools. Each pairs with `ad_screenshot` in its
  test.
- **PR 11.3 — `ad_get_keepouts` / `ad_set_keepout`** (CRUD)
- **PR 11.4 — `ad_validate_placement`.** Overlap detection + spacing-
  rule check. Returns structured violations the AI can reason about.
- **PR 11.5 — `ad_place_by_group`.** LLM-friendly helper: takes a
  filter (e.g. `"footprint=0402 AND net=VCC*"`) and a strategy
  (`"near-net-source"`, `"around-component"`, `"on-edge"`). Built on
  the primitives from 11.1–11.2 — not a new low-level capability,
  just a useful aggregation.

**Exit**: AI can place a board from a netlist with concrete commands,
not just trigger Altium's auto-placer and hope.

### Sprint 12 — Altium **routing** deep dive

Closes the 9 routing gaps. Same architectural pattern as Sprint 11.

- **PR 12.1 — `ad_get_net_routing`.** Per-net read: total length, layer
  split, via count, list of unrouted segments. Paginated by net.
- **PR 12.2 — `ad_get_design_rules` / `ad_set_route_rule`.** Net class
  CRUD + per-class clearance / width / via style.
- **PR 12.3 — `ad_unroute_net` / `ad_unroute_selection`** with confirm-
  via-screenshot in each test.
- **PR 12.4 — `ad_route_diff_pair`.** Wires the GUI command via DXP
  (Altium's interactive diff-pair-router triggered programmatically).
- **PR 12.5 — `ad_via_stitch_plane`.** Rule-driven via stitching
  (target net, density, edge clearance).
- **PR 12.6 — `ad_xsignals_status`.** **Best-effort.** README flags
  xSignals as "no scripting surface known"; the agent confirmed.
  Workaround: read length-tuning state via the Messages panel after
  triggering a length-tune-summary command. If the surface is truly
  closed, ship a stub that returns `{supported: false, reason: ...}`
  so the AI client can degrade gracefully.

**Exit**: AI can read routing state, mutate route rules, route diff
pairs, and unroute — the full primitive set for routing automation.

### Sprint 13 — EasyEDA write tools + platform abstraction

Bring EasyEDA up to placement + routing + manufacturing parity, then
unify the tool surface.

- **PR 13.1 — `easyeda_get_components` + write primitives.** Mirror
  Sprint 11's PRs against the EasyEDA extension API.
- **PR 13.2 — `easyeda_get_net_routing` + routing primitives.** Mirror
  Sprint 12.
- **PR 13.3 — `easyeda_export_outputs`.** Gerber, drill, BOM, P&P via
  the extension's export API.
- **PR 13.4 — `easyeda_run_drc` + violation enumeration.**
- **PR 13.5 — Platform abstraction.** Unify the tool surface where
  semantics overlap: `list_projects(platform)`, `get_components(platform)`,
  etc. Per-platform tools (`ad_*`, `easyeda_*`) stay for genuinely
  platform-specific operations. Per-workspace tool filtering — the AI
  client only sees tools that work on this workspace's platform.
- **PR 13.6 — `/docs` update.** Tool reference page is now grouped by
  pipeline stage, not platform. Platform pills next to each tool.

**Exit**: a customer on EasyEDA gets feature parity with a customer on
Altium for everything except the AD-specific tools. Tool surface reads
as one product, not a marriage of two.

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

### Sprint 16 — Cross-platform DFM + verification

Bridges the "exported Gerbers might still fail at the fab" gap.
Reuses platform abstraction from Sprint 13.

- PR 16.1 — `dfm_check(project_id)`. Cross-platform via exported
  Gerbers + BOM. Checks: minimum trace/space, drill aspect ratio,
  silkscreen-on-pad, copper-near-edge, fiducials present.
- PR 16.2 — `ad_enumerate_drc_violations`. The gnarly one — current
  `ad_run_drc` triggers but doesn't enumerate. Workaround via
  Messages-panel parsing.
- PR 16.3 — `easyeda_enumerate_drc_violations` via extension API.
- PR 16.4 — `design_for_assembly_check`. BOM-vs-LCSC-stock,
  MOQ-vs-quantity, part-rotation-tolerance, panel-yield estimate.

**Exit**: AI can answer "is this ready to send to fab?" with a
real check, not just "I think so."

### Sprint 17 — Bring-up + iteration

Last stage of the pipeline (10 in the table above). Mixed
LLM-structured + optional hardware-relay work.

- PR 17.1 — `generate_test_plan(project)` → testpoints + procedures.
  Pure LLM-structured output; no tool dependency.
- PR 17.2 — `trace_signal(net, scope)` — best-effort visual trace
  through layers using `ad_screenshot` / `easyeda_screenshot` +
  `_get_net_routing`. Helps debug "why isn't this signal where I
  expect?"
- PR 17.3 — `propose_iteration(observed_failure, project)` — feedback
  loop that suggests schematic edits from observed test results. Pure
  LLM-structured.
- PR 17.4 — **Optional / parking lot**: SCPI relay for benchtop
  instruments (parallel to AD relay model). `read_voltage`, `set_supply`.
  Defer if Tier 1 stretches.

**Exit**: AI can support the engineer through bring-up, not just
through design.

---

## Sequencing notes

- **Sprint 9 must finish before any of Sprints 10–13.** Workspace model
  + extension scaffolding is shared infrastructure.
- **Sprints 11 + 12 (Altium P&R) and Sprint 13 (EasyEDA write) can
  partly overlap** since they touch different code surfaces, but the
  platform-abstraction PR (13.5) needs both placement + routing tools
  on Altium to be settled first.
- **Tier 2 sequencing decision**: ordering before ideation. JLCPCB API
  is concrete and ready; ideation needs design (lots of LLM-prompt
  iteration). Revenue first, AI-native differentiation second. If
  budget shifts mid-quarter, Sprints 15 and 16 are independent of
  Sprint 14 and can swap.

## Estimate

- Tier 1: 5 sprints × ~1.5 weeks/sprint at the current cadence ≈ **2 months**
- Tier 2: 4 sprints × ~1.5 weeks/sprint ≈ **1.5 months**
- **Total: ~3.5 months of engineering** to "ideation → ordered fab" for
  a single user across both EDA platforms

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
