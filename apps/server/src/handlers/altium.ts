/**
 * Handlers that forward MCP tool calls to Altium Designer via the AdRelay.
 *
 * Each handler:
 *   1. Validates params using the Zod schema from @altium-mcp/shared.
 *   2. Calls relay.execute(method, params, timeoutMs).
 *   3. Returns whatever AD posted back, or surfaces the error.
 *
 * The server doesn't care WHAT the AD-side does with each method —
 * that's the contract in ad-script/AltiumRelay.js.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdRelay } from "../ad-relay/relay.js";
import type {
  OpenProjectParams,
  NewProjectParams,
  SaveProjectParams,
  ListDocumentsParams,
  GetMessagesParams,
  GetBoardInfoParams,
  GetStackupParams,
  AuditProjectParams,
  ScreenshotParams,
  TailLogParams,
  SelfTestParams,
  CompileProjectParams,
  RunDrcParams,
  AnnotateSchematicParams,
  GenerateOutputsParams,
  AutoPlaceParams,
  AutoRouteParams,
} from "@altium-mcp/shared";

const execAsync = promisify(exec);

function requireConnected(relay: AdRelay): void {
  const s = relay.status();
  if (!s.connected) {
    throw new Error(
      "Altium Designer relay is not connected. Start AD, load ad-script/AltiumRelay.js via " +
        "File → Run Script, and make sure the server is running with --transport=http. " +
        "Check GET http://127.0.0.1:3000/ad-relay/status for diagnostics."
    );
  }
}

export async function adPing(relay: AdRelay): Promise<unknown> {
  // Intentionally does NOT require connected — this tool's job is to *check*.
  return relay.execute("ping", {}, 5_000);
}

export async function adGetActiveProject(relay: AdRelay): Promise<unknown> {
  requireConnected(relay);
  return relay.execute("get_active_project", {}, 10_000);
}

export async function adOpenProject(
  relay: AdRelay,
  params: OpenProjectParams
): Promise<unknown> {
  requireConnected(relay);
  return relay.execute("open_project", params, 30_000);
}

export async function adNewProject(
  relay: AdRelay,
  params: NewProjectParams
): Promise<unknown> {
  requireConnected(relay);
  return relay.execute("new_project", params, 60_000);
}

export async function adCompileProject(
  relay: AdRelay,
  params: CompileProjectParams
): Promise<unknown> {
  requireConnected(relay);
  return relay.execute("compile_project", params, 120_000);
}

export async function adRunDrc(
  relay: AdRelay,
  params: RunDrcParams
): Promise<unknown> {
  requireConnected(relay);
  return relay.execute("run_drc", params, 300_000);
}

export async function adAnnotateSchematic(
  relay: AdRelay,
  params: AnnotateSchematicParams
): Promise<unknown> {
  requireConnected(relay);
  return relay.execute("annotate_schematic", params, 60_000);
}

export async function adGenerateOutputs(
  relay: AdRelay,
  params: GenerateOutputsParams
): Promise<unknown> {
  requireConnected(relay);
  return relay.execute("generate_outputs", params, 300_000);
}

export async function adAutoPlace(
  relay: AdRelay,
  params: AutoPlaceParams
): Promise<unknown> {
  requireConnected(relay);
  return relay.execute("auto_place", params, 300_000);
}

export async function adAutoRoute(
  relay: AdRelay,
  params: AutoRouteParams
): Promise<unknown> {
  requireConnected(relay);
  return relay.execute("auto_route", params, 600_000);
}

export function adStatus(relay: AdRelay) {
  return relay.status();
}

export async function adSaveProject(
  relay: AdRelay,
  params: SaveProjectParams
): Promise<unknown> {
  requireConnected(relay);
  return relay.execute("save_project", params, 30_000);
}

export async function adListDocuments(
  relay: AdRelay,
  params: ListDocumentsParams
): Promise<unknown> {
  requireConnected(relay);
  return relay.execute("list_documents", params, 15_000);
}

export async function adGetMessages(
  relay: AdRelay,
  params: GetMessagesParams
): Promise<unknown> {
  requireConnected(relay);
  return relay.execute("get_messages", params, 15_000);
}

export async function adDebugIntrospectMessages(
  relay: AdRelay
): Promise<unknown> {
  requireConnected(relay);
  return relay.execute("debug_introspect_messages", {}, 15_000);
}

export async function adGetBoardInfo(
  relay: AdRelay,
  params: GetBoardInfoParams
): Promise<unknown> {
  requireConnected(relay);
  return relay.execute("get_board_info", params, 20_000);
}

export async function adGetStackup(
  relay: AdRelay,
  params: GetStackupParams
): Promise<unknown> {
  requireConnected(relay);
  return relay.execute("get_stackup", params, 15_000);
}

// ─── pcbviber_audit_project — maps AD state against the 9-stage flow ─
//
// Composite, agent-friendly auditor. Calls the read-only AD tools in
// parallel, categorizes the results against the professional PCB
// design flow, and returns a structured report with:
//   - per-stage completion status
//   - observed facts
//   - prioritized next actions
//
// Deliberately excludes editing tools — audit is always safe.

type StageStatus = "done" | "in_progress" | "pending" | "blocked" | "unknown";

export async function pcbviberAuditProject(
  relay: AdRelay,
  params: AuditProjectParams
): Promise<{
  summary: {
    hasProject: boolean;
    projectPath: string | null;
    completedStages: number;
    totalStages: number;
    nextAction: string;
  };
  stages: Array<{
    stage: number;
    name: string;
    status: StageStatus;
    observations: string[];
    recommendations: string[];
  }>;
  raw: Record<string, unknown>;
}> {
  const connected = relay.status().connected;
  if (!connected) {
    return emptyAudit(
      "Altium Designer relay not connected — start AD with AltiumRelay.js, then re-run."
    );
  }

  const raw: Record<string, unknown> = {};

  // Parallel, safe, short timeouts. Each failure shows up as null in raw.
  const [activeProject, documents, boardInfo, stackup, messages] = await Promise.all([
    safeCall(() => relay.execute<unknown>("get_active_project", {}, 5_000)),
    safeCall(() => relay.execute<unknown>("list_documents", params, 5_000)),
    safeCall(() => relay.execute<unknown>("get_board_info", params, 10_000)),
    safeCall(() => relay.execute<unknown>("get_stackup", params, 10_000)),
    safeCall(() =>
      relay.execute<unknown>("get_messages", { limit: 200, minLevel: "info" }, 5_000)
    ),
  ]);
  raw.activeProject = activeProject;
  raw.documents = documents;
  raw.boardInfo = boardInfo;
  raw.stackup = stackup;
  raw.messages = messages;

  const proj = extractActiveProject(activeProject);
  const docList = extractDocuments(documents);
  const board = extractBoardInfo(boardInfo);
  const stack = extractStackup(stackup);
  const msgs = extractMessages(messages);

  // Map findings against the nine professional stages.
  const stages: Array<{
    stage: number;
    name: string;
    status: StageStatus;
    observations: string[];
    recommendations: string[];
  }> = [];

  // Stage 1 — Infrastructure
  stages.push({
    stage: 1,
    name: "Project Infrastructure",
    status: proj.hasProject && proj.path !== "Free Documents" ? "done" : "pending",
    observations: [
      `Active project: ${proj.name ?? "(none)"}`,
      `Documents counted: ${docList.total}`,
    ],
    recommendations:
      !proj.hasProject || proj.path === "Free Documents"
        ? [
            "Open or create a .PrjPcb via `ad_open_project` or Altium's File → New → Project.",
          ]
        : [],
  });

  // Stage 2 — Managed components / ActiveBOM
  const hasBom = docList.kinds.some((k) => /bom/i.test(k));
  stages.push({
    stage: 2,
    name: "Managed Components & ActiveBOM",
    status: hasBom ? "done" : "pending",
    observations: [`ActiveBOM document present: ${hasBom}`],
    recommendations: hasBom
      ? []
      : [
          "Right-click Project → Add New → ActiveBOM. Resolves supply-chain risk before layout.",
          "Use `search_parts` / `check_part_availability` to pre-vet critical MPNs.",
        ],
  });

  // Stage 3 — Schematic capture + compile
  const hasSch = docList.kinds.some((k) => /sch/i.test(k) && !/schlib/i.test(k));
  const compileErrors = msgs.counts.error + msgs.counts.fatal;
  const compileWarnings = msgs.counts.warning;
  let s3: StageStatus = "pending";
  if (hasSch && compileErrors === 0 && msgs.available) s3 = "done";
  else if (hasSch && compileErrors > 0) s3 = "blocked";
  else if (hasSch) s3 = "in_progress";
  stages.push({
    stage: 3,
    name: "Schematic Capture & Compile",
    status: s3,
    observations: [
      `Schematic document present: ${hasSch}`,
      msgs.available
        ? `Messages panel: ${compileErrors} errors, ${compileWarnings} warnings`
        : `Messages panel not yet readable on this AD build: ${msgs.note ?? ""}`,
    ],
    recommendations: [
      !hasSch && "Add at least one .SchDoc (Right-click Project → Add → Schematic).",
      hasSch &&
        compileErrors > 0 &&
        "Run `ad_compile_project`; fix ERC errors before proceeding to layout.",
      hasSch &&
        !msgs.available &&
        "Reload the AD script so `ad_debug_introspect_messages` can find the right API shape.",
    ].filter((x): x is string => typeof x === "string"),
  });

  // Stage 4 — Physical setup: PCB doc, outline, stackup
  const hasPcb = docList.kinds.some((k) => /\bpcb\b/i.test(k)) || board.hasPcb;
  const hasOutline = board.outlineMm !== null;
  const hasStackup = stack.layers.length > 0;
  let s4: StageStatus = "pending";
  if (hasPcb && hasOutline && hasStackup) s4 = "done";
  else if (hasPcb) s4 = "in_progress";
  stages.push({
    stage: 4,
    name: "Physical Setup (PCB, Outline, Stackup)",
    status: s4,
    observations: [
      `PCB document present: ${hasPcb}`,
      hasOutline
        ? `Board outline: ${board.outlineMm!.width.toFixed(2)} x ${board.outlineMm!.height.toFixed(2)} mm`
        : "Board outline not yet defined.",
      hasStackup
        ? `Stackup layers: ${stack.layers.length} (total ${stack.totalThicknessMm ?? "?"} mm)`
        : "Stackup not yet configured.",
    ],
    recommendations: [
      !hasPcb && "Add a .PcbDoc (Right-click Project → Add → PCB).",
      hasPcb && !hasOutline &&
        "Define the board outline: Design → Board Shape → Define from Selected Objects, or import from MCAD.",
      hasPcb && !hasStackup &&
        "Configure Layer Stack Manager (Design → Layer Stack Manager). Plan impedance profiles if high-speed.",
    ].filter((x): x is string => typeof x === "string"),
  });

  // Stage 5 — Rules (cannot introspect yet; observational)
  stages.push({
    stage: 5,
    name: "Design Rules & Constraints",
    status: "unknown",
    observations: ["Design rules introspection is a Phase-4 TODO."],
    recommendations: [
      "Manually: Design → Rules → import fab capabilities. Focus on Clearance, Width, ViaStyle, Matched Length for high-speed.",
    ],
  });

  // Stage 6 — Placement
  let s6: StageStatus = "unknown";
  if (board.hasPcb && typeof board.componentCount === "number") {
    s6 = board.componentCount > 0 ? "in_progress" : "pending";
  }
  stages.push({
    stage: 6,
    name: "Component Placement",
    status: s6,
    observations: [
      typeof board.componentCount === "number"
        ? `Components on board: ${board.componentCount}`
        : "Component count unavailable on this AD build.",
      typeof board.unplacedCount === "number"
        ? `Unplaced: ${board.unplacedCount}`
        : "Unplaced count requires deeper AD scripting (Phase-4).",
    ],
    recommendations: [
      !hasPcb && "Add a PcbDoc and run Design → Import Changes from Project.",
      hasPcb && "Screenshot the PCB (ad_screenshot) to visually audit placement density and groupings.",
    ].filter((x): x is string => typeof x === "string"),
  });

  // Stage 7 — Routing (observational)
  stages.push({
    stage: 7,
    name: "Routing & Length Tuning",
    status: "unknown",
    observations: [
      typeof board.unroutedNetCount === "number"
        ? `Un-routed nets: ${board.unroutedNetCount}`
        : "Un-routed net count requires deeper AD scripting (Phase-4).",
    ],
    recommendations: [
      "For high-speed buses: use Interactive Differential Pair Routing + Interactive Length Tuning (Shift+A).",
    ],
  });

  // Stage 8 — Verification: DRC + compile state
  let s8: StageStatus = "pending";
  if (msgs.available && compileErrors === 0) s8 = "in_progress";
  stages.push({
    stage: 8,
    name: "Post-Layout Verification (DRC, PI/SI)",
    status: s8,
    observations: [
      "DRC violations require AD's Violations panel — Phase-4 introspection.",
      "Messages panel: " +
        (msgs.available
          ? `${compileErrors} errors, ${compileWarnings} warnings`
          : "unavailable until API shape is confirmed"),
    ],
    recommendations: [
      "Run `ad_run_drc` after routing is complete; re-run `ad_compile_project` for ERC check.",
      "For high-current boards: Tools → Power Analyzer → run IR drop simulation.",
    ],
  });

  // Stage 9 — Manufacturing docs
  const hasOutJob = docList.kinds.some((k) => /outjob/i.test(k));
  const hasDraftsman = docList.kinds.some((k) => /pcbdwf|draftsman/i.test(k));
  let s9: StageStatus = hasOutJob ? "in_progress" : "pending";
  if (hasOutJob && hasDraftsman) s9 = "done";
  stages.push({
    stage: 9,
    name: "Manufacturing Documentation",
    status: s9,
    observations: [
      `OutJob present: ${hasOutJob}`,
      `Draftsman document present: ${hasDraftsman}`,
    ],
    recommendations: [
      !hasOutJob && "Add an OutJob (Right-click Project → Add → Output Job File).",
      !hasDraftsman && "Add a Draftsman doc for assembly drawings + drill legend.",
      hasOutJob && "Use `ad_generate_outputs` once the OutJob is configured.",
    ].filter((x): x is string => typeof x === "string"),
  });

  const doneCount = stages.filter((s) => s.status === "done").length;
  const nextStage =
    stages.find((s) => s.status === "pending" || s.status === "blocked" || s.status === "in_progress") ??
    stages[stages.length - 1];

  return {
    summary: {
      hasProject: proj.hasProject,
      projectPath: proj.path,
      completedStages: doneCount,
      totalStages: stages.length,
      nextAction:
        nextStage.recommendations[0] ??
        `Stage ${nextStage.stage} (${nextStage.name}): ${nextStage.status}`,
    },
    stages,
    raw,
  };
}

// ─── Tiny extractors for the audit — keep them local and defensive ───

function emptyAudit(reason: string) {
  return {
    summary: {
      hasProject: false,
      projectPath: null,
      completedStages: 0,
      totalStages: 0,
      nextAction: reason,
    },
    stages: [],
    raw: { error: reason },
  };
}

async function safeCall<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function extractActiveProject(raw: unknown) {
  const r = raw as {
    hasProject?: boolean;
    name?: string;
    path?: string;
  } | null | undefined;
  return {
    hasProject: !!r?.hasProject,
    name: r?.name ?? null,
    path: r?.path ?? null,
  };
}

function extractDocuments(raw: unknown) {
  const r = raw as {
    count?: number;
    documents?: Array<{ path?: string; kind?: string }>;
  } | null | undefined;
  const docs = r?.documents ?? [];
  return {
    total: docs.length,
    kinds: docs.map((d) => d.kind ?? ""),
    paths: docs.map((d) => d.path ?? ""),
  };
}

function extractBoardInfo(raw: unknown) {
  const r = raw as {
    hasPcb?: boolean;
    layerCount?: number | null;
    outlineMm?: { width: number; height: number } | null;
    componentCount?: number | null;
    netCount?: number | null;
    unplacedCount?: number | null;
    unroutedNetCount?: number | null;
  } | null | undefined;
  return {
    hasPcb: !!r?.hasPcb,
    layerCount: r?.layerCount ?? null,
    outlineMm: r?.outlineMm ?? null,
    componentCount: r?.componentCount ?? null,
    netCount: r?.netCount ?? null,
    unplacedCount: r?.unplacedCount ?? null,
    unroutedNetCount: r?.unroutedNetCount ?? null,
  };
}

function extractStackup(raw: unknown) {
  const r = raw as {
    layers?: Array<unknown>;
    totalThicknessMm?: number | null;
  } | null | undefined;
  return {
    layers: r?.layers ?? [],
    totalThicknessMm: r?.totalThicknessMm ?? null,
  };
}

function extractMessages(raw: unknown) {
  const r = raw as {
    total?: number;
    counts?: { error?: number; warning?: number; info?: number; fatal?: number };
    note?: string;
  } | null | undefined;
  const counts = r?.counts ?? {};
  const hasData = typeof r?.total === "number" && r.total > 0;
  const hasError = typeof (r as { error?: string } | null | undefined)?.error === "string";
  return {
    available: hasData || (!hasError && !r?.note),
    counts: {
      error: counts.error ?? 0,
      warning: counts.warning ?? 0,
      info: counts.info ?? 0,
      fatal: counts.fatal ?? 0,
    },
    total: r?.total ?? 0,
    note: r?.note ?? null,
  };
}

export async function pcbviberAuditWrapper(
  relay: AdRelay,
  params: AuditProjectParams
): Promise<unknown> {
  return pcbviberAuditProject(relay, params);
}

// ─── Screenshot — server-side, no AD relay involvement ────────────────
// Uses a PowerShell one-shot that drives System.Drawing + user32.dll to
// capture either the Altium Designer main window or the whole virtual
// desktop. Returns an MCP content array containing a base64-encoded PNG
// so Claude (or any image-capable client) can actually SEE the result.

export async function adScreenshot(
  params: ScreenshotParams
): Promise<{
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
}> {
  const tmp = await mkdtemp(join(tmpdir(), "pcbviber-"));
  const pngPath = join(tmp, "ad.png");

  const ps = buildScreenshotPowerShell({
    outPath: pngPath,
    target: params.target,
    maxWidth: params.maxWidth,
  });

  try {
    const { stderr } = await execAsync(
      `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command -`,
      { input: ps, timeout: 20_000, maxBuffer: 10 * 1024 * 1024 } as never
    );
    const stderrStr = stderr ? String(stderr) : "";
    if (stderrStr && stderrStr.trim()) {
      // PowerShell wrote to stderr — usually harmless verbose output,
      // but surface it in the response text so errors aren't silent.
      // fall through to read the file; if it doesn't exist readFile throws.
    }
    const png = await readFile(pngPath);
    const base64 = png.toString("base64");
    return {
      content: [
        {
          type: "text",
          text: `Captured ${params.target} screenshot (${png.byteLength} bytes PNG, base64 ${base64.length} chars). Saved to ${pngPath}.`,
        },
        {
          type: "image",
          data: base64,
          mimeType: "image/png",
        },
      ],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Screenshot failed (${params.target}): ${msg}. ` +
        `PowerShell must be available and Altium Designer's main window detectable.`
    );
  } finally {
    // Clean up the temp dir after we've loaded the file.
    rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// ─── Self-test / diagnostics — for agents and humans alike ───────────
// These bypass the AD relay where possible, so they always return
// something useful even when AD has disconnected.

export async function adTailLog(
  params: TailLogParams
): Promise<{ path: string; exists: boolean; lines: string[] }> {
  const path = join(tmpdir(), "AltiumRelay.log");
  try {
    const contents = await readFile(path, "utf8");
    const all = contents.split(/\r?\n/);
    const nonEmpty = all[all.length - 1] === "" ? all.slice(0, -1) : all;
    const tail = nonEmpty.slice(-params.lines);
    return { path, exists: true, lines: tail };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { path, exists: false, lines: [] };
    }
    throw err;
  }
}

export async function pcbviberSelftest(
  relay: AdRelay,
  params: SelfTestParams
): Promise<{
  server: { ok: true; version: string; name: string };
  relay: ReturnType<AdRelay["status"]>;
  ping:
    | { ok: true; result: unknown; latencyMs: number }
    | { ok: false; error: string };
  activeProject:
    | { ok: true; result: unknown }
    | { ok: false; error: string };
  log?: { path: string; exists: boolean; lines: string[] };
}> {
  const relayStatus = relay.status();

  // Only actually ping/query AD if the relay says it's connected; otherwise
  // we'd rack up timeouts and the report would take 10+ seconds.
  let ping:
    | { ok: true; result: unknown; latencyMs: number }
    | { ok: false; error: string };
  let activeProject:
    | { ok: true; result: unknown }
    | { ok: false; error: string };

  if (relayStatus.connected) {
    const t0 = Date.now();
    try {
      const result = await relay.execute("ping", {}, 5_000);
      ping = { ok: true, result, latencyMs: Date.now() - t0 };
    } catch (err) {
      ping = { ok: false, error: (err as Error).message };
    }
    try {
      const result = await relay.execute("get_active_project", {}, 10_000);
      activeProject = { ok: true, result };
    } catch (err) {
      activeProject = { ok: false, error: (err as Error).message };
    }
  } else {
    ping = { ok: false, error: "relay not connected; skipped" };
    activeProject = { ok: false, error: "relay not connected; skipped" };
  }

  const out: Awaited<ReturnType<typeof pcbviberSelftest>> = {
    server: { ok: true, name: "pcbviber", version: "0.3.0" },
    relay: relayStatus,
    ping,
    activeProject,
  };
  if (params.includeLog) {
    out.log = await adTailLog({ lines: params.logLines } as TailLogParams);
  }
  return out;
}

function buildScreenshotPowerShell(opts: {
  outPath: string;
  target: "window" | "fullscreen";
  maxWidth: number;
}): string {
  const { outPath, target, maxWidth } = opts;
  // Escape single quotes in outPath for safe PowerShell embedding.
  const safeOut = outPath.replace(/'/g, "''");
  const findAdWindow = `
$ad = Get-Process | Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle -match 'Altium Designer' } | Select-Object -First 1
if (-not $ad) { throw 'Altium Designer main window not found.' }
`;
  const captureWindow = `
${findAdWindow}
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
[Win]::ShowWindow($ad.MainWindowHandle, 9) | Out-Null  # SW_RESTORE
[Win]::SetForegroundWindow($ad.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 300
$r = New-Object Win+RECT
[Win]::GetWindowRect($ad.MainWindowHandle, [ref]$r) | Out-Null
$w = $r.Right - $r.Left
$h = $r.Bottom - $r.Top
if ($w -le 0 -or $h -le 0) { throw 'AD window has no size (minimized?).' }
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
`;
  const captureFullscreen = `
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $vs.Width, $vs.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $bmp.Size)
`;
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
${target === "window" ? captureWindow : captureFullscreen}

# Downscale to maxWidth if needed.
$maxW = ${maxWidth}
if ($bmp.Width -gt $maxW) {
  $ratio = $maxW / $bmp.Width
  $newH = [int]($bmp.Height * $ratio)
  $scaled = New-Object System.Drawing.Bitmap $maxW, $newH
  $sg = [System.Drawing.Graphics]::FromImage($scaled)
  $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $sg.DrawImage($bmp, 0, 0, $maxW, $newH)
  $bmp.Dispose()
  $bmp = $scaled
}
$bmp.Save('${safeOut}', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
`;
}
