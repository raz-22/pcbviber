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
  const platform = new AltiumPlatform({ relay: null, nexar: null, altiumWorkspaceUrl: null });
  assert.equal(platform.name, "altium");
});

test("AltiumPlatform: relay-dependent methods return supported:false when relay is null", async () => {
  // null relay simulates "no AD relay configured at all" — distinct
  // from "configured but currently disconnected", which is exercised
  // below.
  const platform = new AltiumPlatform({ relay: null, nexar: null, altiumWorkspaceUrl: null });

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

  const platform = new AltiumPlatform({ relay: stubRelay, nexar: null, altiumWorkspaceUrl: null });

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

// ─── EasyedaPlatform.listProjects() — Sprint 10 PR 10.2b ────────────

test("EasyedaPlatform.listProjects: with relay+workspaceId, maps extension array to ProjectListEntry[]", async () => {
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });

  const pending = platform.listProjects();
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  assert.equal(cmd.method, "list_projects");

  // Extension returns the result of eda.dmt_Project.getProjectInfo()
  // collected per-uuid: {uuid, name, ...other fields we don't unpack}.
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: [
      { uuid: "proj-1", name: "Power Monitor", workspaceUrl: "..." },
      { uuid: "proj-2", name: "DAQ Card" },
    ],
  });

  const result = await pending;
  assert.equal(result.supported, true);
  if (result.supported) {
    assert.equal(result.data.length, 2);
    assert.equal(result.data[0].id, "proj-1");
    assert.equal(result.data[0].name, "Power Monitor");
    // raw passes through verbatim so future tools that need more
    // fields can read them without another round-trip.
    assert.equal((result.data[0].raw as { workspaceUrl: string }).workspaceUrl, "...");
  }
  relay.__resetForTests();
});

test("EasyedaPlatform.listProjects: with no relay → supported:false NO_BRIDGE", async () => {
  const platform = new EasyedaPlatform({ relay: null, workspaceId: null });
  const result = await platform.listProjects();
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /extension is not connected/i);
  }
});

test("EasyedaPlatform.listProjects: extension returns non-array → supported:false (defense in depth)", async () => {
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const pending = platform.listProjects();
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  // Extension version mismatch: returns an object instead of an
  // array. Surface as supported:false rather than letting the bad
  // shape reach the AI client unchecked.
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: { uuid: "not-an-array" },
  });
  const result = await pending;
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /non-array/);
  }
  relay.__resetForTests();
});

test("EasyedaPlatform.listProjects: empty array → supported:true with empty data", async () => {
  // A workspace with no projects is a valid state. Distinct from
  // "extension failed" — return supported:true with an empty array
  // so the tool wrapper can render "no projects found" rather than
  // a generic error.
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const pending = platform.listProjects();
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  relay.postResult("ws-a", { id: cmd.id, ok: true, result: [] });
  const result = await pending;
  assert.equal(result.supported, true);
  if (result.supported) assert.equal(result.data.length, 0);
  relay.__resetForTests();
});

// ─── AltiumPlatform.listProjects() — workspace url gate ─────────────

test("AltiumPlatform.listProjects: missing altiumWorkspaceUrl → supported:false with clear reason", async () => {
  // Nexar's desProjects requires a workspaceUrl. Workspaces created
  // without one (or env-only stdio without ALTIUM_WORKSPACE_URL)
  // can't list projects. Surface a clear actionable reason rather
  // than a Nexar HTTP error.
  const platform = new AltiumPlatform({
    relay: null,
    nexar: {} as never,
    altiumWorkspaceUrl: null,
  });
  const result = await platform.listProjects();
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /Altium 365 URL/);
  }
});

test("AltiumPlatform.listProjects: missing nexar → supported:false with clear reason", async () => {
  const platform = new AltiumPlatform({
    relay: null,
    nexar: null,
    altiumWorkspaceUrl: "https://acme.altium365.com",
  });
  const result = await platform.listProjects();
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /Nexar credentials/);
  }
});

test("AltiumPlatform.listProjects: with stub nexar + url → maps to ProjectListEntry[]", async () => {
  // Stub nexar.listProjects to bypass the network. Verifies the
  // wrapper's shape mapping (Nexar's AltiumProject → our
  // ProjectListEntry) without standing up a real Nexar mock.
  const nexar = {
    listProjects: async (url: string) => {
      assert.equal(url, "https://acme.altium365.com");
      return [
        {
          id: "p-1",
          name: "Acme PSU",
          workspaceUrl: url,
          createdAt: "",
          updatedAt: "",
        },
      ];
    },
  } as unknown as import("../services/nexar.js").NexarService;

  const platform = new AltiumPlatform({
    relay: null,
    nexar,
    altiumWorkspaceUrl: "https://acme.altium365.com",
  });
  const result = await platform.listProjects();
  assert.equal(result.supported, true);
  if (result.supported) {
    assert.equal(result.data.length, 1);
    assert.equal(result.data[0].id, "p-1");
    assert.equal(result.data[0].name, "Acme PSU");
  }
});

