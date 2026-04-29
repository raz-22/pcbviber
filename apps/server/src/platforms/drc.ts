/**
 * Sprint 13 PR 13.2: shared DRC parsing + summarization.
 *
 * Two parser entry points cover both platforms:
 *   - parseDrcViolations(messages): walks Altium's Messages-panel
 *     entries (PR 10.5 PlatformMessage shape) and extracts DRC
 *     entries into the cross-platform DrcViolation shape.
 *   - parseEasyedaDrcArray(rawArray): walks EasyEDA's
 *     pcb_Drc.check(includeVerboseError=true) return — `Array<any>`
 *     per the SDK; defensive shape extraction for BETA-API drift.
 *
 * `summarizeDrc(violations)` builds the per-severity counts +
 * `passed` flag that complete the DrcResult. Centralized so both
 * platforms emit identical totals from identical violation lists.
 */

import type {
  DrcResult,
  DrcViolation,
  PlatformMessage,
} from "./types.js";

/**
 * Parse DRC entries out of a list of Altium Messages-panel
 * messages (the same shape PR 10.5's `getMessages` returns).
 *
 * Filter: any message with a source/text mentioning "drc" or
 * a category-tagged violation message. Best-effort regex
 * extraction of category, location, and objects.
 *
 * Severity comes from the message itself (PlatformMessage already
 * normalized to info/warning/error/unknown via PR 10.5). We map
 * "unknown" to "warning" here since DRC entries are inherently
 * actionable — better to over-flag than to bury an unparseable
 * violation as info.
 */
export function parseDrcViolations(
  messages: PlatformMessage[]
): DrcViolation[] {
  const out: DrcViolation[] = [];
  for (const m of messages) {
    const sourceMatches =
      m.source.toLowerCase().includes("drc") ||
      m.source.toLowerCase().includes("violation") ||
      m.text.toLowerCase().includes("violation:");
    if (!sourceMatches) continue;
    const severity: DrcViolation["severity"] =
      m.severity === "info" || m.severity === "warning" || m.severity === "error"
        ? m.severity
        : "warning";
    out.push({
      category: extractCategory(m.text),
      severity,
      message: m.text,
      location: extractLocation(m.text),
      objects: extractObjects(m.text),
      raw: m,
    });
  }
  return out;
}

/**
 * Parse EasyEDA Pro's `pcb_Drc.check(includeVerboseError=true)`
 * return — `Array<any>` per the SDK. Each element's shape is
 * `[NEEDS HANDS-ON]` per spike question #3, so this extractor
 * tries multiple field-name fallbacks for each cross-platform
 * field. Unparseable entries get a generic category/severity but
 * stay in the result via `raw`.
 */
export function parseEasyedaDrcArray(rawArray: unknown): DrcViolation[] {
  if (!Array.isArray(rawArray)) return [];
  const out: DrcViolation[] = [];
  for (const entry of rawArray) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    // Severity: try "severity", "level", "type" (lowercased).
    const sevRaw = String(
      e.severity ?? e.level ?? e.type ?? "warning"
    ).toLowerCase();
    const severity: DrcViolation["severity"] =
      sevRaw === "info" ||
      sevRaw === "warning" ||
      sevRaw === "warn" ||
      sevRaw === "error"
        ? sevRaw === "warn"
          ? "warning"
          : sevRaw
        : "warning";
    const message =
      typeof e.message === "string"
        ? e.message
        : typeof e.text === "string"
          ? e.text
          : typeof e.description === "string"
            ? e.description
            : "(unknown DRC violation)";
    const category =
      typeof e.category === "string"
        ? e.category
        : typeof e.kind === "string"
          ? e.kind
          : typeof e.ruleType === "string"
            ? e.ruleType
            : extractCategory(message);
    // Location: try {x, y} top-level, position: {x, y}, or
    // location: {x, y}.
    let location: DrcViolation["location"];
    const candidatePos =
      isRecord(e.position) ? e.position
      : isRecord(e.location) ? e.location
      : isRecord(e) && typeof e.x === "number" && typeof e.y === "number"
        ? { x: e.x, y: e.y }
        : null;
    if (candidatePos && typeof candidatePos.x === "number" && typeof candidatePos.y === "number") {
      location = { x: candidatePos.x as number, y: candidatePos.y as number };
    }
    // Objects: array of designators/nets if exposed.
    let objects: string[] | undefined;
    if (Array.isArray(e.objects)) {
      objects = e.objects.filter((o): o is string => typeof o === "string");
    } else if (Array.isArray(e.designators)) {
      objects = e.designators.filter((o): o is string => typeof o === "string");
    } else if (Array.isArray(e.nets)) {
      objects = e.nets.filter((o): o is string => typeof o === "string");
    }
    out.push({ category, severity, message, location, objects, raw: entry });
  }
  return out;
}

