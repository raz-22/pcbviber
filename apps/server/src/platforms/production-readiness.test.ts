/**
 * Sprint 13 PR 13.3: pure-logic tests for the DFM check
 * functions. Wiring tests (orchestrator round-tripping through a
 * stub Platform) live in platforms.test.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_BOARD_THICKNESS_MM,
  DEFAULT_COPPER_EDGE_CLEARANCE_MM,
  DEFAULT_DRILL_ASPECT_THRESHOLD,
  DEFAULT_MIN_FIDUCIALS,
  checkCopperEdge,
  checkDrillAspect,
  checkFiducials,
} from "./production-readiness.js";
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

// ─── checkDrillAspect ─────────────────────────────────────────────────

test("checkDrillAspect: v1 returns informational pass with the threshold + thickness in details", () => {
  // Pin the heuristic-status contract: AI clients see drill-
  // aspect-check is informational in v1 + know to ask elsewhere
  // until the polygon-plane read lands.
  const result = checkDrillAspect([], {
    drillAspectThreshold: 0.4,
    boardThicknessMm: 1.6,
  });
  assert.equal(result.category, "drill-aspect");
  assert.equal(result.passed, true);
  assert.equal(result.severity, "info");
  assert.match(result.message, /informational in v1/);
  assert.deepEqual(result.details, {
    threshold: 0.4,
    boardThicknessMm: 1.6,
    heuristic: true,
  });
});

// ─── checkCopperEdge ──────────────────────────────────────────────────

test("checkCopperEdge: empty board → pass with skip note", () => {
  const result = checkCopperEdge([], { copperEdgeClearanceMm: 0.2 });
  assert.equal(result.passed, true);
  assert.equal(result.severity, "info");
  assert.match(result.message, /No components placed/);
});

test("checkCopperEdge: component at extent corner flagged with designator + clearance in details", () => {
  // U1 at (0,0) sits exactly at minX/minY — its left/bottom edge
  // touches the extent boundary, so clearance check fails.
  const components = [
    makeComponent("U1", { x: 0, y: 0, width: 2, height: 2 }),
    makeComponent("U2", { x: 50, y: 50 }),
  ];
  const result = checkCopperEdge(components, { copperEdgeClearanceMm: 0.5 });
  assert.equal(result.passed, false);
  assert.equal(result.severity, "warning");
  assert.match(result.message, /U1/);
  assert.match(result.message, /0\.5mm of board edge/);
  const details = result.details as { components: string[] };
  assert.ok(details.components.includes("U1"));
  // U2 is at (50, 50) which is also the extent corner (only two
  // components define the extent), so it ALSO fails.
  assert.ok(details.components.includes("U2"));
});

test("checkCopperEdge: heuristic 1mm bbox fallback for components without size", () => {
  // Component with width=0/height=0 gets a 1mm bbox proxy. A
  // component at (0.4, 0.4) on a 0..20 extent has its left edge
  // at -0.1 (outside extent in x), so it fails the clearance.
  const components = [
    makeComponent("X1", { x: 0.4, y: 10, width: 0, height: 0 }),
    makeComponent("Z1", { x: 20, y: 10, width: 1, height: 1 }),
  ];
  const result = checkCopperEdge(components, { copperEdgeClearanceMm: 0.2 });
  assert.equal(result.passed, false);
  const details = result.details as { components: string[] };
  assert.ok(
    details.components.includes("X1"),
    "1mm fallback bbox must apply edge-clearance against extent"
  );
});

test("checkCopperEdge: 10+ flagged components → message truncated with '+N more'", () => {
  // Pin the rendering: don't dump 100 designators into the
  // message. Truncation footer points at the full count via
  // details.components.
  const components = Array.from({ length: 12 }, (_, i) =>
    makeComponent(`R${i}`, { x: 0, y: i, width: 2, height: 2 })
  );
  // Add a far-away component so extents are wider than the cluster.
  components.push(makeComponent("FAR", { x: 100, y: 100 }));
  const result = checkCopperEdge(components, { copperEdgeClearanceMm: 0.5 });
  assert.equal(result.passed, false);
  assert.match(result.message, /\+\d+ more/);
});

// ─── checkFiducials ───────────────────────────────────────────────────

test("checkFiducials: matches 'fiducial' / 'fid' / 'fmark' in footprint or designator", () => {
  // Pin the conservative match — designator "F1" alone does NOT
  // match (could be a fuse). Footprint "FIDUCIAL_1mm" matches.
  // Designator "FID1" matches (fid substring).
  const components = [
    makeComponent("F1"), // fuse-like, doesn't match
    makeComponent("R1"), // resistor, doesn't match
    makeComponent("FID1", { footprint: "0805" }), // designator matches "fid"
    makeComponent("U2", { footprint: "FIDUCIAL_1mm" }), // footprint matches
    makeComponent("MARK3", { footprint: "FMARK" }), // both match
  ];
  const result = checkFiducials(components, { minFiducials: 3 });
  assert.equal(result.passed, true,
    "FID1 + U2 + MARK3 → 3 fiducials, meets minimum");
  assert.equal(result.severity, "info");
});

test("checkFiducials: below minimum → warning with found-vs-required in details", () => {
  const components = [
    makeComponent("FID1", { footprint: "FIDUCIAL_1mm" }),
  ];
  const result = checkFiducials(components, { minFiducials: 3 });
  assert.equal(result.passed, false);
  assert.equal(result.severity, "warning");
  assert.match(result.message, /1 fiducial.*3 recommended/);
  assert.deepEqual(result.details, { found: 1, required: 3 });
});

test("checkFiducials: minFiducials=0 → skip the check (caller opt-out)", () => {
  // Pin the opt-out path: projects without fiducials (small
  // hand-soldered boards) shouldn't be flagged.
  const result = checkFiducials([], { minFiducials: 0 });
  assert.equal(result.passed, true);
  assert.equal(result.severity, "info");
  assert.match(result.message, /skipped/);
});

// ─── Default constants ────────────────────────────────────────────────

test("Production-readiness defaults match documented values", () => {
  // Pin so a future PR can't silently change the defaults.
  // Tooling docs and AI-client hints reference these.
  assert.equal(DEFAULT_DRILL_ASPECT_THRESHOLD, 0.4);
  assert.equal(DEFAULT_COPPER_EDGE_CLEARANCE_MM, 0.2);
  assert.equal(DEFAULT_MIN_FIDUCIALS, 3);
  assert.equal(DEFAULT_BOARD_THICKNESS_MM, 1.6);
});
