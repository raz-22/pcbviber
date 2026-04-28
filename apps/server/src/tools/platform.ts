/**
 * Platform-agnostic MCP tools — Sprint 10+.
 *
 * Tools registered here go through the `Platform` interface from
 * Sprint 9 PR 9.3, so a single tool declaration spans Altium and
 * EasyEDA (and any future EDA whose `Platform` impl gets added).
 * Legacy `ad_*` tools in tools/altium.ts keep working alongside —
 * they're not removed until each gets a platform-agnostic
 * replacement here.
 *
 * Sprint 10 PR 10.1b — first registration: `screenshot`.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../mcp/dispatch.js";

const PaginationShape = {
  offset: z.coerce
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Skip the first N components. Defaults to 0."),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe(
      "Max components to return. Defaults to 200; capped at 500 to stay under relay timeouts."
    ),
};

export function registerPlatformTools(
  server: McpServer,
  ctx: ToolContext
): void {
  server.tool(
    "list_projects",
    "List every project the workspace exposes — Altium 365 projects via Nexar (requires the workspace's Altium 365 URL be configured) or EasyEDA Pro projects via the in-editor extension. Returns id + name per entry; use `get_active_project` if you want the one currently focused in the editor.",
    {},
    async () => {
      const result = await ctx.platform.listProjects();
      if (!result.supported) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Could not list projects: ${result.reason}`,
            },
          ],
          isError: true,
        };
      }
      const entries = result.data;
      if (entries.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No projects found in this ${ctx.platform.name} workspace.`,
            },
          ],
        };
      }
      // Compact one-line-per-project output. The AI client gets to
      // see id + name; if it needs richer fields it can call
      // get_active_project / future get_project_details.
      const lines = entries.map(
        (p) => `- "${p.name}" (id="${p.id}")`
      );
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Found ${entries.length} project(s) in this ${ctx.platform.name} workspace:\n` +
              lines.join("\n"),
          },
        ],
      };
    }
  );

  server.tool(
    "get_active_project",
    "Return the project currently active in the EDA editor (the schematic/PCB the user is looking at). Works across Altium and EasyEDA. Returns id + name + the platform's raw project payload for tools that need richer fields.",
    {},
    async () => {
      const result = await ctx.platform.getActiveProject();
      if (!result.supported) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No active project available: ${result.reason}`,
            },
          ],
          isError: true,
        };
      }
      const { id, name } = result.data;
      return {
        content: [
          {
            type: "text" as const,
            // Embed the platform name so a multi-platform AI session
            // can disambiguate which EDA the project lives in. id and
            // name are quoted so an empty value reads as "" instead
            // of disappearing into the surrounding sentence.
            text:
              `Active ${ctx.platform.name} project: name="${name}", id="${id}".`,
          },
        ],
      };
    }
  );

  server.tool(
    "list_schematic_components",
    "List components on the active schematic, paginated. Each entry has primitiveId + designator + value + the platform's raw payload. Pass offset+limit to page through long schematics; the response carries `nextOffset` (null when the page is the last). EasyEDA today; Altium ships in a follow-up that extends the AD relay.",
    PaginationShape,
    async (args) => {
      const result = await ctx.platform.listSchematicComponents({
        offset: args.offset,
        limit: args.limit,
      });
      if (!result.supported) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Could not list schematic components: ${result.reason}`,
            },
          ],
          isError: true,
        };
      }
      const { items, nextOffset, total } = result.data;
      if (items.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No components on the active ${ctx.platform.name} schematic.`,
            },
          ],
        };
      }
      // One line per component: designator + value + (id) so the
      // AI client gets enough to reason about the BOM without a
      // second call. The full raw payload is dropped to keep token
      // counts sane on big schematics — callers that need it can
      // ask for a single primitive's details in a future tool.
      const lines = items.map((c) => {
        const parts: string[] = [];
        if (c.designator) parts.push(c.designator);
        if (c.value) parts.push(`(${c.value})`);
        parts.push(`[${c.primitiveId}]`);
        return `- ${parts.join(" ")}`;
      });
      const totalStr =
        total !== undefined ? ` of ${total}` : "";
      const header = `Schematic components ${
        items.length === 0 ? 0 : 1
      }–${items.length}${totalStr} (${ctx.platform.name}):`;
      const footer =
        nextOffset !== null
          ? `\n\nMore available — call again with offset=${nextOffset} to fetch the next page.`
          : "";
      return {
        content: [
          {
            type: "text" as const,
            text: header + "\n" + lines.join("\n") + footer,
          },
        ],
      };
    }
  );

  server.tool(
    "get_components",
    "Read placed components on the active PCB with full layout fields — designator, mpn, footprint, x, y (mm, board-local), layer (top/bottom/inner), rotation (degrees), locked. Cross-platform; coordinates are normalized to mm at the relay boundary. Pair this with `screenshot` for visual verification before any move/rotate operations. Use `list_pcb_components` instead when you only need designator + footprint (cheaper round-trip).",
    PaginationShape,
    async (args) => {
      const result = await ctx.platform.getComponents({
        offset: args.offset,
        limit: args.limit,
      });
      if (!result.supported) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Could not read components: ${result.reason}`,
            },
          ],
          isError: true,
        };
      }
      const { items, nextOffset, total } = result.data;
      if (items.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No components on the active ${ctx.platform.name} PCB.`,
            },
          ],
        };
      }
      // Compact one-line-per-component rendering. Order:
      //   designator footprint @ (x,y) layer rotation° [LOCKED] mpn
      // The mpn is positioned last because it's often empty; putting
      // it at the end keeps the visual rhythm of the populated
      // fields stable.
      const lines = items.map((c) => {
        const parts: string[] = [];
        if (c.designator) parts.push(c.designator);
        if (c.footprint) parts.push(`(${c.footprint})`);
        // 2 decimal places for mm — sub-100µm precision is rarely
        // useful for AI reasoning and avoids long noisy floats.
        parts.push(`@ (${c.x.toFixed(2)}, ${c.y.toFixed(2)})`);
        parts.push(c.layer);
        parts.push(`${c.rotation.toFixed(0)}°`);
        if (c.locked) parts.push("[LOCKED]");
        if (c.mpn) parts.push(`mpn=${c.mpn}`);
        return `- ${parts.join(" ")}`;
      });
      const totalStr = total !== undefined ? ` of ${total}` : "";
      const header = `Placed components 1–${items.length}${totalStr} (${ctx.platform.name}):`;
      const footer =
        nextOffset !== null
          ? `\n\nMore available — call again with offset=${nextOffset} to fetch the next page.`
          : "";
      return {
        content: [
          {
            type: "text" as const,
            text: header + "\n" + lines.join("\n") + footer,
          },
        ],
      };
    }
  );

  server.tool(
    "get_net_routing",
    "Read per-net routing summary on the active PCB, paginated. Each entry has total trace length (mm), layer split (mm per layer), via count, and unrouted-segment count. Cross-platform; coordinates aggregated in mm, layers normalized to top/bottom/inner/unknown. Pair with `screenshot` for visual + numeric verification of routing completeness. EasyEDA support depends on the extension's pcb_Net.getAll accessor — surfaces a clear supported:false reason when unavailable.",
    PaginationShape,
    async (args) => {
      const result = await ctx.platform.getNetRouting({
        offset: args.offset,
        limit: args.limit,
      });
      if (!result.supported) {
        return {
          content: [
            { type: "text" as const, text: `Could not read net routing: ${result.reason}` },
          ],
          isError: true,
        };
      }
      const { items, nextOffset, total } = result.data;
      if (items.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No nets on the active ${ctx.platform.name} PCB.`,
            },
          ],
        };
      }
      // Per-line summary: name + total length + layer breakdown +
      // via count + unrouted count. Compact enough for AI scanning;
      // raw payload available for finer analysis.
      const lines = items.map((n) => {
        const layerParts = Object.entries(n.layers)
          .filter(([, v]) => v > 0)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${k}: ${v.toFixed(2)}`);
        const layerStr =
          layerParts.length > 0 ? ` (${layerParts.join(", ")})` : "";
        const unroutedTag =
          n.unroutedSegments > 0
            ? `, ${n.unroutedSegments} UNROUTED`
            : "";
        return `- ${n.netName}: ${n.totalLengthMm.toFixed(2)}mm${layerStr}, ${n.viaCount} via(s)${unroutedTag}`;
      });
      const totalStr = total !== undefined ? ` of ${total}` : "";
      const header = `Net routing 1–${items.length}${totalStr} (${ctx.platform.name}):`;
      const footer =
        nextOffset !== null
          ? `\n\nMore available — call again with offset=${nextOffset} to fetch the next page.`
          : "";
      return {
        content: [
          { type: "text" as const, text: header + "\n" + lines.join("\n") + footer },
        ],
      };
    }
  );

  server.tool(
    "place_by_group",
    "Filter components by an AND-joined `key=value` expression and apply a layout strategy. Filter fields: designator, footprint, mpn, layer (with `*` glob support). Strategies: 'grid' (row-major, good for arrays), 'around-component' (circular ring, good for decoupling caps around an MCU), 'on-edge' (line along board edge, good for connectors). Locked components are obstacles, never moved. Returns matched/moved/skipped designator lists.",
    {
      filter: z
        .string()
        .min(1)
        .describe(
          "AND-joined filter, e.g. 'footprint=0402 AND designator=R*'. Fields: designator, footprint, mpn, layer. Use `*` for glob."
        ),
      strategy: z
        .enum(["grid", "around-component", "on-edge"])
        .describe("Layout strategy. See tool description for what each does."),
      // Strategy-specific params. zod doesn't enforce the discriminated
      // union at the MCP-arg level cleanly (the SDK wants a flat shape),
      // so we accept all three as optional and validate which one is
      // present at the platform layer.
      grid: z
        .object({
          originX: z.coerce.number(),
          originY: z.coerce.number(),
          spacingMm: z.coerce.number().min(0).optional(),
          columns: z.coerce.number().int().min(1).optional(),
        })
        .optional()
        .describe("Required when strategy='grid'."),
      around: z
        .object({
          target: z.string().min(1),
          radiusMm: z.coerce.number().min(0).optional(),
        })
        .optional()
        .describe("Required when strategy='around-component'."),
      edge: z
        .object({
          side: z.enum(["top", "bottom", "left", "right"]),
          offsetMm: z.coerce.number().min(0).optional(),
        })
        .optional()
        .describe("Required when strategy='on-edge'."),
      obstacleClearanceMm: z.coerce
        .number()
        .min(0)
        .optional()
        .describe(
          "Avoid placing within this many mm of locked components. Default 0.5."
        ),
    },
    async (args) => {
      // Validate strategy-specific params at this layer rather than
      // pushing into the platform — gives a clearer error to the AI
      // than a generic "missing params" deeper in the stack.
      let typedParams;
      if (args.strategy === "grid") {
        if (!args.grid) {
          return {
            content: [
              {
                type: "text" as const,
                text: "place_by_group with strategy='grid' requires `grid: {originX, originY, ...}`.",
              },
            ],
            isError: true,
          };
        }
        typedParams = {
          filter: args.filter,
          strategy: "grid" as const,
          grid: args.grid,
          obstacleClearanceMm: args.obstacleClearanceMm,
        };
      } else if (args.strategy === "around-component") {
        if (!args.around) {
          return {
            content: [
              {
                type: "text" as const,
                text: "place_by_group with strategy='around-component' requires `around: {target, radiusMm?}`.",
              },
            ],
            isError: true,
          };
        }
        typedParams = {
          filter: args.filter,
          strategy: "around-component" as const,
          around: args.around,
          obstacleClearanceMm: args.obstacleClearanceMm,
        };
      } else {
        if (!args.edge) {
          return {
            content: [
              {
                type: "text" as const,
                text: "place_by_group with strategy='on-edge' requires `edge: {side, offsetMm?}`.",
              },
            ],
            isError: true,
          };
        }
        typedParams = {
          filter: args.filter,
          strategy: "on-edge" as const,
          edge: args.edge,
          obstacleClearanceMm: args.obstacleClearanceMm,
        };
      }
      const result = await ctx.platform.placeByGroup(typedParams);
      if (!result.supported) {
        return {
          content: [
            { type: "text" as const, text: `Could not place by group: ${result.reason}` },
          ],
          isError: true,
        };
      }
      const { matched, moved, skipped, message } = result.data;
      // Show the summary first, then up to 10 moved + up to 10
      // skipped (with reasons) to keep the rendered output bounded
      // even on dense placements.
      const lines: string[] = [message];
      if (moved.length > 0) {
        const head = moved.slice(0, 10).join(", ");
        const tail = moved.length > 10 ? `, ... +${moved.length - 10} more` : "";
        lines.push(`Moved: ${head}${tail}`);
      }
      if (skipped.length > 0) {
        lines.push(`Skipped (${skipped.length}):`);
        for (const s of skipped.slice(0, 10)) {
          lines.push(`  - ${s.designator}: ${s.reason}`);
        }
        if (skipped.length > 10) {
          lines.push(`  ... +${skipped.length - 10} more`);
        }
      }
      if (matched.length === 0) {
        lines.push("No components matched the filter.");
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  server.tool(
    "validate_placement",
    "Check the active PCB for component overlap and spacing-rule violations. Returns structured violations the AI can reason about: type (overlap/spacing), the two designators, distance/overlap depth in mm, and a human-readable message that includes lock status + approximate-bbox flags. Cross-platform; results are identical across Altium and EasyEDA. Default spacing rule is 0.2mm (typical IPC-7351 hand-placed). Pairs where both components are locked are skipped (user-intentional placement).",
    {
      spacingMm: z.coerce
        .number()
        .min(0)
        .optional()
        .describe(
          "Minimum edge-to-edge clearance in mm between component bodies. Defaults to 0.2 (typical IPC-7351 hand-placed). Pass 0 to check overlap only."
        ),
    },
    async (args) => {
      const result = await ctx.platform.validatePlacement({
        spacingMm: args.spacingMm,
      });
      if (!result.supported) {
        return {
          content: [
            { type: "text" as const, text: `Could not validate placement: ${result.reason}` },
          ],
          isError: true,
        };
      }
      const { violations, totalChecked, pairsExamined, approximateBboxCount } =
        result.data;
      if (violations.length === 0) {
        const approxNote =
          approximateBboxCount > 0
            ? ` (${approximateBboxCount} component(s) had no bounding box; result is approximate.)`
            : "";
        return {
          content: [
            {
              type: "text" as const,
              text: `No placement violations on ${ctx.platform.name}. ${totalChecked} components checked across ${pairsExamined} pair(s).${approxNote}`,
            },
          ],
        };
      }
      const overlapCount = violations.filter((v) => v.type === "overlap").length;
      const spacingCount = violations.filter((v) => v.type === "spacing").length;
      const summaryParts: string[] = [];
      if (overlapCount > 0) summaryParts.push(`${overlapCount} overlap`);
      if (spacingCount > 0) summaryParts.push(`${spacingCount} spacing`);
      const approxNote =
        approximateBboxCount > 0
          ? ` (${approximateBboxCount} component(s) used heuristic bbox)`
          : "";
      const header = `${violations.length} violation(s) on ${ctx.platform.name} (${summaryParts.join(", ")}). Checked ${totalChecked} components across ${pairsExamined} pair(s)${approxNote}.`;
      const lines = violations.map((v) => `- [${v.type.toUpperCase()}] ${v.message}`);
      return {
        content: [
          {
            type: "text" as const,
            text: header + "\n" + lines.join("\n"),
          },
        ],
      };
    }
  );

  server.tool(
    "get_keepouts",
    "Read every keepout on the active PCB. Returns kind (placement/routing/via/all), layer (top/bottom/inner/all), polygon vertices in mm, and the platform's raw payload. Cross-platform; coordinates are normalized to mm at the relay boundary. Pair with `validate_placement` to check whether components violate any keepout. EasyEDA support depends on the in-editor extension's pcb_PrimitiveRegion API being exposed (open spike question — if unavailable, the tool surfaces a clear supported:false reason).",
    {},
    async () => {
      const result = await ctx.platform.getKeepouts();
      if (!result.supported) {
        return {
          content: [
            { type: "text" as const, text: `Could not read keepouts: ${result.reason}` },
          ],
          isError: true,
        };
      }
      const items = result.data;
      if (items.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No keepouts on the active ${ctx.platform.name} PCB.`,
            },
          ],
        };
      }
      // Group counts by kind so the AI gets totals first; per-line
      // rendering shows kind + layer + vertex count + bounding-box
      // dims (compact summary that's actionable for placement
      // validation without dumping the full vertex array).
      const byKind = items.reduce<Record<string, number>>((acc, k) => {
        acc[k.kind] = (acc[k.kind] ?? 0) + 1;
        return acc;
      }, {});
      const kindParts = Object.entries(byKind)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, n]) => `${n} ${k}`);
      const header = `Keepouts on ${ctx.platform.name}: ${items.length} total (${kindParts.join(", ")}).`;
      const lines = items.map((k) => {
        // Compact bounding-box summary so the AI can reason about
        // approximate area without enumerating vertices itself.
        let bboxStr = "(no vertices)";
        if (k.vertices.length > 0) {
          const xs = k.vertices.map((v) => v.x);
          const ys = k.vertices.map((v) => v.y);
          const w = Math.max(...xs) - Math.min(...xs);
          const h = Math.max(...ys) - Math.min(...ys);
          bboxStr = `${w.toFixed(2)}×${h.toFixed(2)}mm bbox, ${k.vertices.length} vertices`;
        }
        return `- [${k.kind}] on ${k.layer}: ${bboxStr} (id=${k.id})`;
      });
      return {
        content: [
          { type: "text" as const, text: header + "\n" + lines.join("\n") },
        ],
      };
    }
  );

  server.tool(
    "move_component",
    "Move a placed component on the active PCB to (x, y) in millimeters (board-local origin). Cross-platform — Altium converts mm to its native 1/10000-mil at the relay boundary; EasyEDA stores mm natively. Refuses to mutate locked components (call `lock_component` first to unlock). Multiple components sharing a designator → error rather than silent first-match. Pair with `screenshot` to verify the change.",
    {
      designator: z.string().min(1).describe("Designator (e.g. 'R1', 'U7'). Cross-platform stable identity."),
      x: z.coerce.number().describe("Target X in millimeters."),
      y: z.coerce.number().describe("Target Y in millimeters."),
    },
    async (args) => {
      const result = await ctx.platform.moveComponent({
        designator: args.designator,
        x: args.x,
        y: args.y,
      });
      if (!result.supported) {
        return {
          content: [
            { type: "text" as const, text: `Could not move component: ${result.reason}` },
          ],
          isError: true,
        };
      }
      return { content: [{ type: "text" as const, text: result.data.message }] };
    }
  );

  server.tool(
    "rotate_component",
    "Rotate a placed component to `rotation` degrees (0–360, normalized). Refuses to mutate locked components — call `lock_component` first. Cross-platform.",
    {
      designator: z.string().min(1).describe("Designator (e.g. 'R1', 'U7')."),
      rotation: z.coerce
        .number()
        .describe(
          "Rotation in degrees, 0–360. Negative inputs get normalized; common values 0/90/180/270."
        ),
    },
    async (args) => {
      const result = await ctx.platform.rotateComponent({
        designator: args.designator,
        rotation: args.rotation,
      });
      if (!result.supported) {
        return {
          content: [
            { type: "text" as const, text: `Could not rotate component: ${result.reason}` },
          ],
          isError: true,
        };
      }
      return { content: [{ type: "text" as const, text: result.data.message }] };
    }
  );

  server.tool(
    "lock_component",
    "Lock or unlock a placed component. Locked components reject move/rotate calls — this is the way to unlock something so the AI can mutate it.",
    {
      designator: z.string().min(1).describe("Designator (e.g. 'R1', 'U7')."),
      locked: z.boolean().describe("True to lock, false to unlock."),
    },
    async (args) => {
      const result = await ctx.platform.lockComponent({
        designator: args.designator,
        locked: args.locked,
      });
      if (!result.supported) {
        return {
          content: [
            { type: "text" as const, text: `Could not change lock state: ${result.reason}` },
          ],
          isError: true,
        };
      }
      return { content: [{ type: "text" as const, text: result.data.message }] };
    }
  );

  server.tool(
    "list_pcb_components",
    "List components placed on the active PCB, paginated. Each entry has primitiveId + designator + footprint + the platform's raw payload. Pass offset+limit to page through dense boards; the response carries `nextOffset` (null when the page is the last). EasyEDA today; Altium ships in a follow-up that extends the AD relay (Sprint 11 PR 11.1's `get_components` adds the placement payload).",
    PaginationShape,
    async (args) => {
      const result = await ctx.platform.listPcbComponents({
        offset: args.offset,
        limit: args.limit,
      });
      if (!result.supported) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Could not list PCB components: ${result.reason}`,
            },
          ],
          isError: true,
        };
      }
      const { items, nextOffset, total } = result.data;
      if (items.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No components on the active ${ctx.platform.name} PCB.`,
            },
          ],
        };
      }
      // One line per component: designator + footprint + (id) — the
      // basic-BOM shape callers need to reason about parts on the
      // board. PR 11.1 will add a richer tool with x/y/layer/rotation
      // for placement work; this one stays compact.
      const lines = items.map((c) => {
        const parts: string[] = [];
        if (c.designator) parts.push(c.designator);
        if (c.footprint) parts.push(`(${c.footprint})`);
        parts.push(`[${c.primitiveId}]`);
        return `- ${parts.join(" ")}`;
      });
      const totalStr = total !== undefined ? ` of ${total}` : "";
      const header = `PCB components ${
        items.length === 0 ? 0 : 1
      }–${items.length}${totalStr} (${ctx.platform.name}):`;
      const footer =
        nextOffset !== null
          ? `\n\nMore available — call again with offset=${nextOffset} to fetch the next page.`
          : "";
      return {
        content: [
          {
            type: "text" as const,
            text: header + "\n" + lines.join("\n") + footer,
          },
        ],
      };
    }
  );

  server.tool(
    "list_library_components",
    "List components from the workspace's library (parts available to place), paginated. Cross-platform: Altium 365 workspace library via Nexar; EasyEDA Pro via the in-editor extension's lib_Device. EasyEDA results are optionally enriched with Octopart per-distributor stock + pricing (looks up each entry by MPN/LCSC). Each entry has id + name + the platform's raw payload, plus footprint/manufacturer/mpn/lcscId/lifecycle/octopart when available.",
    {
      ...PaginationShape,
      enrichWithLcsc: z
        .boolean()
        .optional()
        .describe(
          "EasyEDA only: when true (default), cross-reference each result by MPN/LCSC via Nexar/Octopart and merge per-distributor stock into the `octopart` field. Skipped automatically when Nexar isn't configured for this workspace. Set false to skip the enrichment hop and return the platform's native fields only."
        ),
    },
    async (args) => {
      const result = await ctx.platform.listLibraryComponents({
        offset: args.offset,
        limit: args.limit,
        enrichWithLcsc: args.enrichWithLcsc,
      });
      if (!result.supported) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Could not list library components: ${result.reason}`,
            },
          ],
          isError: true,
        };
      }
      const { items, nextOffset, total } = result.data;
      if (items.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No components in this ${ctx.platform.name} workspace's library.`,
            },
          ],
        };
      }
      // One line per entry: name + (mpn/lcsc) + (id) + an optional
      // stock summary when octopart enrichment hit. The full raw
      // payload + per-distributor offers stay in the structured
      // result for any caller that wants them; the text rendering
      // stays compact.
      const lines = items.map((c) => {
        const parts: string[] = [c.name];
        if (c.mpn) parts.push(`(${c.mpn})`);
        else if (c.lcscId) parts.push(`(${c.lcscId})`);
        if (c.footprint) parts.push(`[${c.footprint}]`);
        if (c.octopart && c.octopart.offers.length > 0) {
          const totalStock = c.octopart.offers.reduce(
            (s, o) => s + (o.stock || 0),
            0
          );
          parts.push(`{${c.octopart.offers.length} dist, ${totalStock} stk}`);
        }
        return `- ${parts.join(" ")} id=${c.id}`;
      });
      const totalStr = total !== undefined ? ` of ${total}` : "";
      const header = `Library components 1–${items.length}${totalStr} (${ctx.platform.name}):`;
      const footer =
        nextOffset !== null
          ? `\n\nMore available — call again with offset=${nextOffset} to fetch the next page.`
          : "";
      return {
        content: [
          {
            type: "text" as const,
            text: header + "\n" + lines.join("\n") + footer,
          },
        ],
      };
    }
  );

  server.tool(
    "screenshot",
    "Capture a PNG screenshot of the active EDA editor window. Works across all supported platforms (Altium Designer via local PowerShell capture; EasyEDA Pro via in-editor extension). Returns the image inline so the AI can see it. Pair this with any layout-modifying tool to verify the change visually.",
    {},
    async () => {
      // The platform's screenshot() never throws; it always returns
      // a typed PlatformResponse. Two outcomes:
      //   - supported: true → wrap the data into the MCP image
      //     content shape Claude / Cursor expect.
      //   - supported: false → return an MCP error result with the
      //     reason verbatim. The AI client surfaces the message to
      //     the user without crashing the tool dispatcher.
      const result = await ctx.platform.screenshot();
      if (!result.supported) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Screenshot unavailable: ${result.reason}`,
            },
          ],
          isError: true,
        };
      }
      const { base64Png, byteLength } = result.data;
      return {
        content: [
          {
            type: "text" as const,
            text: `Captured ${ctx.platform.name} screenshot (${byteLength} bytes PNG).`,
          },
          {
            type: "image" as const,
            data: base64Png,
            mimeType: "image/png",
          },
        ],
      };
    }
  );

  server.tool(
    "get_messages",
    "Read DRC + ERC + compile output from the platform's messages panel. Cross-platform: Altium reads the Messages panel's accumulated state (populated by prior runs); EasyEDA actively runs sch_Drc.check + pcb_Drc.check and returns their combined output. Same logical answer either way — what's wrong with this design? Defaults filter out info-class noise; pass minSeverity:'info' to see everything.",
    {
      minSeverity: z
        .enum(["info", "warning", "error"])
        .optional()
        .describe(
          "Drop entries below this severity. Defaults to 'warning' — info-class messages are mostly compile/build chatter that rarely helps AI reasoning. Pass 'info' to see everything."
        ),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe(
          "Max messages to return after severity filtering. Defaults to 200; capped at 500 to keep the rendered output bounded for chatty boards."
        ),
    },
    async (args) => {
      const result = await ctx.platform.getMessages();
      if (!result.supported) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Could not read messages: ${result.reason}`,
            },
          ],
          isError: true,
        };
      }
      const minSeverity = args.minSeverity ?? "warning";
      const limit = Math.min(500, Math.max(1, Math.floor(args.limit ?? 200)));
      // Severity ordering: error > warning > info > unknown.
      // "unknown" never gets filtered out (we don't know what it is —
      // surface it rather than hide it).
      const rank: Record<string, number> = {
        error: 3,
        warning: 2,
        info: 1,
        unknown: 0,
      };
      const minRank = rank[minSeverity] ?? 2;
      const filtered = result.data.filter(
        (m) => (rank[m.severity] ?? 0) >= minRank || m.severity === "unknown"
      );
      const counts = {
        error: filtered.filter((m) => m.severity === "error").length,
        warning: filtered.filter((m) => m.severity === "warning").length,
        info: filtered.filter((m) => m.severity === "info").length,
        unknown: filtered.filter((m) => m.severity === "unknown").length,
      };
      if (filtered.length === 0) {
        const reason =
          result.data.length === 0
            ? `No messages on the active ${ctx.platform.name} project.`
            : `No messages at or above severity '${minSeverity}'. (${result.data.length} below-threshold entries hidden.)`;
        return { content: [{ type: "text" as const, text: reason }] };
      }
      const truncated = filtered.length > limit;
      const visible = filtered.slice(0, limit);
      // Emit the severity-counts header first so the AI can lead
      // with totals before reading per-entry text.
      const headerParts: string[] = [];
      if (counts.error) headerParts.push(`${counts.error} error(s)`);
      if (counts.warning) headerParts.push(`${counts.warning} warning(s)`);
      if (counts.info) headerParts.push(`${counts.info} info`);
      if (counts.unknown) headerParts.push(`${counts.unknown} unknown`);
      const header = `Messages (${ctx.platform.name}): ${headerParts.join(", ")}.`;
      // One line per message, severity-tagged so a quick scan groups
      // by class. source/document tagged inline when present.
      const lines = visible.map((m) => {
        const sevTag = `[${m.severity.toUpperCase()}]`;
        const where = [m.source, m.document].filter(Boolean).join(" / ");
        const whereStr = where ? ` (${where})` : "";
        return `${sevTag}${whereStr} ${m.text}`;
      });
      const footer = truncated
        ? `\n\n${filtered.length - limit} more message(s) hidden — call again with limit=${filtered.length} to see all.`
        : "";
      return {
        content: [
          {
            type: "text" as const,
            text: header + "\n" + lines.join("\n") + footer,
          },
        ],
      };
    }
  );
}