/**
 * Build per-severity counts + the `passed` flag from a violation
 * list. `passed` is true iff there are zero error-severity
 * entries — warnings + info don't fail DRC, just informational.
 */
export function summarizeDrc(violations: DrcViolation[]): DrcResult {
  let errorCount = 0;
  let warningCount = 0;
  let infoCount = 0;
  for (const v of violations) {
    if (v.severity === "error") errorCount++;
    else if (v.severity === "warning") warningCount++;
    else if (v.severity === "info") infoCount++;
  }
  return {
    passed: errorCount === 0,
    violations,
    errorCount,
    warningCount,
    infoCount,
  };
}

// ─── Internals ────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Pull a category label from a message text. Heuristics:
 *   - Leading "Category: ..." style ("Clearance: track-to-track")
 *   - Words ending in "Constraint" / "Rule" inside the text
 *   - Common DRC category keywords (clearance, width, hole, ...)
 *
 * Returns "DRC" as a generic fallback when nothing matches.
 * AI clients can read `raw.text` for the original.
 */
function extractCategory(text: string): string {
  if (!text) return "DRC";
  // Shape 1: "<Category>: rest of message"
  const colonMatch = /^([A-Za-z][A-Za-z0-9 _-]+?):\s/.exec(text);
  if (colonMatch) {
    const category = colonMatch[1].trim();
    // Filter out generic prefixes ("Error:", "Warning:") that
    // aren't DRC categories.
    const lower = category.toLowerCase();
    if (lower !== "error" && lower !== "warning" && lower !== "info") {
      return category;
    }
  }
  // Shape 2: keyword scan.
  const keywords = [
    "clearance",
    "width",
    "hole",
    "via",
    "annular",
    "silkscreen",
    "courtyard",
    "ring",
    "spacing",
    "matched length",
    "differential pair",
    "net antennae",
    "unconnected",
    "short",
  ];
  const lowerText = text.toLowerCase();
  for (const kw of keywords) {
    if (lowerText.includes(kw)) {
      // Title-case the keyword for the category label.
      return kw
        .split(" ")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
    }
  }
  return "DRC";
}

/**
 * Best-effort location extraction. Looks for an "at (X, Y)mm"
 * pattern in the message text (Altium's Messages panel includes
 * this for many DRC categories). Returns undefined when not
 * present rather than zeros — distinguishes "no location" from
 * "violation at the origin".
 */
function extractLocation(text: string): DrcViolation["location"] {
  // "at (12.34, 56.78)mm" — units optional, decimals optional.
  const m = /at\s*\(([\-\d.]+)\s*,\s*([\-\d.]+)\)\s*(mm)?/i.exec(text);
  if (!m) return undefined;
  const x = Number(m[1]);
  const y = Number(m[2]);
  if (!isFinite(x) || !isFinite(y)) return undefined;
  return { x, y };
}

/**
 * Best-effort object-list extraction. Looks for designator-like
 * tokens (R1, U7, J3) and net-name-like patterns (NET="X").
 * Conservative: only confident matches surface; everything else
 * stays in `raw` for AI debugging.
 */
function extractObjects(text: string): string[] | undefined {
  const out: string[] = [];
  // Designator pattern: 1-3 letters followed by 1-4 digits, word
  // boundaries on both sides. Matches R1, U23, IC100, but not
  // arbitrary words.
  const designatorMatches = text.match(/\b[A-Z]{1,3}\d{1,4}\b/g);
  if (designatorMatches) {
    for (const d of designatorMatches) out.push(d);
  }
  // Net pattern: NET="X" or net "X"
  const netMatches = text.matchAll(/net\s*[=:]?\s*['"]([^'"]+)['"]/gi);
  for (const m of netMatches) out.push(m[1]);
  return out.length > 0 ? out : undefined;
}
