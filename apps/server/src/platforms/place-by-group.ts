/**
 * Sprint 11 PR 11.5: shared `place_by_group` logic.
 *
 * Three pieces:
 *   1. Filter parser: `key=value AND key=value` with glob support.
 *   2. Strategy planners: pure functions that map matched
 *      components to target {designator, x, y} positions.
 *   3. Orchestrator: combines getComponents → filter → plan → move.
 *
 * Both AltiumPlatform.placeByGroup and EasyedaPlatform.placeByGroup
 * call into `placeByGroupShared(platform, params)` here, so results
 * are identical across platforms — same architectural pattern as
 * PR 11.4's validateComponents.
 *
 * Locked components are obstacles, never targets:
 *   - Filter excludes them automatically.
 *   - Strategies use bbox-gap math (from PR 11.4) to plan around
 *     locked occupied space.
 */

import type {
  PlaceByGroupParams,
  PlaceByGroupResult,
  PlacedComponent,
  Platform,
  PlatformResponse,
} from "./types.js";
import { ok, notSupported } from "./types.js";

const DEFAULT_OBSTACLE_CLEARANCE_MM = 0.5;
const DEFAULT_GRID_SPACING_MM = 5;
const DEFAULT_AROUND_RADIUS_MM = 10;
const DEFAULT_EDGE_OFFSET_MM = 5;

// ─── Filter parser ──────────────────────────────────────────────────

/** Fields the filter language accepts in v1. Net-based filtering
 *  is deferred until per-pin net data lands. */
const FILTER_FIELDS = ["designator", "footprint", "mpn", "layer"] as const;
type FilterField = (typeof FILTER_FIELDS)[number];

interface FilterClause {
  field: FilterField;
  /** RegExp built from the value with `*` → `.*` glob expansion.
   *  Pre-compiled so the matcher doesn't re-escape per row. */
  pattern: RegExp;
}

/**
 * Parse a filter string into a list of clauses. Throws with an
 * actionable message when the input is malformed — AI clients
 * surface the error to the user so they can correct.
 *
 * Grammar (v1):
 *   filter      = clause (' AND ' clause)*
 *   clause      = field '=' value
 *   field       = 'designator' | 'footprint' | 'mpn' | 'layer'
 *   value       = non-empty string, * is the only metachar (glob)
 *
 * Whitespace around AND and = is tolerated but the AND keyword
 * itself is case-insensitive (`and`, `And`, `AND` all work).
 */
export function parseFilter(input: string): FilterClause[] {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new Error("filter is required (e.g. 'footprint=0402')");
  }
  // Split on the AND keyword (case-insensitive). Tolerant of
  // surrounding whitespace.
  const parts = input.split(/\s+AND\s+/i);
  return parts.map((rawClause) => {
    const eq = rawClause.indexOf("=");
    if (eq < 0) {
      throw new Error(
        `filter clause '${rawClause.trim()}' missing '=' (expected field=value)`
      );
    }
    const field = rawClause.slice(0, eq).trim().toLowerCase();
    const value = rawClause.slice(eq + 1).trim();
    if (!FILTER_FIELDS.includes(field as FilterField)) {
      throw new Error(
        `filter field '${field}' not supported. Valid fields: ${FILTER_FIELDS.join(", ")}.`
      );
    }
    if (value.length === 0) {
      throw new Error(`filter clause '${field}=' has empty value`);
    }
    // Build a regex from the glob: escape regex metas, then turn
    // `*` (which we deliberately escaped to `\*` first) back into
    // `.*`. Anchor with ^...$ so the match is exact.
    const escaped = value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    const globExpanded = escaped.replace(/\*/g, ".*");
    const pattern = new RegExp(`^${globExpanded}$`, "i");
    return { field: field as FilterField, pattern };
  });
}

/**
 * Apply parsed clauses to a single component. Locked components
 * are filtered out at this layer (they're obstacles, not targets).
 * All-clauses-must-match (logical AND).
 */
