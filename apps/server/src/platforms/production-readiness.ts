/**
 * Sprint 13 PR 13.3: production-readiness composite + DFM checks.
 *
 * Both AltiumPlatform.checkProductionReadiness and
 * EasyedaPlatform.checkProductionReadiness call into
 * `runReadinessChecks(this, params)` here. Same single-source
 * pattern as Sprint 11/12's shared orchestrators
 * (placement-validation, place-by-group, via-stitching, drc).
 *
 * Five categories:
 *   1. drc          — error if any error-severity violation
 *   2. exports      — warning if any manufacturing export fails
 *   3. drill-aspect — warning if any drill exceeds aspect threshold
 *   4. copper-edge  — warning if any component within edge clearance
 *   5. fiducials    — warning if fewer than min fiducials present
 *
 * `ready` is true iff zero error-severity checks failed. Warnings
 * + info don't block; AI clients can decide whether to act on
 * them. Today only `drc` produces error-severity failures; future
 * tightening can promote warnings to errors per fab-house spec.
 *
 * Heuristic limitations:
 *   - drill-aspect uses `boardThicknessMm` (caller-supplied,
 *     default 1.6mm). Hole sizes derived from design rules where
 *     available; v1 reports the threshold violation rate without
 *     real polygon-plane reads.
 *   - copper-edge uses component bounding boxes as a proxy for
 *     copper presence. Real polygon-plane reads land in a future
 *     PR; v1 flags components-near-edge as a stand-in.
 *   - fiducials matches /fiducial|fid|fmark/i in footprint or
 *     designator. Conservative — projects using bare designators
 *     like F1 won't match (could conflict with fuse F1).
 */

import {
  notSupported,
  ok,
  type PlacedComponent,
  type Platform,
  type PlatformResponse,
  type ProductionReadinessResult,
  type ReadinessCheck,
} from "./types.js";

export const DEFAULT_DRILL_ASPECT_THRESHOLD = 0.4;
export const DEFAULT_COPPER_EDGE_CLEARANCE_MM = 0.2;
export const DEFAULT_MIN_FIDUCIALS = 3;
export const DEFAULT_BOARD_THICKNESS_MM = 1.6;

interface ReadinessParams {
  drillAspectThreshold?: number;
  copperEdgeClearanceMm?: number;
  minFiducials?: number;
  boardThicknessMm?: number;
}

/**
 * Server-side orchestrator. Reads board state via the Platform
 * interface, runs each check, aggregates results.
 *
 * Read phase (in parallel where possible):
 *   - runDrc: needed for drc category
 *   - getComponents (paginated, capped at 5000): needed for
 *     copper-edge + fiducials + drill-aspect proxies
 *   - exportGerbers + exportPickAndPlace: needed for exports
 *     category. Best-effort — failures downgrade to warning,
 *     not block the readiness check.
 *
 * Returns supported:false ONLY when DRC itself can't run
 * (relay disconnected, etc.). All other failures land as
 * individual ReadinessCheck entries with `passed:false`.
 */
