import { z } from "zod";

/**
 * AD Relay — JSON message protocol between the MCP server and the
 * AltiumRelay script running inside Altium Designer.
 *
 * Transport is HTTP long-polling because AD's scripting engine cannot
 * open WebSockets natively. The wire format is still intentionally small
 * enough that swapping in WebSockets later is a drop-in change.
 */

// ─── Methods the AD side must implement ─────────────────────────────
export const AdMethod = z.enum([
  "ping",
  "get_active_project",
  "open_project",
  "new_project",
  "save_project",
  "list_documents",
  "get_messages",
  "get_board_info",
  "get_stackup",
  "debug_introspect_messages",
  "compile_project",
  "run_drc",
  "annotate_schematic",
  "generate_outputs",
  "auto_place",
  "auto_route",
  "get_components",
  "move_component",
  "rotate_component",
  "lock_component",
  "get_keepouts",
  "get_net_routing",
  "get_design_rules",
  "set_route_rule",
  "unroute_net",
  "route_diff_pair",
  "create_vias",
]);
export type AdMethod = z.infer<typeof AdMethod>;

// ─── Envelope sent from server → AD ─────────────────────────────────
export const AdCommandEnvelope = z.object({
  id: z.string().uuid(),
  method: AdMethod,
  params: z.record(z.string(), z.unknown()).default({}),
  /** Wall-clock budget the AD side should respect for this command. */
  timeoutMs: z.number().int().positive().default(30_000),
});
export type AdCommandEnvelope = z.infer<typeof AdCommandEnvelope>;

// ─── Envelope posted from AD → server ──────────────────────────────
export const AdResultEnvelope = z.object({
  id: z.string().uuid(),
  ok: z.boolean(),
  // .nullish() accepts null, undefined, or the value. The AD-side serializer
  // emits `null` for unset fields (not `undefined`), so plain .optional()
  // would reject well-formed success payloads.
  result: z.unknown().nullish(),
  error: z
    .object({
      message: z.string(),
      detail: z.string().nullish(),
      code: z.string().nullish(),
    })
    .nullish(),
});
export type AdResultEnvelope = z.infer<typeof AdResultEnvelope>;

// ─── Per-method parameter schemas (server-side input validation) ────
export const OpenProjectParams = z.object({
  path: z.string().min(1).describe("Full path to .PrjPcb / .PrjSch file"),
});
export type OpenProjectParams = z.infer<typeof OpenProjectParams>;

export const NewProjectParams = z.object({
  projectPath: z
    .string()
    .min(1)
    .describe("Full path where the .PrjPcb will be saved (parent dirs auto-created)"),
  addSchematic: z
    .boolean()
    .default(true)
    .describe("Also create and save an empty .SchDoc as a project source document"),
});
export type NewProjectParams = z.infer<typeof NewProjectParams>;

export const SaveProjectParams = z.object({
  projectPath: z
    .string()
    .optional()
    .describe("Project path; omit to save the active project"),
});
export type SaveProjectParams = z.infer<typeof SaveProjectParams>;

export const ListDocumentsParams = z.object({
  projectPath: z.string().optional().describe("Omit for the active project"),
});
export type ListDocumentsParams = z.infer<typeof ListDocumentsParams>;

export const GetMessagesParams = z.object({
  /** Max number of messages to return (most recent first). */
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  /** Lowest severity to include. */
  minLevel: z
    .enum(["info", "warning", "error", "fatal"])
    .default("info"),
  /** Optionally filter by source panel, e.g. "Compiler", "DRC". */
  source: z.string().optional(),
});
export type GetMessagesParams = z.infer<typeof GetMessagesParams>;

export const TailLogParams = z.object({
  lines: z.coerce.number().int().min(1).max(1000).default(40),
});
export type TailLogParams = z.infer<typeof TailLogParams>;

export const SelfTestParams = z.object({
  /** Include a log tail in the result. */
  includeLog: z.boolean().default(true),
  /** If includeLog, how many trailing lines. */
  logLines: z.coerce.number().int().min(1).max(200).default(30),
});
export type SelfTestParams = z.infer<typeof SelfTestParams>;

export const GetBoardInfoParams = z.object({
  projectPath: z.string().optional().describe("Omit for the active project"),
});
export type GetBoardInfoParams = z.infer<typeof GetBoardInfoParams>;

export const GetStackupParams = z.object({
  projectPath: z.string().optional().describe("Omit for the active project"),
});
export type GetStackupParams = z.infer<typeof GetStackupParams>;

export const AuditProjectParams = z.object({
  projectPath: z.string().optional(),
  /** Include a window screenshot in the audit bundle (slower, larger). */
  includeScreenshot: z.boolean().default(false),
});
export type AuditProjectParams = z.infer<typeof AuditProjectParams>;

export const ScreenshotParams = z.object({
  /**
   * 'window' captures just Altium Designer's main window (default).
   * 'fullscreen' captures the whole virtual desktop.
   */
  target: z.enum(["window", "fullscreen"]).default("window"),
  /** Maximum width in pixels; height scales to preserve aspect ratio. */
  maxWidth: z.coerce.number().int().min(100).max(4000).default(1600),
});
export type ScreenshotParams = z.infer<typeof ScreenshotParams>;

export const CompileProjectParams = z.object({
  projectPath: z
    .string()
    .optional()
    .describe("Project path; omit to compile the currently-active project"),
});
export type CompileProjectParams = z.infer<typeof CompileProjectParams>;

export const RunDrcParams = z.object({
  projectPath: z.string().optional(),
  /** If true, returns the violation list as structured JSON. */
  returnViolations: z.boolean().default(true),
});
export type RunDrcParams = z.infer<typeof RunDrcParams>;

export const AnnotateSchematicParams = z.object({
  projectPath: z.string().optional(),
  /** Order designators use when assigning. */
  order: z
    .enum(["up_then_across", "down_then_across", "across_then_up", "across_then_down"])
    .default("across_then_down"),
});
export type AnnotateSchematicParams = z.infer<typeof AnnotateSchematicParams>;

export const GenerateOutputsParams = z.object({
  projectPath: z.string().optional(),
  /** Name of the OutJob file (without extension) to run; omit to run the default. */
  outJobName: z.string().optional(),
});
export type GenerateOutputsParams = z.infer<typeof GenerateOutputsParams>;

export const AutoPlaceParams = z.object({
  projectPath: z.string().optional(),
  algorithm: z.enum(["cluster", "statistical"]).default("cluster"),
});
export type AutoPlaceParams = z.infer<typeof AutoPlaceParams>;

export const AutoRouteParams = z.object({
  projectPath: z.string().optional(),
  /** Scope of the route: entire board, selected nets, or a single net. */
  scope: z.enum(["all", "selected", "net"]).default("all"),
  netName: z.string().optional().describe("Required when scope = 'net'"),
});
export type AutoRouteParams = z.infer<typeof AutoRouteParams>;
