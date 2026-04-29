/**
 * Sprint 13 PR 13.2: DRC parser + summarizer tests.
 *
 * Hermetic, no platform stubs needed — these are pure-logic tests
 * against the shared parsing helpers. Wiring tests (orchestration
 * through getMessages on Altium / pcb_Drc.check on EasyEDA) live
 * with the platform tests.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseDrcViolations,
  parseEasyedaDrcArray,
  summarizeDrc,
} from "./drc.js";
import type { PlatformMessage } from "./types.js";

function msg(overrides: Partial<PlatformMessage> = {}): PlatformMessage {
  return {
    severity: "warning",
    source: "DRC",
    text: "test message",
    ...overrides,
  };
}

// ─── parseDrcViolations (Altium Messages-panel path) ─────────────────

test("parseDrcViolations: filters non-DRC messages, extracts category from leading 'Category: ...'", () => {
  const violations = parseDrcViolations([
    msg({ source: "DRC", text: "Clearance: trace-to-trace 0.05mm at (10.5, 22.3)mm" }),
    msg({ source: "Compiler", text: "Compile completed: 0 errors" }),
    msg({ source: "DRC", text: "Width: trace 0.1mm below minimum at (5, 8)mm" }),
  ]);
  assert.equal(violations.length, 2);
  assert.equal(violations[0].category, "Clearance");
  assert.deepEqual(violations[0].location, { x: 10.5, y: 22.3 });
  assert.equal(violations[1].category, "Width");
  assert.deepEqual(violations[1].location, { x: 5, y: 8 });
});

test("parseDrcViolations: severity 'unknown' coerced to 'warning' (DRC entries are inherently actionable)", () => {
  const violations = parseDrcViolations([
    msg({ severity: "unknown", source: "DRC", text: "Some violation" }),
  ]);
  assert.equal(violations.length, 1);
  assert.equal(
    violations[0].severity,
    "warning",
    "unknown DRC severity must coerce to warning, not bury as info"
  );
});

test("parseDrcViolations: 'Violation:' prefix in text triggers DRC filter even without DRC source", () => {
  // Some AD builds tag DRC entries under "Messages" rather than
  // "DRC" source. Text-based fallback catches them.
  const violations = parseDrcViolations([
    msg({ source: "Messages", text: "Violation: Hole annular ring < 0.15mm" }),
    msg({ source: "Messages", text: "Compile: 0 errors, 0 warnings" }),
  ]);
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /annular/);
});

test("parseDrcViolations: extracts designators from message text into objects[]", () => {
  // Designator pattern: 1-3 letters + 1-4 digits with word
  // boundaries. R1, U23, IC100 match; arbitrary words don't.
  const violations = parseDrcViolations([
    msg({ source: "DRC", text: "Clearance: U1 ↔ R7 — 0.05mm gap (rule 0.20mm)" }),
  ]);
  assert.deepEqual(violations[0].objects, ["U1", "R7"]);
});

test("parseDrcViolations: missing 'at (X, Y)' → location undefined (NOT zeros)", () => {
  // Defensive: distinguishing "no location" from "violation at
  // origin" matters for AI reasoning.
  const violations = parseDrcViolations([
    msg({ source: "DRC", text: "Net Antennae: net NETX has dangling segment" }),
  ]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].location, undefined);
});

test("parseDrcViolations: empty input → empty output", () => {
  assert.deepEqual(parseDrcViolations([]), []);
});

// ─── parseEasyedaDrcArray (EasyEDA verbose-error path) ───────────────

test("parseEasyedaDrcArray: maps typical entry shape to DrcViolation", () => {
  // Pin the most-likely shape per the spike. Variations in BETA
  // API field names handled in the next test.
  const violations = parseEasyedaDrcArray([
    {
      severity: "error",
      category: "Clearance",
      message: "Trace too close to via",
      position: { x: 12.5, y: 34.5 },
      objects: ["R1", "V_2"],
    },
    {
      level: "warn",
      kind: "Width Rule",
      text: "Trace narrower than minimum",
      x: 5,
      y: 10,
    },
  ]);
  assert.equal(violations.length, 2);
  assert.equal(violations[0].severity, "error");
  assert.equal(violations[0].category, "Clearance");
  assert.deepEqual(violations[0].location, { x: 12.5, y: 34.5 });
  assert.deepEqual(violations[0].objects, ["R1", "V_2"]);
  // Second entry: 'warn' coerced to 'warning'; kind→category;
  // text→message; top-level x/y → location.
  assert.equal(violations[1].severity, "warning");
  assert.equal(violations[1].category, "Width Rule");
  assert.equal(violations[1].message, "Trace narrower than minimum");
  assert.deepEqual(violations[1].location, { x: 5, y: 10 });
});

test("parseEasyedaDrcArray: missing fields → defaults; raw preserved", () => {
  // Defensive: BETA API shape drift can produce entries with
  // partial fields. We default missing severity to 'warning',
  // missing category to extracted-from-text, missing objects
  // to undefined.
  const violations = parseEasyedaDrcArray([
    { description: "Some unknown violation" },
  ]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].severity, "warning");
  assert.equal(violations[0].message, "Some unknown violation");
  assert.equal(violations[0].objects, undefined);
});

test("parseEasyedaDrcArray: non-array input → empty result, no throw", () => {
  // Defense in depth: if pcb_Drc.check returns something other
  // than an array (older Pro version, throws caught upstream,
  // etc.), the parser shouldn't crash.
  assert.deepEqual(parseEasyedaDrcArray(null), []);
  assert.deepEqual(parseEasyedaDrcArray("not an array"), []);
  assert.deepEqual(parseEasyedaDrcArray({ wrong: "shape" }), []);
});

test("parseEasyedaDrcArray: non-object array entries dropped", () => {
  // Resilient against [string, number, object] mixed arrays.
  const violations = parseEasyedaDrcArray([
    "stringy",
    42,
    null,
    { severity: "error", message: "real one" },
  ]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].message, "real one");
});

// ─── summarizeDrc ─────────────────────────────────────────────────────

test("summarizeDrc: counts by severity + passed flag", () => {
  const result = summarizeDrc([
    {
      category: "C",
      severity: "error",
      message: "x",
      raw: null,
    },
    {
      category: "C",
      severity: "warning",
      message: "y",
      raw: null,
    },
    {
      category: "C",
      severity: "warning",
      message: "z",
      raw: null,
    },
    { category: "C", severity: "info", message: "n", raw: null },
  ]);
  assert.equal(result.errorCount, 1);
  assert.equal(result.warningCount, 2);
  assert.equal(result.infoCount, 1);
  assert.equal(
    result.passed,
    false,
    "any error-severity violation → passed=false"
  );
});

test("summarizeDrc: passed=true when no errors (warnings + info still allowed)", () => {
  // Pin the cross-platform contract: DRC passes with warnings
  // + info; only error-severity violations fail the run. AI
  // clients reading `passed` get a one-bit "is this board ready
  // for fab" signal.
  const result = summarizeDrc([
    {
      category: "C",
      severity: "warning",
      message: "x",
      raw: null,
    },
    { category: "C", severity: "info", message: "y", raw: null },
  ]);
  assert.equal(result.passed, true);
  assert.equal(result.errorCount, 0);
  assert.equal(result.warningCount, 1);
});

test("summarizeDrc: empty violations → passed:true with zero counts", () => {
  const result = summarizeDrc([]);
  assert.equal(result.passed, true);
  assert.equal(result.errorCount, 0);
  assert.equal(result.violations.length, 0);
});
