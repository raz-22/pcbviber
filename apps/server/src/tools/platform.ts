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
}
