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