// ─── EasyedaPlatform.listSchematicComponents — Sprint 10 PR 10.3a ──

test("EasyedaPlatform.listSchematicComponents: maps extension {items,total} to a Page", async () => {
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });

  const pending = platform.listSchematicComponents({ offset: 0, limit: 200 });
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  assert.equal(cmd.method, "list_schematic_components");
  assert.deepEqual(cmd.params, { offset: 0, limit: 200 });

  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: {
      items: [
        { primitiveId: "p-1", designator: "R1", value: "10k" },
        { primitiveId: "p-2", designator: "C1", value: "100nF" },
      ],
      total: 2,
    },
  });

  const result = await pending;
  assert.equal(result.supported, true);
  if (result.supported) {
    assert.equal(result.data.items.length, 2);
    assert.equal(result.data.items[0].designator, "R1");
    assert.equal(result.data.items[0].value, "10k");
    assert.equal(result.data.total, 2);
    assert.equal(result.data.nextOffset, null, "page exhausts collection");
  }
  relay.__resetForTests();
});

test("EasyedaPlatform.listSchematicComponents: nextOffset advances when total > items returned", async () => {
  // Pin the pagination math: when the extension reports total=350
  // and we asked for limit=200, nextOffset must be 200 so the AI
  // client knows to fetch the next page.
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const pending = platform.listSchematicComponents({ offset: 0, limit: 200 });
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");

  // Fake 200 items
  const items = Array.from({ length: 200 }, (_, i) => ({
    primitiveId: `p-${i}`,
    designator: `R${i}`,
    value: "10k",
  }));
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: { items, total: 350 },
  });

  const result = await pending;
  assert.equal(result.supported, true);
  if (result.supported) {
    assert.equal(result.data.items.length, 200);
    assert.equal(result.data.total, 350);
    assert.equal(result.data.nextOffset, 200);
  }
  relay.__resetForTests();
});

test("EasyedaPlatform.listSchematicComponents: extracts designator/value from properties when top-level keys missing", async () => {
  // EasyEDA Pro stores common fields under `properties` for some
  // symbol types. Best-effort extraction: prefer top-level, fall
  // back to properties.{designator,value}.
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const pending = platform.listSchematicComponents({});
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: {
      items: [
        { primitiveId: "p-1", properties: { designator: "U1", value: "ESP32" } },
      ],
      total: 1,
    },
  });
  const result = await pending;
  assert.equal(result.supported, true);
  if (result.supported) {
    assert.equal(result.data.items[0].designator, "U1");
    assert.equal(result.data.items[0].value, "ESP32");
  }
  relay.__resetForTests();
});

test("EasyedaPlatform.listSchematicComponents: malformed result (no items array) → supported:false", async () => {
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const pending = platform.listSchematicComponents({});
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: { wrongShape: true },
  });
  const result = await pending;
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /items.*array/);
  }
  relay.__resetForTests();
});

test("EasyedaPlatform.listSchematicComponents: no relay → supported:false NO_BRIDGE", async () => {
  const platform = new EasyedaPlatform({ relay: null, workspaceId: null });
  const result = await platform.listSchematicComponents({});
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /extension is not connected/i);
  }
});

// ─── AltiumPlatform.listSchematicComponents — stub for now ──────────

test("AltiumPlatform.listSchematicComponents: returns supported:false with clear 'follow-up' reason", async () => {
  // The AD relay needs a new command for schematic introspection;
  // PR 10.3a stubs the Altium side rather than ship cross-stack
  // changes. The reason must explain that to the AI client AND
  // hint that the EasyEDA half does work.
  const platform = new AltiumPlatform({
    relay: null,
    nexar: null,
    altiumWorkspaceUrl: null,
  });
  const result = await platform.listSchematicComponents({});
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(
      result.reason,
      /Altium/,
      "reason should name the platform"
    );
    assert.match(
      result.reason,
      /AD relay/,
      "reason should explain WHAT'S blocked"
    );
    assert.match(
      result.reason,
      /EasyEDA/,
      "reason should hint that the EasyEDA half works"
    );
  }
});