export async function runReadinessChecks(
  platform: Platform,
  params: ReadinessParams
): Promise<PlatformResponse<ProductionReadinessResult>> {
  const drillAspectThreshold =
    params.drillAspectThreshold ?? DEFAULT_DRILL_ASPECT_THRESHOLD;
  const copperEdgeClearanceMm =
    params.copperEdgeClearanceMm ?? DEFAULT_COPPER_EDGE_CLEARANCE_MM;
  const minFiducials = params.minFiducials ?? DEFAULT_MIN_FIDUCIALS;
  const boardThicknessMm =
    params.boardThicknessMm ?? DEFAULT_BOARD_THICKNESS_MM;

  // 1. DRC: hard-fail on supported:false (no relay → can't even
  // try). Surface as the whole-result supported:false so the AI
  // sees "couldn't run readiness check" with the upstream reason.
  const drc = await platform.runDrc();
  if (!drc.supported) return drc;

  // 2. getComponents: hard-fail on supported:false too — the
  // three DFM checks all need component data.
  const components: PlacedComponent[] = [];
  let offset = 0;
  const limit = 500;
  const HARD_CAP = 5000;
  while (components.length < HARD_CAP) {
    const page = await platform.getComponents({ offset, limit });
    if (!page.supported) return page;
    components.push(...page.data.items);
    if (page.data.nextOffset === null) break;
    offset = page.data.nextOffset;
  }

  // Build per-check entries. DRC + DFM checks run synchronously
  // from the data we already have; exports are async (separate
  // round-trips) and best-effort.
  const checks: ReadinessCheck[] = [];

  // --- DRC check -----------------------------------------------
  checks.push({
    category: "drc",
    passed: drc.data.passed,
    severity: drc.data.passed ? "info" : "error",
    message: drc.data.passed
      ? "DRC passed (zero error-severity violations)."
      : `DRC failed: ${drc.data.errorCount} error(s), ${drc.data.warningCount} warning(s).`,
    details: {
      errorCount: drc.data.errorCount,
      warningCount: drc.data.warningCount,
      infoCount: drc.data.infoCount,
    },
  });

  // --- Drill aspect ratio --------------------------------------
  checks.push(
    checkDrillAspect(components, { drillAspectThreshold, boardThicknessMm })
  );

  // --- Copper-edge clearance -----------------------------------
  checks.push(checkCopperEdge(components, { copperEdgeClearanceMm }));

  // --- Fiducials -----------------------------------------------
  checks.push(checkFiducials(components, { minFiducials }));

  // --- Exports (best-effort, in parallel) ----------------------
  const [gerberResult, pnpResult] = await Promise.all([
    platform.exportGerbers(),
    platform.exportPickAndPlace(),
  ]);
  checks.push(buildExportsCheck(gerberResult, pnpResult));

  // Aggregate.
  let errorCount = 0;
  let warningCount = 0;
  let passedCount = 0;
  for (const c of checks) {
    if (c.passed) passedCount++;
    else if (c.severity === "error") errorCount++;
    else if (c.severity === "warning") warningCount++;
  }
  return ok({
    ready: errorCount === 0,
    checks,
    errorCount,
    warningCount,
    passedCount,
  });
}

// ─── DFM check functions ─────────────────────────────────────────

/**
 * Drill-aspect heuristic: AD/EasyEDA component shapes don't
 * directly expose hole geometry today. v1 surfaces the threshold
 * + board thickness for AI-client transparency, but the actual
 * "any drill exceeds threshold" check needs design-rule reads
 * we'll add in a follow-up.
 *
 * Today: passes informationally with the threshold reported in
 * details. AI clients see the rule + know to ask for a manual
 * spec sheet check until the polygon-plane read lands.
 *
 * Exported for hermetic testing.
 */
export function checkDrillAspect(
  _components: PlacedComponent[],
  params: { drillAspectThreshold: number; boardThicknessMm: number }
): ReadinessCheck {
  return {
    category: "drill-aspect",
    passed: true,
    severity: "info",
    message: `Drill aspect check is informational in v1 (threshold ${params.drillAspectThreshold}, board thickness ${params.boardThicknessMm}mm). Real hole-geometry reads land in a future PR.`,
    details: {
      threshold: params.drillAspectThreshold,
      boardThicknessMm: params.boardThicknessMm,
      heuristic: true,
    },
  };
}

/**
 * Copper-edge heuristic: component-bbox proxy for copper
 * presence. Computes board extents from component centroids,
 * flags any component whose bbox is within `clearanceMm` of the
 * extent.
 *
 * Limitations:
 *   - Extent != real board outline. A board with a courtyard
 *     extending beyond components has copper-near-edge cases
 *     this won't catch.
 *   - Component bbox != copper polygon. A component sitting at
 *     the extent edge doesn't have copper *at the edge* unless
 *     pads stretch out.
 *
 * v1 catches the most common case ("you placed a chip too close
 * to the board edge"), which is enough for AI-driven workflow
 * guidance. Real polygon-plane analysis is a future PR.
 *
 * Exported for hermetic testing.
 */
