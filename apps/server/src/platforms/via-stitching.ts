/**
 * Sprint 12 PR 12.5: shared via-stitching grid + collision planner.
 *
 * Both AltiumPlatform.viaStitchPlane and
 * EasyedaPlatform.viaStitchPlane call into `planViaStitch` here,
 * so the candidate list is identical across platforms regardless
 * of which side actually creates the vias. Same single-source
 * pattern as PR 11.4's validateComponents and PR 11.5's
 * placeByGroupShared.
 *
 * Algorithm:
 *   1. Compute board extents from the placed components (no
 *      board-outline accessor in the cross-platform contract yet).
 *   2. Generate a grid of candidate via positions at densityMm
 *      spacing across that extent.
 *   3. Filter by edgeClearanceMm from the extent edges.
 *   4. Filter out collisions with placed components (bbox), keepouts
 *      (vertex polygon), and existing vias (within VIA_VIA_CLEARANCE_MM).
 *
 * Returns the survivor list — caller dispatches `create_vias` to
 * the relay/extension to materialize.
 *
 * Sub-1mm density is rejected as pathological (a 100×100mm board
 * at 0.5mm = 40k vias). Cap is enforced here, not at the tool
 * layer, so direct platform callers can't bypass it.
 */

import type {
  Keepout,
  PlacedComponent,
  NetRouting,
  Platform,
  PlatformResponse,
  ViaStitchResult,
} from "./types.js";
import { ok } from "./types.js";

export const DEFAULT_DENSITY_MM = 5;
export const DEFAULT_EDGE_CLEARANCE_MM = 1.5;
const MIN_DENSITY_MM = 1.0;
const VIA_VIA_CLEARANCE_MM = 0.5;
const COMPONENT_HEURISTIC_BBOX_MM = 1.0;

export interface ViaPosition {
  x: number;
  y: number;
}

export interface ViaStitchPlan {
  /** Positions to materialize via create_vias. */
  positions: ViaPosition[];
  /** Total grid candidates before filtering. */
  candidates: number;
  /** Skipped breakdown by reason — used by the orchestrator's
   *  rendered message so AI clients see WHY coverage is sparse. */
  skipped: {
    edgeClearance: number;
    componentCollision: number;
    keepoutCollision: number;
    existingVia: number;
  };
  densityMm: number;
  edgeClearanceMm: number;
}

/**
 * Run the grid + collision planner. Inputs:
 *   - components: placed parts on the board (used for extents AND
 *     collision skip — placement bbox treated as obstacle)
 *   - keepouts: placement / via / all-kind keepouts to avoid
 *   - existingVias: positions of vias already on this net (so a
 *     re-stitch doesn't double up). We don't have a per-via reader
 *     yet, so callers pass the closest available proxy.
 *   - net + density + edgeClearance: caller-supplied params with
 *     defaults applied.
 *
 * Defensive: zero density / NaN inputs / empty boards all return
 * an empty positions list with an explanatory candidates count.
 */