// ─── EasyedaPlatform.listPcbComponents — Sprint 10 PR 10.3b ────────

test("EasyedaPlatform.listPcbComponents: maps extension {items,total} to a Page", async () => {
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });

  const pending = platform.listPcbComponents({ offset: 0, limit: 200 });
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  assert.equal(cmd.method, "list_pcb_components");
  assert.deepEqual(cmd.params, { offset: 0, limit: 200 });

  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: {
      items: [
        { primitiveId: "p-1", designator: "R1", footprint: "0402" },
        { primitiveId: "p-2", designator: "U1", footprint: "QFN-32" },
      ],
      total: 2,
    },
  });

  const result = await pending;
  assert.equal(result.supported, true);
  if (result.supported) {
    assert.equal(result.data.items.length, 2);
    assert.equal(result.data.items[0].designator, "R1");
    assert.equal(result.data.items[0].footprint, "0402");
    assert.equal(result.data.items[1].footprint, "QFN-32");
    assert.equal(result.data.total, 2);
    assert.equal(result.data.nextOffset, null, "page exhausts collection");
  }
  relay.__resetForTests();
});

test("EasyedaPlatform.listPcbComponents: nextOffset advances when total > items returned", async () => {
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const pending = platform.listPcbComponents({ offset: 0, limit: 200 });
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");

  const items = Array.from({ length: 200 }, (_, i) => ({
    primitiveId: `p-${i}`,
    designator: `R${i}`,
    footprint: "0402",
  }));
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: { items, total: 350 },
  });

  const result = await pending;
  assert.equal(result.supported, true);
  if (result.supported) {
    assert.equal(result.data.items.length, 200);
    assert.equal(result.data.total, 350);
    assert.equal(result.data.nextOffset, 200);
  }
  relay.__resetForTests();
});

test("EasyedaPlatform.listPcbComponents: extracts designator/footprint from properties when top-level keys missing", async () => {
  // Pin the same fallback shape as the schematic side: pro-api-types
  // doesn't strongly type per-component fields, so some footprints
  // come through under entry.properties.footprint depending on the
  // component class.
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const pending = platform.listPcbComponents({});
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: {
      items: [
        { primitiveId: "p-1", properties: { designator: "U7", footprint: "BGA-256" } },
      ],
      total: 1,
    },
  });
  const result = await pending;
  assert.equal(result.supported, true);
  if (result.supported) {
    assert.equal(result.data.items[0].designator, "U7");
    assert.equal(result.data.items[0].footprint, "BGA-256");
  }
  relay.__resetForTests();
});

test("EasyedaPlatform.listPcbComponents: malformed result (no items array) → supported:false", async () => {
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const pending = platform.listPcbComponents({});
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: { wrongShape: true },
  });
  const result = await pending;
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /items.*array/);
  }
  relay.__resetForTests();
});

test("EasyedaPlatform.listPcbComponents: no relay → supported:false NO_BRIDGE", async () => {
  const platform = new EasyedaPlatform({ relay: null, workspaceId: null });
  const result = await platform.listPcbComponents({});
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /extension is not connected/i);
  }
});

// ─── AltiumPlatform.listPcbComponents — stub for now ───────────────

test("AltiumPlatform.listPcbComponents: returns supported:false with clear 'follow-up' reason", async () => {
  // Same stub pattern as listSchematicComponents — the AD relay
  // needs a new BoardIterator command. Sprint 11 PR 11.1 ships it
  // alongside the placement-data tool. The reason must name the
  // platform, the missing piece, and hint EasyEDA works.
  const platform = new AltiumPlatform({
    relay: null,
    nexar: null,
    altiumWorkspaceUrl: null,
  });
  const result = await platform.listPcbComponents({});
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /Altium/, "reason should name the platform");
    assert.match(
      result.reason,
      /AD relay/,
      "reason should explain WHAT'S blocked"
    );
    assert.match(
      result.reason,
      /EasyEDA/,
      "reason should hint the EasyEDA half works"
    );
  }
});

// ─── listLibraryComponents — Sprint 10 PR 10.4 ──────────────────────

test("AltiumPlatform.listLibraryComponents: missing nexar → supported:false", async () => {
  const platform = new AltiumPlatform({
    relay: null,
    nexar: null,
    altiumWorkspaceUrl: "https://acme.altium365.com",
  });
  const result = await platform.listLibraryComponents({});
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /Nexar credentials/);
  }
});

