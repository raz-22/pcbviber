/**
 * Sprint 13 PR 13.1: shared export-artifact orchestration.
 *
 * Both AltiumPlatform and EasyedaPlatform's four export methods
 * (exportGerbers / exportDrill / exportBom / exportPickAndPlace)
 * route through this module's helpers so the artifact-store
 * round-trip is single-source.
 *
 * Two paths through the orchestrator depending on which platform:
 *
 *   Altium:
 *     1. Trigger the relay's export_xxx command. The AD relay
 *        runs the OutJob and reads the resulting bytes from disk
 *        + uploads them server-side via `recordAltiumArtifact`.
 *     2. Server gets back {artifactId, byteSize, format, ...} —
 *        the relay already touched the artifact store, so we
 *        just shape the response.
 *
 *   EasyEDA:
 *     1. Trigger the relay's export_xxx command. The extension
 *        calls the appropriate sch/pcb_ManufactureData accessor,
 *        gets a browser File, and uploads it via
 *        `eda.sys_ClientUrl.request(API_BASE + '/api/artifacts',
 *        'POST', file)`.
 *     2. Extension's HTTP upload returns the artifact ID + the
 *        same {artifactId, byteSize, ...} envelope, which we
 *        relay back to the server through the result envelope.
 *
 * Either way, the server-side platform impl just unpacks an
 * ExportResult-shaped payload from the relay's response and
 * returns it. This module's helpers do the unpacking + URL
 * synthesis so the format is single-source.
 */

import {
  notSupported,
  ok,
  type ExportResult,
  type PlatformResponse,
} from "./types.js";

/**
 * Server-side path: AD relay returns the file path on disk.
 * We read the bytes + upload to the artifact store directly,
 * then return the ExportResult to the platform impl.
 *
 * Used only by AltiumPlatform — EasyEDA's path goes through
 * the HTTP upload route the extension invokes (see routes.ts).
 *
 * On AltiumRelay.js's side, the response shape is:
 *   { path: string, byteSize: number, meta?: Record<string,unknown> }
 *
 * We trust the relay's path (the AD process ran it; the only
 * caller is AltiumRelay.js which writes to a known temp dir),
 * read it, and put the bytes into the artifact store.
 */
import { artifactStore, type ArtifactFormat } from "../artifacts/store.js";
import { readFile } from "node:fs/promises";

const FORMAT_MIME: Record<ArtifactFormat, string> = {
  "gerber-zip": "application/zip",
  "excellon-drill": "application/octet-stream",
  "csv-bom": "text/csv",
  "csv-pick-and-place": "text/csv",
};

const FORMAT_FILENAME: Record<ArtifactFormat, string> = {
  "gerber-zip": "Gerber.zip",
  "excellon-drill": "Drill.zip",
  "csv-bom": "BOM.csv",
  "csv-pick-and-place": "PickAndPlace.csv",
};

/**
 * Read the AD relay's path-on-disk response and convert to an
 * artifact-store entry. Returns the ExportResult shape platform
 * impls return to AI clients.
 *
 * Errors:
 *   - Path-read failure → supported:false with the error message.
 *     The OutJob may have written to a different location than
 *     expected, or permissions may have changed mid-flight.
 *   - Empty file → supported:false (an OutJob that "completed"
 *     but produced 0 bytes is broken; hide the artifact rather
 *     than handing the AI a useless URL).
 */