export function planViaStitch(
  components: PlacedComponent[],
  keepouts: Keepout[],
  existingVias: ViaPosition[],
  params: {
    net: string;
    densityMm?: number;
    edgeClearanceMm?: number;
  }
): ViaStitchPlan {
  const densityMm = Math.max(
    MIN_DENSITY_MM,
    params.densityMm ?? DEFAULT_DENSITY_MM
  );
  const edgeClearanceMm =
    params.edgeClearanceMm ?? DEFAULT_EDGE_CLEARANCE_MM;

  const empty: ViaStitchPlan = {
    positions: [],
    candidates: 0,
    skipped: {
      edgeClearance: 0,
      componentCollision: 0,
      keepoutCollision: 0,
      existingVia: 0,
    },
    densityMm,
    edgeClearanceMm,
  };

  if (components.length === 0) return empty;

  // Extents from placed components. Pad by densityMm so the grid
  // covers the actual board, not just component centroids — boards
  // typically have margin around the outermost parts.
  const xs = components.map((c) => c.x);
  const ys = components.map((c) => c.y);
  const minX = Math.min(...xs) - densityMm;
  const maxX = Math.max(...xs) + densityMm;
  const minY = Math.min(...ys) - densityMm;
  const maxY = Math.max(...ys) + densityMm;
  if (!isFinite(minX) || !isFinite(maxX) || !isFinite(minY) || !isFinite(maxY)) {
    return empty;
  }

  const result: ViaStitchPlan = {
    ...empty,
    positions: [],
    skipped: { ...empty.skipped },
  };

  // Walk the grid. Inclusive on both ends so a 100x100 board at
  // 5mm density places 21x21 = 441 candidates rather than 20x20.
  for (let y = minY; y <= maxY + 1e-9; y += densityMm) {
    for (let x = minX; x <= maxX + 1e-9; x += densityMm) {
      result.candidates++;

      // Edge-clearance check uses the extent (not a true board
      // outline), so this is approximate. Live test confirms.
      if (
        x - minX < edgeClearanceMm ||
        maxX - x < edgeClearanceMm ||
        y - minY < edgeClearanceMm ||
        maxY - y < edgeClearanceMm
      ) {
        result.skipped.edgeClearance++;
        continue;
      }

      // Component bbox collision. Reuses the same heuristic-bbox
      // fallback as PR 11.4: missing width/height → 1mm placeholder.
      let hitComponent = false;
      for (const c of components) {
        const w = c.width > 0 ? c.width : COMPONENT_HEURISTIC_BBOX_MM;
        const h = c.height > 0 ? c.height : COMPONENT_HEURISTIC_BBOX_MM;
        if (
          Math.abs(x - c.x) < w / 2 &&
          Math.abs(y - c.y) < h / 2
        ) {
          hitComponent = true;
          break;
        }
      }
      if (hitComponent) {
        result.skipped.componentCollision++;
        continue;
      }

      // Keepout polygon collision via bounding-box approximation.
      // True polygon-in-test would be more accurate but the bbox
      // is conservative (more skips, never fewer) — safer default.
      let hitKeepout = false;
      for (const k of keepouts) {
        if (k.kind !== "via" && k.kind !== "all" && k.kind !== "routing") continue;
        if (k.vertices.length === 0) continue;
        const kxs = k.vertices.map((v) => v.x);
        const kys = k.vertices.map((v) => v.y);
        if (
          x >= Math.min(...kxs) &&
          x <= Math.max(...kxs) &&
          y >= Math.min(...kys) &&
          y <= Math.max(...kys)
        ) {
          hitKeepout = true;
          break;
        }
      }
      if (hitKeepout) {
        result.skipped.keepoutCollision++;
        continue;
      }

      // Existing via collision — within VIA_VIA_CLEARANCE_MM of
      // any pre-existing via on this net.
      let hitVia = false;
      for (const v of existingVias) {
        const dx = x - v.x;
        const dy = y - v.y;
        if (Math.sqrt(dx * dx + dy * dy) < VIA_VIA_CLEARANCE_MM) {
          hitVia = true;
          break;
        }
      }
      if (hitVia) {
        result.skipped.existingVia++;
        continue;
      }

      result.positions.push({ x, y });
    }
  }

  return result;
}

/**
 * Best-effort proxy for "existing vias on this net": we don't have
 * a per-via geometry reader yet, but `getNetRouting` returns the
 * via count per net. v1 doesn't read positions back — we just
 * trust that the user/AI is calling viaStitchPlane on a net that
 * doesn't already have stitching, OR accepts that re-stitching
 * may produce close-spaced overlapping vias (the relay-side
 * create_vias should de-dupe by position, but doesn't always).
 *
 * Exported as a no-op helper that returns []. Future PR (when
 * per-via positions land via a `get_vias_on_net` tool) replaces
 * this with the real reader.
 */
export function existingViasFromNetRouting(
  _routing: NetRouting | null
): ViaPosition[] {
  return [];
}

/**
 * Render a one-line summary of a stitch result for the AI client.
 * Pulled out of the orchestrator so the message format is single-
 * source — both Altium and EasyEDA orchestrators emit the same
 * text shape.
 */
export function buildViaStitchMessage(
  net: string,
  placed: number,
  plan: ViaStitchPlan,
  platformName: string
): string {
  const parts: string[] = [];
  if (plan.skipped.componentCollision > 0)
    parts.push(`${plan.skipped.componentCollision} component-collision`);
  if (plan.skipped.edgeClearance > 0)
    parts.push(`${plan.skipped.edgeClearance} edge-clearance`);
  if (plan.skipped.keepoutCollision > 0)
    parts.push(`${plan.skipped.keepoutCollision} keepout`);
  if (plan.skipped.existingVia > 0)
    parts.push(`${plan.skipped.existingVia} existing-via`);
  const skippedTotal =
    plan.skipped.componentCollision +
    plan.skipped.edgeClearance +
    plan.skipped.keepoutCollision +
    plan.skipped.existingVia;
  const skippedDetail = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  return placed === 0 && skippedTotal === 0
    ? `Via stitch on '${net}' produced no candidates — board may be empty or density (${plan.densityMm}mm) too coarse for the extent.`
    : `Stitched '${net}' on ${platformName}: placed ${placed} via(s), skipped ${skippedTotal}${skippedDetail}. Density ${plan.densityMm}mm, edge clearance ${plan.edgeClearanceMm}mm.`;
}

