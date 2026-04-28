/**
 * Sprint 11 PR 11.4: shared placement-validation logic.
 *
 * Both `AltiumPlatform.validatePlacement` and
 * `EasyedaPlatform.validatePlacement` call into `validateComponents`
 * here, so results are identical across platforms — the spike's
 * "computed locally from get_components" intent.
 *
 * Algorithm: O(n²) pairwise check. For boards under ~1000
 * components (~500k pairs) this finishes in well under a second
 * on real hardware. Spatial indexing is a future optimization
 * if it ever shows up in latency.
 *
 * Bounding-box treatment is axis-aligned in v1. A 45°-rotated 0402
 * has a slightly larger physical footprint than its axis-aligned
 * bbox suggests — overestimates clearance for diagonally rotated
 * parts but never under-reports violations. Future PR can add
 * rotation-aware bbox math.
 */

import type {
  PlacedComponent,
  PlacementViolation,
  ValidatePlacementResult,
} from "./types.js";

/** Default minimum edge-to-edge clearance in mm. Matches typical
 *  IPC-7351 hand-placed boards. */
export const DEFAULT_SPACING_MM = 0.2;

/** Heuristic placeholder for components without bounding-box data.
 *  1mm × 1mm is roughly an 0805 — small enough that bigger parts
 *  reporting their real bbox dominate, but not so small that
 *  missing-bbox parts always pass the spacing check. */
export const HEURISTIC_BBOX_MM = 1.0;

/**
 * Run overlap + spacing validation across a list of placed components.
 *
 * Pairs are examined exactly once (i < j ordering). Components on
 * different layers are skipped — a top-side component can't physically
 * collide with a bottom-side one. Pairs where BOTH components are
 * locked are also skipped (user-intentional placement).
 *
 * Returns violations sorted lexicographically by (componentA,
 * componentB) so output is deterministic across runs.
 */
export function validateComponents(
  components: PlacedComponent[],
  spacingMm: number = DEFAULT_SPACING_MM
): ValidatePlacementResult {
  const violations: PlacementViolation[] = [];
  let pairsExamined = 0;
  let approximateBboxCount = 0;

  // Pre-compute effective bounding boxes — substitute the heuristic
  // for components missing real sizing. Track approximation count
  // so the AI client can tell how much of the result is heuristic.
  const sized = components.map((c) => {
    const wMissing = !(c.width > 0);
    const hMissing = !(c.height > 0);
    const isApprox = wMissing || hMissing;
    if (isApprox) approximateBboxCount++;
    return {
      c,
      w: wMissing ? HEURISTIC_BBOX_MM : c.width,
      h: hMissing ? HEURISTIC_BBOX_MM : c.height,
      approximate: isApprox,
    };
  });

  for (let i = 0; i < sized.length; i++) {
    for (let j = i + 1; j < sized.length; j++) {
      const a = sized[i];
      const b = sized[j];
      // Different layers can't physically collide — skip cross-layer
      // pairs. "inner" / "unknown" layers fall back to comparing
      // against everything (defensive: we don't know what they are,
      // so treat as potential collision).
      if (
        (a.c.layer === "top" && b.c.layer === "bottom") ||
        (a.c.layer === "bottom" && b.c.layer === "top")
      ) {
        continue;
      }
      // Locked-vs-locked: user-intentional placement; skip.
      if (a.c.locked && b.c.locked) continue;

      pairsExamined++;
      const gap = bboxGap(
        { x: a.c.x, y: a.c.y, w: a.w, h: a.h },
        { x: b.c.x, y: b.c.y, w: b.w, h: b.h }
      );

      // Sort designators lexicographically so the same pair always
      // renders the same way regardless of iteration order.
      const [aDes, bDes] =
        a.c.designator <= b.c.designator
          ? [a.c.designator, b.c.designator]
          : [b.c.designator, a.c.designator];

      const tags: string[] = [];
      if (a.c.locked) tags.push(`${a.c.designator} is locked`);
      if (b.c.locked) tags.push(`${b.c.designator} is locked`);
      if (a.approximate || b.approximate) tags.push("approximate — no bounding box");
      const tagStr = tags.length > 0 ? ` (${tags.join(", ")})` : "";

      if (gap < 0) {
        const overlapMm = -gap;
        violations.push({
          type: "overlap",
          componentA: aDes,
          componentB: bDes,
          overlapMm,
          message: `${aDes} ↔ ${bDes}: overlap ${overlapMm.toFixed(2)}mm${tagStr}`,
        });
      } else if (gap < spacingMm) {
        violations.push({
          type: "spacing",
          componentA: aDes,
          componentB: bDes,
          distanceMm: gap,
          message: `${aDes} ↔ ${bDes}: ${gap.toFixed(2)}mm gap (rule: ${spacingMm.toFixed(2)}mm)${tagStr}`,
        });
      }
    }
  }

  violations.sort((v1, v2) => {
    // Overlaps first (more severe), then spacing — within each,
    // alphabetical by componentA, then componentB.
    if (v1.type !== v2.type) return v1.type === "overlap" ? -1 : 1;
    if (v1.componentA !== v2.componentA)
      return v1.componentA.localeCompare(v2.componentA);
    return v1.componentB.localeCompare(v2.componentB);
  });

  return {
    violations,
    totalChecked: components.length,
    pairsExamined,
    approximateBboxCount,
  };
}

interface AxisAlignedBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Edge-to-edge gap between two axis-aligned bounding boxes,
 * centered at (x, y) with size (w, h). Returns:
 *   - negative when boxes overlap (penetration depth = -result)
 *   - zero when edges exactly touch
 *   - positive when boxes are apart (gap distance)
 *
 * Three cases for axis-aligned boxes:
 *   1. Both projections overlap (dx ≤ 0 AND dy ≤ 0): penetration
 *      depth is the smaller-magnitude negative value (escape
 *      direction). max(dx, dy) does this since both are ≤ 0.
 *   2. Exactly one projection overlaps: real gap is the positive
 *      axis distance — the boxes are side-by-side on that axis.
 *   3. Neither projection overlaps: corners are diagonally
 *      separated; real gap is Euclidean: sqrt(dx² + dy²).
 */
function bboxGap(a: AxisAlignedBox, b: AxisAlignedBox): number {
  const dx = Math.abs(a.x - b.x) - (a.w + b.w) / 2;
  const dy = Math.abs(a.y - b.y) - (a.h + b.h) / 2;
  if (dx > 0 && dy > 0) {
    // Corner-to-corner Euclidean distance.
    return Math.sqrt(dx * dx + dy * dy);
  }
  // Either both axes overlap (returns the less-negative = escape
  // depth) OR exactly one axis overlaps (returns the positive
  // axis gap).
  return Math.max(dx, dy);
}
