/**
 * Sprint 11 PR 11.4: validation-logic tests.
 *
 * Pin the bbox-gap math and the overlap/spacing classification.
 * These are pure-logic tests against `validateComponents` — the
 * platform wiring (AltiumPlatform.validatePlacement /
 * EasyedaPlatform.validatePlacement) is tested separately in
 * platforms.test.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateComponents, DEFAULT_SPACING_MM } from "./placement-validation.js";
import type { PlacedComponent } from "./types.js";

function makeComponent(
  designator: string,
  overrides: Partial<PlacedComponent> = {}
): PlacedComponent {
  return {
    primitiveId: `prim_${designator}`,
    designator,
    mpn: "",
    footprint: "0402",
    x: 0,
    y: 0,
    layer: "top",
    rotation: 0,
    locked: false,
    width: 1,
    height: 0.5,
    raw: null,
    ...overrides,
  };
}

test("validateComponents: empty board → zero violations, zero pairs", () => {
  const result = validateComponents([]);
  assert.equal(result.violations.length, 0);
  assert.equal(result.totalChecked, 0);
  assert.equal(result.pairsExamined, 0);
});

test("validateComponents: well-spaced parts on same layer → no violations", () => {
  // Two 1x0.5mm parts at x=0 and x=10 → 9.5mm edge-to-edge gap,
  // way above the 0.2mm default. Should not flag.
  const components = [
    makeComponent("R1", { x: 0, y: 0 }),
    makeComponent("R2", { x: 10, y: 0 }),
  ];
  const result = validateComponents(components);
  assert.equal(result.violations.length, 0);
  assert.equal(result.totalChecked, 2);
  assert.equal(result.pairsExamined, 1);
});

test("validateComponents: overlapping parts → overlap violation with positive overlapMm + sorted designators", () => {
  // Two 1x1mm parts centered at (0,0) and (0.5,0): centers are
  // 0.5mm apart on x; bbox sum/2 = 1.0; gap = 0.5 - 1.0 = -0.5mm
  // → overlap of 0.5mm. Both axes overlap (dy = -1 since y centers
  // identical with 1mm-tall boxes), so penetration = max(-0.5, -1)
  // = -0.5 (escape via x).
  const components = [
    makeComponent("R2", { x: 0, y: 0, width: 1, height: 1 }),
    makeComponent("R1", { x: 0.5, y: 0, width: 1, height: 1 }),
  ];
  const result = validateComponents(components);
  assert.equal(result.violations.length, 1);
  const v = result.violations[0];
  assert.equal(v.type, "overlap");
  // Designators sorted lexicographically: R1 before R2 even
  // though R2 was first in input.
  assert.equal(v.componentA, "R1");
  assert.equal(v.componentB, "R2");
  assert.ok(v.overlapMm !== undefined);
  if (v.overlapMm !== undefined) {
    assert.ok(Math.abs(v.overlapMm - 0.5) < 1e-6);
  }
});

test("validateComponents: spacing violation when gap is positive but below rule", () => {
  // Two 1x1mm parts at x=0 and x=1.1: gap = 1.1 - 1.0 = 0.1mm,
  // below the default 0.2mm spacing rule but not overlapping.
  const components = [
    makeComponent("C1", { x: 0, y: 0, width: 1, height: 1 }),
    makeComponent("C2", { x: 1.1, y: 0, width: 1, height: 1 }),
  ];
  const result = validateComponents(components);
  assert.equal(result.violations.length, 1);
  const v = result.violations[0];
  assert.equal(v.type, "spacing");
  assert.ok(v.distanceMm !== undefined);
  if (v.distanceMm !== undefined) {
    assert.ok(Math.abs(v.distanceMm - 0.1) < 1e-6);
  }
  // Caller passes a custom spacing rule and the message reflects it.
  const looser = validateComponents(components, 0.05);
  assert.equal(looser.violations.length, 0, "0.05mm rule passes the 0.1mm gap");
});

test("validateComponents: locked-vs-locked pair is skipped (user-intentional)", () => {
  // Two locked parts overlapping each other should NOT flag.
  const components = [
    makeComponent("U1", { x: 0, y: 0, width: 1, height: 1, locked: true }),
    makeComponent("U2", { x: 0.1, y: 0, width: 1, height: 1, locked: true }),
  ];
  const result = validateComponents(components);
  assert.equal(result.violations.length, 0);
  // Pairs examined drops to 0 — both-locked pairs don't even
  // get the gap calculation.
  assert.equal(result.pairsExamined, 0);
});

test("validateComponents: locked-vs-unlocked pair IS flagged + message includes the lock note", () => {
  // The user moved an unlocked component too close to a locked
  // obstacle; the AI client needs to know.
  const components = [
    makeComponent("U1", { x: 0, y: 0, width: 1, height: 1, locked: true }),
    makeComponent("R1", { x: 0.3, y: 0, width: 1, height: 1, locked: false }),
  ];
  const result = validateComponents(components);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].type, "overlap");
  // The "(... is locked)" tag must appear in the message so AI
  // clients can tell which side is the immovable obstacle.
  assert.match(result.violations[0].message, /U1 is locked/);
});

test("validateComponents: cross-layer pairs (top vs bottom) are skipped — can't physically collide", () => {
  // A top-side part and a bottom-side part at the same x/y don't
  // collide — they're on opposite sides of the board.
  const components = [
    makeComponent("R1", { x: 0, y: 0, layer: "top" }),
    makeComponent("R2", { x: 0, y: 0, layer: "bottom" }),
  ];
  const result = validateComponents(components);
  assert.equal(result.violations.length, 0);
  assert.equal(result.pairsExamined, 0, "cross-layer pair must not even be examined");
});

test("validateComponents: missing bounding box → 1mm heuristic + approximate flag in message + count", () => {
  // Both parts have width=0/height=0 (relay/extension couldn't
  // extract). Validator falls back to 1mm placeholder, flags the
  // result as approximate.
  const components = [
    makeComponent("R1", { x: 0, y: 0, width: 0, height: 0 }),
    makeComponent("R2", { x: 0.3, y: 0, width: 0, height: 0 }),
  ];
  const result = validateComponents(components);
  assert.equal(result.approximateBboxCount, 2);
  assert.equal(result.violations.length, 1);
  assert.match(result.violations[0].message, /approximate/);
});

test("validateComponents: corner-separated boxes → Euclidean diagonal gap, not max axis", () => {
  // The math edge case from the self-review: when boxes don't
  // overlap on EITHER axis, the gap is the diagonal corner-to-
  // corner distance, not the max of per-axis gaps.
  // Two 1x1 boxes at (0,0) and (2,2): per-axis gaps are 1 and 1;
  // real corner gap is sqrt(2) ≈ 1.414. The 0.2mm rule passes
  // (real gap > rule), but a tighter rule like 1.5 would flag.
  const components = [
    makeComponent("R1", { x: 0, y: 0, width: 1, height: 1 }),
    makeComponent("R2", { x: 2, y: 2, width: 1, height: 1 }),
  ];
  const ruleAt15 = validateComponents(components, 1.5);
  assert.equal(ruleAt15.violations.length, 1, "real diagonal gap (~1.414) is below 1.5mm rule");
  if (ruleAt15.violations[0].distanceMm !== undefined) {
    const expected = Math.sqrt(2);
    assert.ok(
      Math.abs(ruleAt15.violations[0].distanceMm - expected) < 1e-6,
      `expected diagonal gap ≈ ${expected}, got ${ruleAt15.violations[0].distanceMm}`
    );
  }
});

test("validateComponents: violations are sorted overlaps-first then alphabetical", () => {
  // Three parts: a spacing violation between R8↔R9, an overlap
  // between R1↔R2, and another overlap between R3↔R4. Sorted
  // result: overlaps first (R1↔R2, then R3↔R4), then spacing
  // (R8↔R9). Keeps output deterministic across runs regardless
  // of input order.
  const components = [
    makeComponent("R8", { x: 100, y: 0, width: 1, height: 1 }),
    makeComponent("R9", { x: 101.1, y: 0, width: 1, height: 1 }), // spacing 0.1
    makeComponent("R3", { x: 0, y: 50, width: 1, height: 1 }),
    makeComponent("R4", { x: 0.5, y: 50, width: 1, height: 1 }), // overlap 0.5
    makeComponent("R1", { x: 0, y: 0, width: 1, height: 1 }),
    makeComponent("R2", { x: 0.3, y: 0, width: 1, height: 1 }), // overlap 0.7
  ];
  const result = validateComponents(components);
  assert.equal(result.violations.length, 3);
  assert.equal(result.violations[0].type, "overlap");
  assert.equal(result.violations[0].componentA, "R1");
  assert.equal(result.violations[1].type, "overlap");
  assert.equal(result.violations[1].componentA, "R3");
  assert.equal(result.violations[2].type, "spacing");
  assert.equal(result.violations[2].componentA, "R8");
});

test("DEFAULT_SPACING_MM constant: matches typical IPC-7351 hand-placed default", () => {
  // Pin the constant so a future PR can't silently change the
  // default behavior. Tooling docs reference 0.2mm.
  assert.equal(DEFAULT_SPACING_MM, 0.2);
});
