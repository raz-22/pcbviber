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
  "compile_project",
  "run_drc",
  "annotate_schematic",
  "generate_outputs",
  "auto_place",
  "auto_route",
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
  result: z.unknown().optional(),
  error: z
    .object({
      message: z.string(),
      detail: z.string().optional(),
      code: z.string().optional(),
    })
    .optional(),
});
export type AdResultEnvelope = z.infer<typeof AdResultEnvelope>;

// ─── Per-method parameter schemas (server-side input validation) ────
export const OpenProjectParams = z.object({
  path: z.string().min(1).describe("Full path to .PrjPcb / .PrjSch file"),
});
export type OpenProjectParams = z.infer<typeof OpenProjectParams>;

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
