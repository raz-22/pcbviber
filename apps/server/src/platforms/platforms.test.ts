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

// ─── EasyedaPlatform.screenshot() — Sprint 10 PR 10.1 ───────────────
// Now a real impl. Tests pin the relay-dispatch happy path, the
// no-bridge fallback (so the AI client's degrade-gracefully contract
// holds), and the result-shape mapping.

import { EdaRelay } from "../eda-relay/relay.js";

test("EasyedaPlatform.screenshot: with relay+workspaceId, returns ok with the extension's payload", async () => {
  // Real EdaRelay; we feed the result through the broker by polling
  // the queued command + posting the result back, the same shape as
  // the extension's HTTP loop.
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });

  // Drive the round-trip in parallel: the platform.screenshot()
  // promise blocks until postResult resolves it.
  const pending = platform.screenshot();
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("relay should have queued the screenshot command");
  assert.equal(cmd.method, "screenshot");

  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: { base64Png: "iVBORw0KGgo=", byteLength: 1024 },
  });

  const result = await pending;
  assert.equal(result.supported, true);
  if (result.supported) {
    assert.equal(result.data.base64Png, "iVBORw0KGgo=");
    assert.equal(result.data.byteLength, 1024);
  }
  relay.__resetForTests();
});

test("EasyedaPlatform.screenshot: with no relay, returns supported:false with NO_BRIDGE reason", async () => {
  // The "stub" path stays — the AI client should see an
  // extension-not-connected message, distinct from
  // "feature not implemented".
  const platform = new EasyedaPlatform({ relay: null, workspaceId: null });
  const result = await platform.screenshot();
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(
      result.reason,
      /extension is not connected/i,
      "reason must distinguish 'no bridge' from 'method not implemented'"
    );
  }
});

test("EasyedaPlatform.screenshot: when extension reports failure via relay, surfaces as supported:false with extension's message", async () => {
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });

  const pending = platform.screenshot();
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");

  // Extension says "DOM not ready" — surfaces verbatim through the
  // PlatformResponse contract rather than throwing.
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: false,
    error: { message: "Editor canvas not ready", code: "canvas_unavailable" },
  });

  const result = await pending;
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /canvas not ready/i);
  }
  relay.__resetForTests();
});

test("EasyedaPlatform.screenshot: malformed extension payload (missing base64Png) is treated as supported:false, not a crash", async () => {
  // Defense in depth: the extension is third-party JS the user
  // installed. If it ships a future version that returns the wrong
  // shape, the platform must surface a typed signal — not let the
  // bad payload reach the AI client unchecked.
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });

  const pending = platform.screenshot();
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");

  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: { wrongField: "not a base64Png" },
  });

  const result = await pending;
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /base64Png/i);
  }
  relay.__resetForTests();
});

// ─── EasyedaPlatform.getActiveProject() — Sprint 10 PR 10.2 ─────────
// Same shape as the screenshot tests above: relay round-trip happy
// path, no-bridge fallback, extension-failure surfaces as
// supported:false. Plus the "no active project loaded" branch the
// extension can hit when the editor has no project open.

test("EasyedaPlatform.getActiveProject: with relay+workspaceId, returns ok with extracted id+name", async () => {
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });

  const pending = platform.getActiveProject();
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("relay should have queued the command");
  assert.equal(cmd.method, "get_active_project");

  // EasyEDA Pro's dmt_Project.getCurrentProjectInfo() returns a
  // shape with `uuid` + `name` (per the PR 9.1 spike).
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: { uuid: "proj-acme-123", name: "Acme PSU" },
  });

  const result = await pending;
  assert.equal(result.supported, true);
  if (result.supported) {
    assert.equal(result.data.id, "proj-acme-123");
    assert.equal(result.data.name, "Acme PSU");
  }
  relay.__resetForTests();
});

test("EasyedaPlatform.getActiveProject: with no relay, returns supported:false with NO_BRIDGE reason", async () => {
  const platform = new EasyedaPlatform({ relay: null, workspaceId: null });
  const result = await platform.getActiveProject();
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /extension is not connected/i);
  }
});

test("EasyedaPlatform.getActiveProject: extension returning null → 'no active project' supported:false", async () => {
  // The editor can have no project loaded. Distinct from
  // "extension failed" — surface as supported:false with a
  // human-readable instruction so the AI tells the user to open
  // a project rather than reporting a generic tool failure.
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });

  const pending = platform.getActiveProject();
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  relay.postResult("ws-a", { id: cmd.id, ok: true, result: null });

  const result = await pending;
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /no active project/i);
    assert.match(result.reason, /open a project/i);
  }
  relay.__resetForTests();
});

test("EasyedaPlatform.getActiveProject: extension reports failure via relay, surfaces as supported:false", async () => {
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });

  const pending = platform.getActiveProject();
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: false,
    error: { message: "API method not yet bound", code: "method_unavailable" },
  });

  const result = await pending;
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /API method not yet bound/i);
  }
  relay.__resetForTests();
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