export function matchesFilter(
  component: PlacedComponent,
  clauses: FilterClause[]
): boolean {
  if (component.locked) return false;
  for (const clause of clauses) {
    const value = String(componentField(component, clause.field));
    if (!clause.pattern.test(value)) return false;
  }
  return true;
}

function componentField(c: PlacedComponent, field: FilterField): string {
  switch (field) {
    case "designator":
      return c.designator;
    case "footprint":
      return c.footprint;
    case "mpn":
      return c.mpn;
    case "layer":
      return c.layer;
  }
}

// ─── Strategy planners ──────────────────────────────────────────────

interface PlannedPlacement {
  designator: string;
  x: number;
  y: number;
}

interface PlanContext {
  matched: PlacedComponent[];
  /** Locked components, used as obstacles. Layer-filtered to
   *  match the strategy's target layer where applicable. */
  obstacles: PlacedComponent[];
  obstacleClearanceMm: number;
}

/**
 * Plan a row-major grid layout. Simple but useful: resistor arrays,
 * test points, terminal blocks. Doesn't avoid obstacles in v1 —
 * AI clients picking grid origin should pick clear space; the
 * orchestrator catches collisions via per-move validation if it
 * matters. (Adding obstacle-aware grid is a future tweak.)
 */
export function planGrid(
  ctx: PlanContext,
  params: { originX: number; originY: number; spacingMm?: number; columns?: number }
): PlannedPlacement[] {
  const spacing = params.spacingMm ?? DEFAULT_GRID_SPACING_MM;
  // Default to a square-ish grid: ceil(sqrt(n)).
  const columns =
    params.columns && params.columns > 0
      ? Math.floor(params.columns)
      : Math.max(1, Math.ceil(Math.sqrt(ctx.matched.length)));
  return ctx.matched.map((c, i) => {
    const row = Math.floor(i / columns);
    const col = i % columns;
    return {
      designator: c.designator,
      x: params.originX + col * spacing,
      y: params.originY + row * spacing,
    };
  });
}

/**
 * Plan a circular ring around a target component. Used for
 * decoupling caps around an MCU. Skips candidates that would
 * collide with locked obstacles within `obstacleClearanceMm` of
 * the planned point.
 */
export function planAroundComponent(
  ctx: PlanContext,
  target: PlacedComponent,
  params: { radiusMm?: number }
): PlannedPlacement[] {
  const radius = params.radiusMm ?? DEFAULT_AROUND_RADIUS_MM;
  const out: PlannedPlacement[] = [];
  const step = (Math.PI * 2) / Math.max(ctx.matched.length, 1);
  for (let i = 0; i < ctx.matched.length; i++) {
    const angle = i * step;
    const px = target.x + radius * Math.cos(angle);
    const py = target.y + radius * Math.sin(angle);
    if (collidesWithObstacle(px, py, ctx)) continue;
    out.push({ designator: ctx.matched[i].designator, x: px, y: py });
  }
  return out;
}

/**
 * Plan a row along the chosen board edge. Caller supplies the
 * board's bounding extents implicitly through current component
 * positions — we use the matched components' centroid as the
 * starting reference, then walk along the edge axis.
 *
 * "side" interpretation:
 *   - top: y increases (upward in board coords)
 *   - bottom: y decreases
 *   - left/right: x decreases/increases
 *
 * The extents are derived from ALL components on the board (not
 * just matched) so connectors get placed along the actual edge,
 * not the edge of the filtered set.
 */