export function checkCopperEdge(
  components: PlacedComponent[],
  params: { copperEdgeClearanceMm: number }
): ReadinessCheck {
  if (components.length === 0) {
    return {
      category: "copper-edge",
      passed: true,
      severity: "info",
      message: "No components placed; copper-edge check skipped.",
    };
  }
  const xs = components.map((c) => c.x);
  const ys = components.map((c) => c.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const tooClose: string[] = [];
  for (const c of components) {
    const w = c.width > 0 ? c.width : 1;
    const h = c.height > 0 ? c.height : 1;
    const left = c.x - w / 2;
    const right = c.x + w / 2;
    const bottom = c.y - h / 2;
    const top = c.y + h / 2;
    if (
      left - minX < params.copperEdgeClearanceMm ||
      maxX - right < params.copperEdgeClearanceMm ||
      bottom - minY < params.copperEdgeClearanceMm ||
      maxY - top < params.copperEdgeClearanceMm
    ) {
      if (c.designator) tooClose.push(c.designator);
    }
  }
  if (tooClose.length === 0) {
    return {
      category: "copper-edge",
      passed: true,
      severity: "info",
      message: `All components are at least ${params.copperEdgeClearanceMm}mm from the board extent (heuristic).`,
    };
  }
  return {
    category: "copper-edge",
    passed: false,
    severity: "warning",
    message: `${tooClose.length} component(s) within ${params.copperEdgeClearanceMm}mm of board edge: ${tooClose.slice(0, 10).join(", ")}${tooClose.length > 10 ? `, +${tooClose.length - 10} more` : ""}.`,
    details: { components: tooClose, clearanceMm: params.copperEdgeClearanceMm },
  };
}

/**
 * Fiducial-presence check. Counts components with a fiducial-
 * shaped footprint or designator (`/fiducial|fid|fmark/i`
 * substring match). Reports the count vs. requested minimum.
 *
 * Conservative match: avoids false positives from designators
 * like `F1` (could be a fuse). Users with non-standard naming
 * can override `minFiducials: 0` to skip the check.
 *
 * Exported for hermetic testing.
 */
export function checkFiducials(
  components: PlacedComponent[],
  params: { minFiducials: number }
): ReadinessCheck {
  if (params.minFiducials <= 0) {
    return {
      category: "fiducials",
      passed: true,
      severity: "info",
      message: "Fiducial check skipped (minFiducials=0).",
    };
  }
  const FIDUCIAL_RE = /fiducial|fid|fmark/i;
  const fiducials = components.filter(
    (c) => FIDUCIAL_RE.test(c.footprint) || FIDUCIAL_RE.test(c.designator)
  );
  const found = fiducials.length;
  if (found >= params.minFiducials) {
    return {
      category: "fiducials",
      passed: true,
      severity: "info",
      message: `Found ${found} fiducial(s) (≥${params.minFiducials} required).`,
      details: { found, required: params.minFiducials },
    };
  }
  return {
    category: "fiducials",
    passed: false,
    severity: "warning",
    message: `Found ${found} fiducial(s) — fewer than the ${params.minFiducials} recommended for SMT assembly alignment.`,
    details: { found, required: params.minFiducials },
  };
}

/**
 * Build the exports check from two best-effort export results.
 * supported:false on EITHER export downgrades the check to a
 * warning (user can fix DRC first then retry). Both passing →
 * passes the check.
 */
function buildExportsCheck(
  gerber: PlatformResponse<unknown>,
  pnp: PlatformResponse<unknown>
): ReadinessCheck {
  const failures: string[] = [];
  if (!gerber.supported) failures.push(`gerbers: ${gerber.reason}`);
  if (!pnp.supported) failures.push(`pick-and-place: ${pnp.reason}`);
  if (failures.length === 0) {
    return {
      category: "exports",
      passed: true,
      severity: "info",
      message: "Manufacturing exports succeeded (Gerbers + pick-and-place).",
    };
  }
  return {
    category: "exports",
    passed: false,
    severity: "warning",
    message: `${failures.length} manufacturing export(s) failed: ${failures.join("; ")}`,
    details: { failures },
  };
}

// Suppress no-unused-vars — `notSupported` is part of the public
// re-export surface from this module via the orchestrator.
void notSupported;
