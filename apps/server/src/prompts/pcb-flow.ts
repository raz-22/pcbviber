/**
 * PCB design workflow prompts.
 *
 * These are the "instructions to yourself" that turn PCBviber's tool
 * inventory into a disciplined professional flow. Each prompt embeds
 * the expected tool sequence, pause points, verification criteria,
 * and escalation paths so the model doesn't drift off into random
 * tool calls.
 *
 * Rationale for the text length / specificity: agents drift when
 * instructions are vague. These are long by design.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerPcbFlowPrompts(server: McpServer) {
  server.prompt(
    "pcb_design_flow",
    "Full professional PCB design workflow — a nine-stage playbook covering project infrastructure through production handoff. Use this when starting a new board from scratch.",
    {
      project_name: z.string().optional().describe("Short working name for the board, e.g. 'Power Monitor Rev A'"),
      board_type: z.string().optional().describe("High-level description: e.g. 'mixed-signal 4-layer with DDR3', 'low-power wearable'"),
      target_layers: z.string().optional().describe("Planned layer count, e.g. '4', '6'"),
      target_quantity: z.string().optional().describe("Expected production quantity, drives component sourcing priorities"),
    },
    async ({ project_name, board_type, target_layers, target_quantity }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: DESIGN_FLOW_TEMPLATE({
              project_name,
              board_type,
              target_layers,
              target_quantity,
            }),
          },
        },
      ],
    })
  );

  server.prompt(
    "pcb_project_audit",
    "Audit a half-built Altium project against the 9-stage professional flow. Produces a prioritized fix list.",
    {
      focus: z
        .enum(["all", "layout", "electrical", "manufacturability"])
        .optional()
        .describe("Narrow the audit to a specific concern; default 'all'"),
    },
    async ({ focus }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: AUDIT_TEMPLATE({ focus: focus ?? "all" }),
          },
        },
      ],
    })
  );

  server.prompt(
    "pcb_dfm_review",
    "Final Design-For-Manufacturability review before fabrication. Runs the professional pre-production checklist.",
    {
      fab_capabilities: z
        .string()
        .optional()
        .describe("Known fab-house constraints, e.g. 'JLCPCB 2-layer, min trace 0.127mm, min via 0.3mm'"),
    },
    async ({ fab_capabilities }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: DFM_TEMPLATE({ fab_capabilities }),
          },
        },
      ],
    })
  );
}

// ──────────────────────────────────────────────────────────────────────
// Templates — long and specific on purpose
// ──────────────────────────────────────────────────────────────────────

function DESIGN_FLOW_TEMPLATE(args: {
  project_name?: string;
  board_type?: string;
  target_layers?: string;
  target_quantity?: string;
}): string {
  const name = args.project_name ?? "(unnamed project)";
  const type = args.board_type ?? "unspecified";
  const layers = args.target_layers ?? "unspecified";
  const qty = args.target_quantity ?? "unspecified";

  return `You are guiding a professional PCB designer through the full Altium Designer flow, from empty project to manufacturing handoff. The PCBviber MCP gives you live access to Altium Designer via \`ad_*\` tools and to supply-chain data via \`search_parts\` / \`check_part_availability\`.

**Project brief:**
- Name: ${name}
- Type: ${type}
- Target layer count: ${layers}
- Target production quantity: ${qty}

**Ground rules:**
1. ALWAYS start by calling \`pcbviber_selftest\` and \`pcbviber_audit_project\` to establish where the project actually is. Don't assume you're starting from scratch until the audit says so.
2. Every destructive action (new project, save, auto-route, generate outputs) gets one-line confirmation from the user BEFORE running. Explain what it will do.
3. Use \`ad_screenshot\` liberally after meaningful changes so you can actually SEE the state and describe it to the user.
4. If a tool returns an error or a \`note\` saying a capability is missing on this AD build, surface it honestly. Do not fabricate results.
5. Pause for human input at every stage boundary. The designer owns the design; you own the execution.

---

## The nine stages

### Stage 1 — Project Infrastructure
- Verify workspace connection via \`list_workspaces\`. Flag if no Altium 365 workspace is available (the production flow assumes one).
- If no project is open: create or open via \`ad_open_project\` (preferred — avoid \`ad_new_project\` unless the user explicitly wants an empty scaffold; the WorkspaceManager template picker blocks the script thread).
- Call \`ad_get_active_project\` to confirm.

### Stage 2 — Managed Components & ActiveBOM
- Check \`ad_list_documents\` for a \`.BomDoc\` (ActiveBOM). If absent, tell the user to add one via **Right-click Project → Add → ActiveBOM**.
- For the component list the user intends to use, pre-vet critical MPNs with \`search_parts\` and \`check_part_availability\`. Flag:
  - Lifecycle != Active (NRND, Obsolete, Last Time Buy)
  - Stock low relative to target quantity (${qty})
  - Single-sourced parts (one distributor)
- Propose second-source alternatives via \`find_alternative_parts\` for any risky component.

### Stage 3 — Schematic Capture & Compile
- Confirm a \`.SchDoc\` exists. If not: prompt user to create the top-level sheet.
- Recommend hierarchical decomposition (top sheet + sub-sheets per functional block) if the design has more than ~40 components.
- After the user indicates schematic capture is done: call \`ad_compile_project\`.
- If \`ad_get_messages\` works on this build, fetch the Messages panel and classify errors vs warnings. ERRORS must be zero before proceeding.
- If \`ad_get_messages\` is not yet working (check the returned \`note\` field), ask the user to screenshot the Messages panel and paste it, or to describe what they see.

### Stage 4 — Physical Setup (PCB, Outline, Stackup)
- Confirm \`.PcbDoc\` exists (\`ad_list_documents\`).
- Call \`ad_get_board_info\` — if \`outlineMm\` is null, the outline isn't defined yet. Guide the user: either **MCAD CoDesigner** pull from a mechanical file, or **Design → Board Shape → Define from Selected Objects** after drawing on the Board Shape layer.
- Call \`ad_get_stackup\`. For a 4-layer board, the expected stackup is Sig/GND/PWR/Sig with dedicated plane layers — flag if the user's stackup doesn't have ground planes adjacent to signal layers for a high-speed design.
- For controlled-impedance requirements, remind the user to set **Impedance Profiles** in Layer Stack Manager (50Ω single-ended, 100Ω differential are the common targets).

### Stage 5 — Design Rules & Constraints
- Altium rules introspection is not yet exposed by PCBviber. Ask the user explicitly:
  - Has the fab's capabilities file been imported?
  - Clearance, Routing Width, Via Style, Differential Pair rules set?
  - For high-speed: Matched Length rules defined per bus?
- Recommend concrete starting values from the fab's datasheet if no constraints file is available (typical production-friendly: 5 mil clearance, 6 mil min trace, 0.3mm via drill).

### Stage 6 — Strategic Component Placement
- Recommend the hierarchical placement order:
  1. Mechanically constrained (connectors, switches, LEDs) — must match the enclosure.
  2. Major ICs and processors.
  3. Local decoupling (within 15mm of IC power pins, reduce loop inductance).
  4. Power sections grouped; minimize high-current loops.
- Screenshot the PCB via \`ad_screenshot\` to audit placement visually. Describe density, groupings, obvious issues (e.g. decouplers too far from IC).
- Optionally: \`ad_auto_place\` for unplaced components, then manual cleanup. AD's auto-placer is a starting point, not a finished result.

### Stage 7 — Routing & Length Tuning
- For general routing: user drives interactively.
- For high-speed buses: the professional flow uses **xSignals Wizard** to define paths through series terminations, then **Interactive Differential Pair Routing** and **Interactive Length Tuning (Shift+A)**. PCBviber can't drive these yet; coach the user through the steps.
- After routing, screenshot the PCB and describe:
  - Visible un-routed nets (rats-nest)
  - Obvious via density / layer transitions
  - Any crowded regions that might violate clearance

### Stage 8 — Post-Layout Verification (DRC + PI/SI)
- Run \`ad_run_drc\`. If AD's DRC violation enumeration is still incomplete in PCBviber, ask the user to screenshot the Violations panel after DRC completes.
- For high-current boards, prompt: **Tools → Power Analyzer → build Power Tree, run IR-drop simulation**. This is outside PCBviber's current tool surface; the user drives it in AD.
- For high-speed: **Tools → Signal Integrity** with IBIS models.

### Stage 9 — Manufacturing Documentation
- Confirm an \`.OutJob\` exists. If not: guide the user to add one (**Right-click Project → Add → Output Job File**) and configure:
  - Gerber X2 or ODB++
  - NC Drill
  - Pick-and-place (centroid)
  - Assembly drawings
  - BOM
- Optionally recommend a \`.PCBDwf\` (Draftsman) document for fabrication/assembly drawings with drill legend and layer stack legend.
- Once the OutJob is configured, run \`ad_generate_outputs\`. Report the resulting file list.

---

## Finish condition

You're done when \`pcbviber_audit_project\` reports all nine stages as \`done\` (or explicitly accepted as \`unknown\` for Phase-4 capabilities that PCBviber can't introspect yet), and the user has confirmed the output package is uploaded to fab.

Start by running the self-test and the audit. Report what you see and propose the next concrete action. Do not run any editing tool until the user has confirmed the action and scope.`;
}

function AUDIT_TEMPLATE(args: { focus: string }): string {
  return `You are auditing a half-built Altium project. The goal is a prioritized, honest report of what is done vs what is missing, and concrete next actions — not encouragement.

**Focus:** ${args.focus}

**Step 1 — gather state.** Call these tools in parallel if your client supports it, otherwise in sequence:
- \`pcbviber_selftest\` (relay health + server version)
- \`pcbviber_audit_project\` with default params (the composite auditor; maps findings to the 9-stage flow)
- \`ad_screenshot\` target="window" (visual snapshot)

**Step 2 — interpret the audit output.**
- The audit returns a \`stages\` array with \`status\` per stage (\`done\` / \`in_progress\` / \`pending\` / \`blocked\` / \`unknown\`).
- A \`blocked\` stage is the most important — that's a real issue, not just missing work. Elevate it.
- An \`unknown\` stage means PCBviber can't introspect that capability on this AD build yet. Don't treat it as done. Note it in the report.

**Step 3 — write the report.**

Produce exactly this structure:

**Summary**
One sentence: overall completion percentage + the single most important next action.

**What's done** (✓)
Bullet list from \`stages[].status == "done"\`.

**In progress** (→)
Bullets for stages with partial state. Include specific counts from the \`observations\` field (e.g. "4-layer stackup defined, 47 components placed, outline not yet defined").

**Blocked** (!)
For each blocked stage: what specifically is wrong, and the one action that unblocks it. Reference the \`recommendations\` field.

**Unknown / unmeasurable** (?)
Capabilities PCBviber can't verify on this AD build. Tell the user to check them manually in AD and pass back the results.

**Top 3 actions, in order**
The single most useful thing the user can do right now, plus the two after that. Ground each in the audit's \`recommendations\`.

**Focus-specific detail** (only if focus != "all")
- \`layout\` — go deeper on stages 4, 6, 7 (physical setup, placement, routing)
- \`electrical\` — stages 3, 5, 8 (schematic, rules, verification)
- \`manufacturability\` — stages 2, 5, 9 (BOM, rules, outputs)

**Ground rules:**
- Do not fabricate data. If the audit's \`raw\` field shows an error or null, say so.
- If \`hasProject\` is false or \`projectPath\` is "Free Documents", the top priority is opening/creating a real project — every other stage is moot.
- Do not recommend running editing tools. This is a read-only audit.`;
}

function DFM_TEMPLATE(args: { fab_capabilities?: string }): string {
  const fab = args.fab_capabilities ?? "unspecified — ask the user before applying numeric thresholds";
  return `You are performing the final Design-For-Manufacturability (DFM) review before fabrication handoff. Production yield depends on this gate. Be thorough and skeptical.

**Fab capabilities (from user):** ${fab}

## Review sequence

1. **Baseline state** — \`pcbviber_audit_project\`. If the audit shows any stage other than stage 9 still \`pending\` or \`blocked\`, stop and tell the user the board isn't ready for DFM yet — they need to finish routing/verification first.

2. **Visual inspection** — \`ad_screenshot\` target="window". Describe what you see: is it a PCB view? Schematic? Messages panel?

3. **Run final DRC** — confirm with the user, then \`ad_run_drc\`. If AD's Violations panel enumeration still isn't exposed, ask the user to screenshot it and describe any violations.

4. **Recompile** for ERC safety — \`ad_compile_project\`. Zero errors required.

5. **Check outputs readiness** — \`ad_list_documents\` must show both an OutJob and ideally a Draftsman doc.

## DFM checklist

For each item, report a concrete observation. If you can't determine it from PCBviber's current capabilities, ask the user explicitly.

- [ ] **Fiducials** — at least 3 on the board, on separate corners. Required by automated pick-and-place.
- [ ] **Solder Mask Sliver** — minimum mask between neighboring pads exceeds fab's capability (typical ≥ 0.1mm).
- [ ] **Thermal Relief** — planes connect to pads with spokes, not solid copper. Prevents tombstoning during reflow.
- [ ] **Silkscreen Clearance** — no silk on pads or vias. Screen text legible at production resolution.
- [ ] **Test Points** — automated test points accessible. Especially for power rails.
- [ ] **Component Polarity Marks** — polarized parts (diodes, caps, ICs) have clear pin-1 indicators on silk.
- [ ] **Mounting Hole Clearance** — plated/non-plated consistent with the enclosure. No traces within the keepout.
- [ ] **Board Edge Clearance** — no copper within ~0.3mm of the board edge (routing the panel introduces damage).
- [ ] **Minimum Trace Width** — all traces meet or exceed the fab's minimum.
- [ ] **Minimum Drill Size** — all vias and through-holes meet or exceed the fab's minimum.
- [ ] **Copper Balance** — no severe copper asymmetry across layers (causes warping during reflow).
- [ ] **Paneling** — if submitting as panel, fiducials and rails defined. If submitting as single board, user will request panelization from fab.

## Output

Produce:

1. A \`READY_FOR_FAB: YES\` or \`READY_FOR_FAB: NO\` line as the first line of your response.
2. For NO: the specific reasons, each mapped to a checklist item.
3. For YES: the list of output files (from \`ad_generate_outputs\` if already run, or from the user's known OutJob config).

Do not claim YES if any checklist item is unverified. YES means you (and the user) have explicit evidence for every item.`;
}