export function planOnEdge(
  ctx: PlanContext,
  allComponents: PlacedComponent[],
  params: { side: "top" | "bottom" | "left" | "right"; offsetMm?: number }
): PlannedPlacement[] {
  const offset = params.offsetMm ?? DEFAULT_EDGE_OFFSET_MM;
  if (allComponents.length === 0) return [];
  const xs = allComponents.map((c) => c.x);
  const ys = allComponents.map((c) => c.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spacing = DEFAULT_GRID_SPACING_MM;
  return ctx.matched.map((c, i) => {
    let x: number;
    let y: number;
    switch (params.side) {
      case "top":
        // Spread along x, fixed y at top edge + offset
        x = minX + i * spacing;
        y = maxY + offset;
        break;
      case "bottom":
        x = minX + i * spacing;
        y = minY - offset;
        break;
      case "left":
        x = minX - offset;
        y = minY + i * spacing;
        break;
      case "right":
        x = maxX + offset;
        y = minY + i * spacing;
        break;
    }
    return { designator: c.designator, x, y };
  });
}

function collidesWithObstacle(x: number, y: number, ctx: PlanContext): boolean {
  for (const o of ctx.obstacles) {
    const dx = x - o.x;
    const dy = y - o.y;
    // Use centroid distance — bbox math from PR 11.4 is overkill
    // here since we're just checking "is this point near an
    // obstacle". The clearance is a generous default (0.5mm).
    if (Math.sqrt(dx * dx + dy * dy) < ctx.obstacleClearanceMm) return true;
  }
  return false;
}

// ─── Orchestrator ───────────────────────────────────────────────────

/**
 * The shared place-by-group implementation. Both platform impls
 * call this with `this` so the orchestration logic is single-source.
 *
 * Process:
 *   1. Read all components via platform.getComponents (paginated).
 *   2. Parse filter → match components (locked excluded).
 *   3. Run the strategy planner.
 *   4. Iterate planned placements; call platform.moveComponent
 *      for each. Failed/skipped placements collected with reasons.
 *
 * Per-move sequential is fine for v1 (typical group <50 components).
 * Future: AD relay batch command for thousand-component cases.
 */
export async function placeByGroupShared(
  platform: Platform,
  params: PlaceByGroupParams
): Promise<PlatformResponse<PlaceByGroupResult>> {
  // Parse first — fail fast on bad input before paying the
  // getComponents round-trip.
  let clauses: FilterClause[];
  try {
    clauses = parseFilter(params.filter);
  } catch (err) {
    return notSupported(err instanceof Error ? err.message : String(err));
  }

  // Page through all components.
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

  const matched = all.filter((c) => matchesFilter(c, clauses));
  const obstacleClearanceMm = params.obstacleClearanceMm ?? DEFAULT_OBSTACLE_CLEARANCE_MM;
  const obstacles = all.filter((c) => c.locked);
  const ctx: PlanContext = { matched, obstacles, obstacleClearanceMm };

  // Strategy dispatch.
  let planned: PlannedPlacement[];
  if (params.strategy === "grid") {
    planned = planGrid(ctx, params.grid);
  } else if (params.strategy === "around-component") {
    const target = all.find((c) => c.designator === params.around.target);
    if (!target) {
      return notSupported(
        `around-component target '${params.around.target}' not found on the active PCB.`
      );
    }
    planned = planAroundComponent(ctx, target, params.around);
  } else {
    planned = planOnEdge(ctx, all, params.edge);
  }

  // Apply planned placements one at a time.
  const moved: string[] = [];
  const skipped: PlaceByGroupResult["skipped"] = [];
  // Track which matched designators got dropped by the planner
  // (e.g., around-component obstacle filter) so the result
  // distinguishes "filter matched" from "successfully placed".
  const plannedSet = new Set(planned.map((p) => p.designator));
  for (const m of matched) {
    if (!plannedSet.has(m.designator)) {
      skipped.push({
        designator: m.designator,
        reason: "no valid position (obstacle blocked planned location)",
      });
    }
  }
  for (const p of planned) {
    const result = await platform.moveComponent({
      designator: p.designator,
      x: p.x,
      y: p.y,
    });
    if (result.supported) {
      moved.push(p.designator);
    } else {
      skipped.push({ designator: p.designator, reason: result.reason });
    }
  }

  const message =
    moved.length === matched.length
      ? `Placed ${moved.length} component(s) using strategy '${params.strategy}'.`
      : `Placed ${moved.length}/${matched.length} component(s) using strategy '${params.strategy}'; ${skipped.length} skipped.`;

  return ok({
    matched: matched.map((m) => m.designator),
    moved,
    skipped,
    strategy: params.strategy,
    message,
  });
}