test("AltiumPlatform.listLibraryComponents: missing workspaceUrl → supported:false", async () => {
  const platform = new AltiumPlatform({
    relay: null,
    nexar: {} as never,
    altiumWorkspaceUrl: null,
  });
  const result = await platform.listLibraryComponents({});
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /Altium 365 URL/);
  }
});

test("AltiumPlatform.listLibraryComponents: with stub nexar → in-memory paginates the full library", async () => {
  // Nexar's desLibrary returns the full set in one shot today; the
  // platform paginates in-memory. Verify the slicing math + that
  // raw passes through verbatim for callers that need richer
  // fields.
  const allComponents = Array.from({ length: 350 }, (_, i) => ({
    id: `c-${i}`,
    name: `Part ${i}`,
    description: `Description ${i}`,
    designItemId: `di-${i}`,
    parameters: {},
    lifecycle: { state: "Active" },
  }));
  const nexar = {
    listProjects: async () => [],
    listComponents: async (url: string) => {
      assert.equal(url, "https://acme.altium365.com");
      return allComponents;
    },
  } as unknown as import("../services/nexar.js").NexarService;

  const platform = new AltiumPlatform({
    relay: null,
    nexar,
    altiumWorkspaceUrl: "https://acme.altium365.com",
  });
  const result = await platform.listLibraryComponents({ offset: 200, limit: 100 });
  assert.equal(result.supported, true);
  if (result.supported) {
    assert.equal(result.data.items.length, 100);
    assert.equal(result.data.items[0].id, "c-200");
    assert.equal(result.data.total, 350);
    assert.equal(result.data.nextOffset, 300);
    // Raw passes through so AI clients can read designItemId etc.
    const firstRaw = result.data.items[0].raw as { designItemId: string };
    assert.equal(firstRaw.designItemId, "di-200");
  }
});

test("EasyedaPlatform.listLibraryComponents: maps lib_Device entries to LibraryComponent[]", async () => {
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({
    relay,
    workspaceId: "ws-a",
    // No nexar here — proves the pure-mapping path runs without
    // enrichment. Enrichment-specific tests below.
    nexar: null,
  });

  const pending = platform.listLibraryComponents({ offset: 0, limit: 200 });
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  assert.equal(cmd.method, "list_library_components");
  // params don't carry enrichWithLcsc — that's a server-side concern
  // (extension shouldn't know about Nexar).
  assert.deepEqual(cmd.params, { offset: 0, limit: 200 });

  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: {
      items: [
        {
          uuid: "lib-1",
          name: "ESP32-WROOM-32E",
          manufacturer: "Espressif",
          manufacturerPartNumber: "ESP32-WROOM-32E-N4",
          lcscId: "C701341",
          footprint: "QFN-48",
          description: "Wi-Fi+BT module",
        },
      ],
      total: 1,
    },
  });

  const result = await pending;
  assert.equal(result.supported, true);
  if (result.supported) {
    assert.equal(result.data.items.length, 1);
    const item = result.data.items[0];
    assert.equal(item.id, "lib-1");
    assert.equal(item.name, "ESP32-WROOM-32E");
    assert.equal(item.manufacturer, "Espressif");
    assert.equal(item.mpn, "ESP32-WROOM-32E-N4");
    assert.equal(item.lcscId, "C701341");
    assert.equal(item.footprint, "QFN-48");
    // No enrichment ran — octopart stays undefined.
    assert.equal(item.octopart, undefined);
  }
  relay.__resetForTests();
});

test("EasyedaPlatform.listLibraryComponents: enrichment merges Nexar offers when MPN matches", async () => {
  // Pin the enrichment contract: each item's mpn (or lcscId) flows
  // into nexar.searchParts; the first result's offers merge into
  // LibraryComponent.octopart. This is the core of the LCSC-enrichment
  // architectural piece called out in the PR scope.
  const stubNexar = {
    searchParts: async (query: string, _limit: number) => {
      assert.equal(query, "ESP32-WROOM-32E-N4");
      return [
        {
          mpn: "ESP32-WROOM-32E-N4",
          manufacturer: "Espressif",
          description: "Wi-Fi BT MCU module",
          category: "Modules",
          datasheetUrl: "https://datasheet/x.pdf",
          lifecycle: "Active",
          offers: [
            { supplier: "LCSC", sku: "C701341", stock: 50000, moq: 1, prices: [], leadTimeDays: 7 },
            { supplier: "Digikey", sku: "DK-001", stock: 1200, moq: 1, prices: [], leadTimeDays: 14 },
          ],
        },
      ];
    },
  } as unknown as import("../services/nexar.js").NexarService;
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({
    relay,
    workspaceId: "ws-a",
    nexar: stubNexar,
  });
  const pending = platform.listLibraryComponents({});
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: {
      items: [
        {
          uuid: "lib-1",
          name: "ESP32",
          manufacturerPartNumber: "ESP32-WROOM-32E-N4",
        },
      ],
      total: 1,
    },
  });
  const result = await pending;
  assert.equal(result.supported, true);
  if (result.supported) {
    const item = result.data.items[0];
    assert(item.octopart, "octopart should be populated");
    if (item.octopart) {
      assert.equal(item.octopart.mpn, "ESP32-WROOM-32E-N4");
      assert.equal(item.octopart.offers.length, 2);
      assert.equal(item.octopart.offers[0].supplier, "LCSC");
      assert.equal(item.octopart.offers[0].stock, 50000);
      assert.equal(item.octopart.offers[1].supplier, "Digikey");
    }
  }
  relay.__resetForTests();
});