export async function readAltiumArtifactFromPath(
  orgId: string,
  format: ArtifactFormat,
  raw: unknown
): Promise<PlatformResponse<ExportResult>> {
  if (typeof raw !== "object" || raw === null) {
    return notSupported(
      `AD relay returned an unexpected ${format} response shape (expected {path, byteSize, ...}).`
    );
  }
  const obj = raw as { path?: unknown; meta?: unknown };
  if (typeof obj.path !== "string" || obj.path.length === 0) {
    return notSupported(
      `AD relay returned no path for ${format}. OutJob may not have configured an output path — check the .OutJob file's output directory.`
    );
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(obj.path);
  } catch (err) {
    return notSupported(
      `Failed to read OutJob output at '${obj.path}': ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  if (bytes.byteLength === 0) {
    return notSupported(
      `OutJob produced an empty ${format} output at '${obj.path}'. Check the OutJob configuration.`
    );
  }
  const meta =
    typeof obj.meta === "object" &&
    obj.meta !== null &&
    !Array.isArray(obj.meta)
      ? (obj.meta as Record<string, unknown>)
      : {};
  let summary;
  try {
    summary = artifactStore.put({
      orgId,
      format,
      bytes,
      mimeType: FORMAT_MIME[format],
      filename: FORMAT_FILENAME[format],
      meta,
    });
  } catch (err) {
    // Oversized — preserves the actionable message from the store.
    return notSupported(err instanceof Error ? err.message : String(err));
  }
  return ok({
    format: summary.format,
    artifactId: summary.id,
    downloadUrl: `/api/artifacts/${summary.id}`,
    byteSize: summary.byteSize,
    expiresAt: summary.expiresAt.toISOString(),
    meta: summary.meta,
    filename: summary.filename,
  });
}

/**
 * EasyEDA path: the extension already uploaded the file to
 * /api/artifacts and got back the artifact ID. The relay's
 * response is just the upload-route's JSON wrapped in the
 * standard result envelope. We unpack it into an ExportResult.
 *
 * Defensive: any missing field falls through to supported:false
 * with a reason naming what was missing — the BETA APIs may
 * shift across Pro versions and silent partial-success would be
 * worse than a clear failure.
 */
export function readEasyedaArtifactFromUpload(
  format: ArtifactFormat,
  raw: unknown
): PlatformResponse<ExportResult> {
  if (typeof raw !== "object" || raw === null) {
    return notSupported(
      `EasyEDA extension returned an unexpected ${format} response shape (expected upload envelope).`
    );
  }
  const obj = raw as {
    id?: unknown;
    byteSize?: unknown;
    format?: unknown;
    expiresAt?: unknown;
    meta?: unknown;
    downloadUrl?: unknown;
  };
  if (typeof obj.id !== "string" || obj.id.length === 0) {
    return notSupported(
      `EasyEDA extension uploaded ${format} but didn't return an artifact id. Check the extension's /api/artifacts upload path.`
    );
  }
  const byteSize = typeof obj.byteSize === "number" ? obj.byteSize : 0;
  const expiresAt =
    typeof obj.expiresAt === "string" ? obj.expiresAt : new Date().toISOString();
  const meta =
    typeof obj.meta === "object" &&
    obj.meta !== null &&
    !Array.isArray(obj.meta)
      ? (obj.meta as Record<string, unknown>)
      : {};
  return ok({
    format,
    artifactId: obj.id,
    downloadUrl:
      typeof obj.downloadUrl === "string"
        ? obj.downloadUrl
        : `/api/artifacts/${obj.id}`,
    byteSize,
    expiresAt,
    meta,
    filename: FORMAT_FILENAME[format],
  });
}

/**
 * Format a one-line summary for the MCP tool's text output.
 * Centralized so the four export tools all render consistently —
 * AI clients see the same structure regardless of which export
 * they ran.
 */
export function buildExportMessage(
  format: ArtifactFormat,
  result: ExportResult,
  platformName: string
): string {
  const sizeKb = (result.byteSize / 1024).toFixed(1);
  const metaParts: string[] = [];
  for (const [k, v] of Object.entries(result.meta)) {
    if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") {
      metaParts.push(`${k}=${v}`);
    }
  }
  const metaStr = metaParts.length > 0 ? ` (${metaParts.join(", ")})` : "";
  return `Exported ${format} from ${platformName}: ${sizeKb} KB${metaStr}. Download via ${result.downloadUrl} (expires ${result.expiresAt}).`;
}