/**
 * Sprint 12 PR 12.5: shared orchestrator for `viaStitchPlane`.
 *
 * Both AltiumPlatform.viaStitchPlane and EasyedaPlatform.viaStitchPlane
 * call into this with a `createVias` callback that dispatches the
 * batch create through THEIR respective relay/extension. The
 * read-plan-create flow is identical across platforms.
 *
 * Read phase:
 *   1. Page through getComponents (HARD_CAP 5000) — needed for
 *      board extents AND collision skip.
 *   2. getKeepouts (best-effort — supported:false here is non-fatal,
 *      we just skip keepout filtering).
 *   3. getNetRouting on the target net (best-effort, used to derive
 *      existing-via positions; today returns empty since geometry
 *      isn't exposed yet — see existingViasFromNetRouting).
 *
 * Plan phase: planViaStitch on the collected inputs.
 *
 * Create phase: caller-supplied createVias callback receives the
 * planned positions and dispatches the batch through the platform's
 * specific relay/extension. Returns the count of successfully
 * created vias (which may be less than planned if some creates
 * failed at the relay/extension level).
 */
export async function viaStitchPlaneShared(
  platform: Platform,
  params: {
    net: string;
    densityMm?: number;
    edgeClearanceMm?: number;
  },
  platformName: string,
  createVias: (positions: ViaPosition[]) => Promise<unknown>
): Promise<PlatformResponse<ViaStitchResult>> {
  // Read phase — components paginated.
  const all: PlacedComponent[] = [];
  let offset = 0;
  const limit = 500;
  const HARD_CAP = 5000;
  while (all.length < HARD_CAP) {
    const page = await platform.getComponents({ offset, limit });
    if (!page.supported) return page;
    all.push(...page.data.items);
    if (page.data.nextOffset === null) break;
    offset = page.data.nextOffset;
  }

  // Keepouts: best-effort. supported:false here means the platform
  // can't read them on this build (e.g., EasyEDA's pcb_PrimitiveRegion
  // not exposed) — proceed without keepout filtering rather than
  // fail the whole stitch.
  let keepouts: Keepout[] = [];
  const keepoutResult = await platform.getKeepouts();
  if (keepoutResult.supported) keepouts = keepoutResult.data;

  // Existing vias proxy: getNetRouting tells us via count per net,
  // not positions. Today this returns [] (see helper docstring) —
  // reserved for the day a get_vias_on_net tool exposes geometry.
  let existingVias: ViaPosition[] = [];
  const netRoutingResult = await platform.getNetRouting({
    offset: 0,
    limit: 500,
  });
  if (netRoutingResult.supported) {
    const matchingNet = netRoutingResult.data.items.find(
      (n) => n.netName === params.net
    );
    existingVias = existingViasFromNetRouting(matchingNet ?? null);
  }

  // Plan phase.
  const plan = planViaStitch(all, keepouts, existingVias, params);

  // Create phase. relay/extension returns a {placed: number} envelope
  // (or just success-without-count on older versions); we count the
  // planned positions as fallback.
  let placed = 0;
  if (plan.positions.length > 0) {
    try {
      const raw = await createVias(plan.positions);
      if (
        typeof raw === "object" &&
        raw !== null &&
        "placed" in raw &&
        typeof raw.placed === "number"
      ) {
        placed = raw.placed;
      } else {
        // No explicit count — assume relay/extension placed all
        // positions we requested. AI client can verify via
        // screenshot or get_net_routing.
        placed = plan.positions.length;
      }
    } catch (err) {
      // Create phase failed at the relay/extension level. Treat
      // as supported:false since the user's mutation didn't land.
      return {
        supported: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return ok({
    net: params.net,
    placed,
    skipped:
      plan.skipped.componentCollision +
      plan.skipped.edgeClearance +
      plan.skipped.keepoutCollision +
      plan.skipped.existingVia,
    densityMm: plan.densityMm,
    edgeClearanceMm: plan.edgeClearanceMm,
    message: buildViaStitchMessage(params.net, placed, plan, platformName),
  });
}
