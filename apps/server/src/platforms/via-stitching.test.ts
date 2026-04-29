/**
 * Sprint 12 PR 12.5: pure-logic tests for the via-stitching planner.
 *
 * Wiring tests (orchestration through getComponents + create_vias)
 * live in platforms.test.ts. These tests exercise the planner in
 * isolation against constructed component/keepout fixtures.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_DENSITY_MM,
  DEFAULT_EDGE_CLEARANCE_MM,
  buildViaStitchMessage,
  planViaStitch,
} from "./via-stitching.js";
import type { Keepout, PlacedComponent } from "./types.js";

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

test("planViaStitch: empty board → empty positions, zero candidates", () => {
  const plan = planViaStitch([], [], [], { net: "GND" });
  assert.equal(plan.positions.length, 0);
  assert.equal(plan.candidates, 0);
});

test("planViaStitch: 50x50 extent at 5mm density generates a square-ish grid minus edge clearance", () => {
  // Two corner components define the extent. With pad-by-density=5mm
  // on each side, the actual grid extent is roughly 60x60mm.
  const components = [
    makeComponent("U1", { x: 0, y: 0 }),
    makeComponent("U2", { x: 50, y: 50 }),
  ];
  const plan = planViaStitch(components, [], [], { net: "GND" });
  assert.equal(plan.densityMm, DEFAULT_DENSITY_MM);
  assert.equal(plan.edgeClearanceMm, DEFAULT_EDGE_CLEARANCE_MM);
  // Padded extent: x ∈ [-5, 55], y ∈ [-5, 55] → 13×13 = 169 candidates
  // at 5mm spacing inclusive on both ends.
  assert.equal(plan.candidates, 169);
  // Edge clearance trims the outer ring.
  assert.ok(plan.skipped.edgeClearance > 0);
  // Component collisions at (0,0) and (50,50) — exact count depends
  // on whether the candidate-grid lands exactly on the component
  // centroids, but at least one should hit.
  assert.ok(plan.positions.length > 0);
  // Sanity: every emitted position is within the extent
  for (const p of plan.positions) {
    assert.ok(p.x >= -5 && p.x <= 55);
    assert.ok(p.y >= -5 && p.y <= 55);
  }
});

test("planViaStitch: density below 1mm clamped to 1mm — pathological grids prevented", () => {
  // 0.5mm density on a 100mm board = 40k candidates. The clamp
  // prevents that without forcing the caller to know the floor.
  const plan = planViaStitch(
    [makeComponent("U1", { x: 0, y: 0 }), makeComponent("U2", { x: 10, y: 10 })],
    [],
    [],
    { net: "GND", densityMm: 0.5 }
  );
  assert.equal(plan.densityMm, 1.0, "density must be clamped to MIN_DENSITY_MM=1");
});

test("planViaStitch: skips candidates inside component bboxes", () => {
  // A 10×10mm component centered at (10, 10) with bbox 6x6 should
  // block any grid candidate within ±3mm of (10,10). At default
  // 5mm density, the candidate at exactly (10, 10) gets skipped.
  const components = [
    makeComponent("BIG", { x: 10, y: 10, width: 6, height: 6 }),
    makeComponent("FAR", { x: 30, y: 30, width: 1, height: 1 }),
  ];
  const plan = planViaStitch(components, [], [], { net: "GND" });
  assert.ok(plan.skipped.componentCollision >= 1);
  // No emitted position falls inside the BIG bbox
  for (const p of plan.positions) {
    const insideBig =
      Math.abs(p.x - 10) < 3 && Math.abs(p.y - 10) < 3;
    assert.equal(insideBig, false, `position (${p.x},${p.y}) inside BIG bbox`);
  }
});

test("planViaStitch: skips candidates inside via-kind keepouts", () => {
  // Place a small keepout polygon. Candidates inside it must be
  // skipped + counted under skipped.keepoutCollision.
  const components = [
    makeComponent("U1", { x: 0, y: 0 }),
    makeComponent("U2", { x: 30, y: 30 }),
  ];
  const keepouts: Keepout[] = [
    {
      id: "kpo-1",
      kind: "via",
      layer: "all",
      vertices: [
        { x: 10, y: 10 },
        { x: 20, y: 10 },
        { x: 20, y: 20 },
        { x: 10, y: 20 },
      ],
      raw: null,
    },
  ];
  const plan = planViaStitch(components, keepouts, [], { net: "GND" });
  assert.ok(plan.skipped.keepoutCollision > 0);
  // No emitted position inside the keepout bbox (10..20, 10..20)
  for (const p of plan.positions) {
    const inKeepout =
      p.x >= 10 && p.x <= 20 && p.y >= 10 && p.y <= 20;
    assert.equal(inKeepout, false, `position (${p.x},${p.y}) inside keepout`);
  }
});

test("planViaStitch: 'placement' kind keepouts are NOT used for via filtering", () => {
  // Only via/routing/all keepouts apply to vias. A placement-kind
  // keepout should NOT block via placement.
  const components = [
    makeComponent("U1", { x: 0, y: 0 }),
    makeComponent("U2", { x: 30, y: 30 }),
  ];
  const keepouts: Keepout[] = [
    {
      id: "placement-kpo",
      kind: "placement",
      layer: "all",
      vertices: [
        { x: 10, y: 10 },
        { x: 20, y: 10 },
        { x: 20, y: 20 },
        { x: 10, y: 20 },
      ],
      raw: null,
    },
  ];
  const plan = planViaStitch(components, keepouts, [], { net: "GND" });
  assert.equal(plan.skipped.keepoutCollision, 0,
    "placement-kind keepouts must not block vias");
});

test("planViaStitch: existing-via collision skips within VIA_VIA_CLEARANCE_MM", () => {
  // Three pre-existing vias near grid points. Any candidate within
  // 0.5mm of an existing via must be skipped.
  const components = [
    makeComponent("U1", { x: 0, y: 0 }),
    makeComponent("U2", { x: 30, y: 30 }),
  ];
  const existingVias = [
    { x: 5, y: 5 },
    { x: 10, y: 10 },
    { x: 15, y: 15 },
  ];
  const plan = planViaStitch(components, [], existingVias, { net: "GND" });
  assert.ok(plan.skipped.existingVia >= 3,
    "each existing via should block at least one grid candidate");
  // No emitted position within 0.5mm of any existing via
  for (const p of plan.positions) {
    for (const v of existingVias) {
      const d = Math.sqrt((p.x - v.x) ** 2 + (p.y - v.y) ** 2);
      assert.ok(d >= 0.5, `position (${p.x},${p.y}) too close to via (${v.x},${v.y})`);
    }
  }
});

test("buildViaStitchMessage: rendering includes per-reason skip breakdown", () => {
  // Pin the message format AI clients see — per-reason counts so
  // the AI can reason about why coverage is sparse.
  const msg = buildViaStitchMessage(
    "GND",
    142,
    {
      positions: [],
      candidates: 200,
      skipped: {
        edgeClearance: 11,
        componentCollision: 12,
        keepoutCollision: 0,
        existingVia: 0,
      },
      densityMm: 5,
      edgeClearanceMm: 1.5,
    },
    "easyeda"
  );
  assert.match(msg, /Stitched 'GND' on easyeda/);
  assert.match(msg, /placed 142/);
  assert.match(msg, /23 skipped|skipped 23/);
  assert.match(msg, /12 component-collision/);
  assert.match(msg, /11 edge-clearance/);
  // No keepout/existing-via counts since they're zero
  assert.doesNotMatch(msg, /keepout/);
});

test("buildViaStitchMessage: zero placed AND zero skipped → 'no candidates' diagnostic", () => {
  const msg = buildViaStitchMessage(
    "GND",
    0,
    {
      positions: [],
      candidates: 0,
      skipped: {
        edgeClearance: 0,
        componentCollision: 0,
        keepoutCollision: 0,
        existingVia: 0,
      },
      densityMm: 5,
      edgeClearanceMm: 1.5,
    },
    "altium"
  );
  assert.match(msg, /no candidates/i);
  assert.match(msg, /density.*5mm.*coarse|board.*empty/i);
});
