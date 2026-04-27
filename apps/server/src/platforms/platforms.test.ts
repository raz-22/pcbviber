/**
 * `Platform` contract tests — Sprint 9 PR 9.3.
 *
 * Pins the discriminated-union contract every Sprint 10+ tool will
 * rely on. Three failure modes that would silently break downstream
 * tools and need protection here:
 *
 *   1. A `PlatformResponse` returned by a stub that's missing the
 *      `reason` field — the AI client surfaces an empty error.
 *   2. An `AltiumPlatform` method that throws when the relay is
 *      disconnected, instead of returning `{supported: false}` —
 *      every tool wrapper needs a try/catch.
 *   3. The two implementations declaring different `name` values
 *      from the static type union — runtime audit / Sentry tags
 *      drift.
 *
 * No real AdRelay / NexarService here — both implementations are
 * exercised against a stub relay (so we can simulate
 * connected-vs-not without running the bridge).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AltiumPlatform } from "./altium.js";
import { EasyedaPlatform } from "./easyeda.js";
import type { PlatformResponse } from "./types.js";

// ─── EasyEDA stub: every method returns supported:false ──────────────

test("EasyedaPlatform.name is 'easyeda'", () => {
  const platform = new EasyedaPlatform();
  assert.equal(platform.name, "easyeda");
});

test("EasyedaPlatform: every method returns supported:false with a reason", async () => {
  const platform = new EasyedaPlatform();
  // Listed individually rather than iterated via keyof so each call
  // keeps its real return type — and so adding a method to the
  // interface forces a deliberate test update here.
  assertSupportedFalse(await platform.getActiveProject(), "getActiveProject");
  assertSupportedFalse(await platform.screenshot(), "screenshot");
  assertSupportedFalse(await platform.runDrc(), "runDrc");
  assertSupportedFalse(await platform.getMessages(), "getMessages");
});

// ─── AltiumPlatform with no relay: every relay-dependent method ─────
// returns supported:false with a connectivity reason.

test("AltiumPlatform.name is 'altium'", () => {
  const platform = new AltiumPlatform({ relay: null, nexar: null });
  assert.equal(platform.name, "altium");
});

test("AltiumPlatform: relay-dependent methods return supported:false when relay is null", async () => {
  // null relay simulates "no AD relay configured at all" — distinct
  // from "configured but currently disconnected", which is exercised
  // below.
  const platform = new AltiumPlatform({ relay: null, nexar: null });

  const project = await platform.getActiveProject();
  assertSupportedFalse(project, "getActiveProject");
  assert.match(
    project.supported === false ? project.reason : "",
    /relay is not connected/i,
    "reason should name the relay connectivity issue"
  );

  const drc = await platform.runDrc();
  assertSupportedFalse(drc, "runDrc");

  const messages = await platform.getMessages();
  assertSupportedFalse(messages, "getMessages");
});

test("AltiumPlatform: relay-dependent methods return supported:false when relay reports disconnected", async () => {
  // The other shape: relay handle exists but `status().connected` is
  // false. The platform must check connectivity per-call, not just on
  // construction — connection state changes over time.
  const stubRelay = {
    status: () => ({ connected: false, polling: false }),
    execute: async () => {
      throw new Error("relay execute called when it should have short-circuited");
    },
  } as unknown as import("../ad-relay/relay.js").AdRelay;

  const platform = new AltiumPlatform({ relay: stubRelay, nexar: null });

  const project = await platform.getActiveProject();
  assertSupportedFalse(project, "getActiveProject");
  // The execute() throw above is the canary: if the platform forgot
  // the connectivity check and called execute() anyway, the error
  // message would surface here instead of the relay-not-connected
  // reason.
  assert.doesNotMatch(
    project.supported === false ? project.reason : "",
    /relay execute called/,
    "platform must short-circuit before invoking relay.execute"
  );
});

// ─── PlatformResponse shape pin ──────────────────────────────────────

test("PlatformResponse failure shape: supported=false carries a non-empty reason", async () => {
  // EasyedaPlatform is the easiest cover for this — every method
  // returns the failure branch. The pin ensures no method ever ships
  // an empty/whitespace-only reason that would render as a blank
  // error in the AI client.
  const platform = new EasyedaPlatform();
  const result = await platform.getActiveProject();
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.ok(
      result.reason && result.reason.trim().length > 10,
      "reason must be a real human-readable sentence, not empty / whitespace"
    );
  }
});

// ─── Helper ─────────────────────────────────────────────────────────

function assertSupportedFalse<T>(
  result: PlatformResponse<T>,
  context: string
): asserts result is { supported: false; reason: string } {
  assert.equal(
    result.supported,
    false,
    `${context}: expected supported=false, got supported=${result.supported}`
  );
  assert.equal(
    typeof (result as { reason?: unknown }).reason,
    "string",
    `${context}: failure branch must carry a string 'reason'`
  );
}