test("EasyedaPlatform.listLibraryComponents: enrichment skipped when Nexar absent", async () => {
  // The "no nexar" path must NOT try to enrich — silently leaves
  // octopart undefined. Verified above as part of the basic mapping
  // test; this test pins the explicit contract: even with an MPN
  // present, no enrichment happens without Nexar.
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({
    relay,
    workspaceId: "ws-a",
    nexar: null,
  });
  const pending = platform.listLibraryComponents({});
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: {
      items: [{ uuid: "lib-1", name: "X", manufacturerPartNumber: "MPN-1" }],
      total: 1,
    },
  });
  const result = await pending;
  assert.equal(result.supported, true);
  if (result.supported) {
    assert.equal(result.data.items[0].octopart, undefined);
  }
  relay.__resetForTests();
});

test("EasyedaPlatform.listLibraryComponents: enrichment opt-out via enrichWithLcsc:false", async () => {
  // Caller-controlled escape hatch: even with Nexar configured,
  // enrichWithLcsc:false skips the lookup hop. Used when the AI
  // client wants only the platform's native fields (faster,
  // cheaper, no Nexar quota burn).
  let nexarCalled = false;
  const stubNexar = {
    searchParts: async () => {
      nexarCalled = true;
      return [];
    },
  } as unknown as import("../services/nexar.js").NexarService;
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({
    relay,
    workspaceId: "ws-a",
    nexar: stubNexar,
  });
  const pending = platform.listLibraryComponents({ enrichWithLcsc: false });
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: {
      items: [{ uuid: "lib-1", name: "X", manufacturerPartNumber: "MPN-1" }],
      total: 1,
    },
  });
  const result = await pending;
  assert.equal(result.supported, true);
  assert.equal(nexarCalled, false, "enrichWithLcsc:false must skip Nexar entirely");
  if (result.supported) {
    assert.equal(result.data.items[0].octopart, undefined);
  }
  relay.__resetForTests();
});

test("EasyedaPlatform.listLibraryComponents: enrichment failure leaves entry without octopart, doesn't fail page", async () => {
  // Defense in depth: a Nexar throw on one item must not fail the
  // whole page. The contract is "enrichment is best-effort"; the
  // base mapping must still surface.
  const stubNexar = {
    searchParts: async () => {
      throw new Error("Nexar 503");
    },
  } as unknown as import("../services/nexar.js").NexarService;
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({
    relay,
    workspaceId: "ws-a",
    nexar: stubNexar,
  });
  const pending = platform.listLibraryComponents({});
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: {
      items: [{ uuid: "lib-1", name: "X", manufacturerPartNumber: "MPN-1" }],
      total: 1,
    },
  });
  const result = await pending;
  assert.equal(result.supported, true);
  if (result.supported) {
    assert.equal(result.data.items.length, 1);
    assert.equal(result.data.items[0].octopart, undefined);
  }
  relay.__resetForTests();
});

test("EasyedaPlatform.listLibraryComponents: malformed extension result → supported:false", async () => {
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({
    relay,
    workspaceId: "ws-a",
    nexar: null,
  });
  const pending = platform.listLibraryComponents({});
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: { wrongShape: true },
  });
  const result = await pending;
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /items.*array/);
  }
  relay.__resetForTests();
});

test("EasyedaPlatform.listLibraryComponents: no relay → supported:false NO_BRIDGE", async () => {
  const platform = new EasyedaPlatform({ relay: null, workspaceId: null });
  const result = await platform.listLibraryComponents({});
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /extension is not connected/i);
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
