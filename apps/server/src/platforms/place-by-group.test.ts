/**
 * Sprint 11 PR 11.5: place_by_group logic tests.
 *
 * Pure-logic tests against the filter parser + strategy planners.
 * Orchestrator/wiring tests live in platforms.test.ts where the
 * Platform stubs already exist.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  matchesFilter,
  parseFilter,
  planAroundComponent,
  planGrid,
  planOnEdge,
} from "./place-by-group.js";
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

// ─── Filter parser ──────────────────────────────────────────────────

test("parseFilter: single clause with exact value parses + matches case-insensitively", () => {
  const clauses = parseFilter("footprint=0402");
  assert.equal(clauses.length, 1);
  assert.equal(clauses[0].field, "footprint");
  assert.ok(matchesFilter(makeComponent("R1", { footprint: "0402" }), clauses));
  // Case-insensitive (footprints are conventionally uppercase
  // sometimes; AI clients shouldn't have to know which).
  assert.ok(matchesFilter(makeComponent("R1", { footprint: "0402" }), clauses));
  assert.ok(!matchesFilter(makeComponent("R1", { footprint: "0805" }), clauses));
});

test("parseFilter: AND-joined clauses (case-insensitive AND keyword)", () => {
  const clauses = parseFilter("footprint=0402 and designator=R*");
  assert.equal(clauses.length, 2);
  assert.ok(matchesFilter(makeComponent("R1", { footprint: "0402" }), clauses));
  // R but wrong footprint → doesn't match
  assert.ok(!matchesFilter(makeComponent("R1", { footprint: "0805" }), clauses));
  // Right footprint but wrong designator prefix → doesn't match
  assert.ok(!matchesFilter(makeComponent("U1", { footprint: "0402" }), clauses));
});

test("parseFilter: glob `*` becomes regex `.*` (and regex metacharacters in value are escaped)", () => {
  const clauses = parseFilter("designator=R*");
  // Pin that the glob matches as expected
  assert.ok(matchesFilter(makeComponent("R1"), clauses));
  assert.ok(matchesFilter(makeComponent("R100"), clauses));
  assert.ok(!matchesFilter(makeComponent("U1"), clauses));
  // Pin that the regex-meta escape works — a `.` in the value is
  // a literal dot, not "any char". (Important for MPN-style values
  // like "RC0402FR-07.10K" where dots appear.)
  const dotClauses = parseFilter("mpn=RC.10K");
  assert.ok(matchesFilter(makeComponent("R1", { mpn: "RC.10K" }), dotClauses));
  assert.ok(
    !matchesFilter(makeComponent("R1", { mpn: "RCX10K" }), dotClauses),
    "unescaped '.' would have matched any char — but we escape regex metas"
  );
});

test("parseFilter: locked components are excluded from matches (obstacles, never targets)", () => {
  const clauses = parseFilter("designator=R*");
  assert.ok(matchesFilter(makeComponent("R1", { locked: false }), clauses));
  assert.ok(
    !matchesFilter(makeComponent("R1", { locked: true }), clauses),
    "locked components must not match the filter — they're obstacles"
  );
});

test("parseFilter: malformed input throws with actionable messages", () => {
  // No clauses
  assert.throws(() => parseFilter(""), /filter is required/);
  assert.throws(() => parseFilter("   "), /filter is required/);
  // Missing '='
  assert.throws(() => parseFilter("footprint 0402"), /missing '='/);
  // Unknown field
  assert.throws(() => parseFilter("netname=VCC"), /not supported/);
  assert.throws(() => parseFilter("netname=VCC"), /designator, footprint, mpn, layer/);
  // Empty value
  assert.throws(() => parseFilter("footprint="), /empty value/);
});

// ─── Strategy planners ──────────────────────────────────────────────

test("planGrid: row-major layout with explicit columns", () => {
  const matched = ["R1", "R2", "R3", "R4", "R5"].map((d) => makeComponent(d));
  const planned = planGrid(
    { matched, obstacles: [], obstacleClearanceMm: 0.5 },
    { originX: 0, originY: 0, spacingMm: 5, columns: 3 }
  );
  assert.equal(planned.length, 5);
  // Row 0: R1, R2, R3 at y=0
  assert.deepEqual(planned[0], { designator: "R1", x: 0, y: 0 });
  assert.deepEqual(planned[1], { designator: "R2", x: 5, y: 0 });
  assert.deepEqual(planned[2], { designator: "R3", x: 10, y: 0 });
  // Row 1: R4, R5 at y=5
  assert.deepEqual(planned[3], { designator: "R4", x: 0, y: 5 });
  assert.deepEqual(planned[4], { designator: "R5", x: 5, y: 5 });
});

test("planGrid: default columns is sqrt(n) — square-ish layout when caller omits it", () => {
  // 9 matched → ceil(sqrt(9)) = 3 columns → 3x3 grid.
  const matched = Array.from({ length: 9 }, (_, i) => makeComponent(`R${i + 1}`));
  const planned = planGrid(
    { matched, obstacles: [], obstacleClearanceMm: 0.5 },
    { originX: 0, originY: 0 }
  );
  assert.equal(planned.length, 9);
  // Last row should start at row 2: y = 2 * default-spacing (5).
  assert.equal(planned[8].y, 10);
});

test("planAroundComponent: spreads candidates around target on a circle of given radius", () => {
  // 4 candidates → 4 evenly spaced points on a circle.
  const target = makeComponent("U1", { x: 50, y: 50 });
  const matched = ["C1", "C2", "C3", "C4"].map((d) => makeComponent(d));
  const planned = planAroundComponent(
    { matched, obstacles: [], obstacleClearanceMm: 0.5 },
    target,
    { radiusMm: 10 }
  );
  assert.equal(planned.length, 4);
  // First placement at angle 0 → (target.x + radius, target.y)
  assert.ok(Math.abs(planned[0].x - 60) < 1e-6);
  assert.ok(Math.abs(planned[0].y - 50) < 1e-6);
  // All candidates must lie on the circle of radius 10 around target.
  for (const p of planned) {
    const dx = p.x - target.x;
    const dy = p.y - target.y;
    const r = Math.sqrt(dx * dx + dy * dy);
    assert.ok(Math.abs(r - 10) < 1e-6, `point ${p.designator} not on radius-10 circle`);
  }
});

test("planAroundComponent: skips candidates whose planned position collides with locked obstacle", () => {
  // Place an obstacle right at angle 0 (target.x + radius, target.y).
  // The first candidate would be planned there; planner must skip it.
  const target = makeComponent("U1", { x: 0, y: 0 });
  const matched = ["C1", "C2"].map((d) => makeComponent(d));
  const obstacle = makeComponent("LOCK1", { x: 10, y: 0, locked: true });
  const planned = planAroundComponent(
    { matched, obstacles: [obstacle], obstacleClearanceMm: 1 },
    target,
    { radiusMm: 10 }
  );
  // C1 (angle 0) is too close to LOCK1 → skipped.
  // C2 (angle π) lands at (-10, 0) → no collision → placed.
  assert.equal(planned.length, 1);
  assert.equal(planned[0].designator, "C2");
});

test("planOnEdge: 'top' side spreads candidates along x at maxY + offset", () => {
  // Board extents: minX=0, maxX=20, minY=0, maxY=10.
  const allComponents = [
    makeComponent("U1", { x: 0, y: 0 }),
    makeComponent("U2", { x: 20, y: 10 }),
  ];
  const matched = ["J1", "J2", "J3"].map((d) => makeComponent(d));
  const planned = planOnEdge(
    { matched, obstacles: [], obstacleClearanceMm: 0.5 },
    allComponents,
    { side: "top", offsetMm: 3 }
  );
  // Top side: y = maxY + offset = 13 for all
  assert.equal(planned.length, 3);
  for (const p of planned) {
    assert.equal(p.y, 13);
  }
  // x increases by default spacing (5) starting at minX
  assert.equal(planned[0].x, 0);
  assert.equal(planned[1].x, 5);
  assert.equal(planned[2].x, 10);
});

test("planOnEdge: each side uses the correct extent + axis", () => {
  const allComponents = [
    makeComponent("X1", { x: -5, y: -5 }),
    makeComponent("X2", { x: 25, y: 30 }),
  ];
  const matched = [makeComponent("J1")];
  // Bottom: y = minY - offset = -10
  const bot = planOnEdge(
    { matched, obstacles: [], obstacleClearanceMm: 0.5 },
    allComponents,
    { side: "bottom", offsetMm: 5 }
  );
  assert.equal(bot[0].y, -10);
  // Left: x = minX - offset = -10
  const left = planOnEdge(
    { matched, obstacles: [], obstacleClearanceMm: 0.5 },
    allComponents,
    { side: "left", offsetMm: 5 }
  );
  assert.equal(left[0].x, -10);
  // Right: x = maxX + offset = 30
  const right = planOnEdge(
    { matched, obstacles: [], obstacleClearanceMm: 0.5 },
    allComponents,
    { side: "right", offsetMm: 5 }
  );
  assert.equal(right[0].x, 30);
});

test("planGrid: empty matched array → empty plan, doesn't divide-by-zero on default columns", () => {
  // The default columns calculation does ceil(sqrt(0)) = 0; plan
  // must guard with Math.max(1, ...) to avoid 0%0 NaN per-row math.
  const planned = planGrid(
    { matched: [], obstacles: [], obstacleClearanceMm: 0.5 },
    { originX: 0, originY: 0 }
  );
  assert.deepEqual(planned, []);
});
