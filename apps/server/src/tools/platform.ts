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

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../mcp/dispatch.js";

export function registerPlatformTools(
  server: McpServer,
  ctx: ToolContext
): void {
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
