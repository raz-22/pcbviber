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

// ─── normalizeLayer — Sprint 11 PR 11.1 ─────────────────────────────

import { normalizeLayer } from "./altium.js";

test("normalizeLayer: Altium and EasyEDA flavors map to the cross-platform union", () => {
  // Pin the cross-platform contract: AI clients write rules like
  // `c.layer === "top"` and they must work on both platforms.
  assert.equal(normalizeLayer("eTopLayer"), "top");
  assert.equal(normalizeLayer("top"), "top");
  assert.equal(normalizeLayer("Top_Layer"), "top");
  assert.equal(normalizeLayer("eBottomLayer"), "bottom");
  assert.equal(normalizeLayer("bottom"), "bottom");
  // Inner / mid / plane all collapse to "inner" — AI clients
  // reasoning about routability vs. placement only need
  // top/bottom/inner/unknown to write portable rules.
  assert.equal(normalizeLayer("eMidLayer3"), "inner");
  assert.equal(normalizeLayer("inner1"), "inner");
  assert.equal(normalizeLayer("InternalPlane2"), "inner");
  // Falls through to "unknown" rather than crashing on
  // unrecognized strings or non-string inputs.
  assert.equal(normalizeLayer("MechanicalLayer"), "unknown");
  assert.equal(normalizeLayer(undefined), "unknown");
  assert.equal(normalizeLayer(42), "unknown");
});

// ─── AltiumPlatform.getComponents — Sprint 11 PR 11.1 ───────────────

test("AltiumPlatform.getComponents: relay round-trip maps full payload + normalizes layer", async () => {
  // Stub AdRelay execute → simulate the AD relay's get_components
  // response. Coordinates already converted to mm by AltiumRelay.js
  // so the platform doesn't redo the math.
  const stubRelay = {
    status: () => ({ connected: true, polling: true }),
    execute: async (method: string, params: Record<string, unknown>) => {
      assert.equal(method, "get_components");
      assert.deepEqual(params, { offset: 0, limit: 200 });
      return {
        items: [
          {
            primitiveId: "comp_0",
            designator: "U1",
            mpn: "STM32F4",
            footprint: "QFP-100",
            x: 25.4,
            y: 12.7,
            layer: "eTopLayer",
            rotation: 90,
            locked: true,
          },
        ],
        total: 1,
      };
    },
  } as unknown as import("../ad-relay/relay.js").AdRelay;

  const platform = new AltiumPlatform({
    relay: stubRelay,
    nexar: null,
    altiumWorkspaceUrl: null,
  });
  const result = await platform.getComponents({ offset: 0, limit: 200 });
  assert.equal(result.supported, true);
  if (result.supported) {
    assert.equal(result.data.items.length, 1);
    const c = result.data.items[0];
    assert.equal(c.primitiveId, "comp_0");
    assert.equal(c.designator, "U1");
    assert.equal(c.mpn, "STM32F4");
    assert.equal(c.x, 25.4);
    assert.equal(c.y, 12.7);
    assert.equal(c.layer, "top", "eTopLayer must normalize to 'top'");
    assert.equal(c.rotation, 90);
    assert.equal(c.locked, true);
  }
});

test("AltiumPlatform.getComponents: relay disconnected → supported:false RELAY_DISCONNECTED", async () => {
  const platform = new AltiumPlatform({
    relay: null,
    nexar: null,
    altiumWorkspaceUrl: null,
  });
  const result = await platform.getComponents({});
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /relay is not connected/i);
  }
});

test("AltiumPlatform.getComponents: malformed AD result (no items array) → actionable supported:false naming the missing relay command", async () => {
  // Defense in depth: if AltiumRelay.js is on an older version that
  // doesn't know `get_components`, the call still completes with a
  // bare/unknown shape. Surface a reason that names the fix
  // ("update AltiumRelay.js") rather than a generic shape error.
  const stubRelay = {
    status: () => ({ connected: true, polling: true }),
    execute: async () => ({ wrong: true }),
  } as unknown as import("../ad-relay/relay.js").AdRelay;
  const platform = new AltiumPlatform({
    relay: stubRelay,
    nexar: null,
    altiumWorkspaceUrl: null,
  });
  const result = await platform.getComponents({});
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /AltiumRelay\.js/);
  }
});

// ─── EasyedaPlatform.getComponents — Sprint 11 PR 11.1 ──────────────

test("EasyedaPlatform.getComponents: maps placement payload with all fields", async () => {
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });

  const pending = platform.getComponents({ offset: 0, limit: 200 });
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  assert.equal(cmd.method, "get_components");

  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: {
      items: [
        {
          primitiveId: "p-1",
          designator: "R1",
          mpn: "RC0402-10K",
          footprint: "0402",
          x: 10.5,
          y: 20.25,
          layer: "top",
          rotation: 0,
          locked: false,
        },
        {
          primitiveId: "p-2",
          designator: "U2",
          properties: { mpn: "ESP32", footprint: "QFN-48" },
          position: { x: 5, y: 5 },
          layer: "bottom",
          rotation: 270,
          locked: true,
        },
      ],
      total: 2,
    },
  });

  const result = await pending;
  assert.equal(result.supported, true);
  if (result.supported) {
    assert.equal(result.data.items.length, 2);
    const r1 = result.data.items[0];
    assert.equal(r1.designator, "R1");
    assert.equal(r1.mpn, "RC0402-10K");
    assert.equal(r1.layer, "top");
    assert.equal(r1.rotation, 0);
    assert.equal(r1.locked, false);
    // Properties-fallback + position:{x,y} fallback
    const u2 = result.data.items[1];
    assert.equal(u2.mpn, "ESP32");
    assert.equal(u2.footprint, "QFN-48");
    assert.equal(u2.x, 5);
    assert.equal(u2.y, 5);
    assert.equal(u2.layer, "bottom");
    assert.equal(u2.locked, true);
  }
  relay.__resetForTests();
});

test("EasyedaPlatform.getComponents: missing fields → empty/zero defaults, never undefined", async () => {
  // The cross-platform contract: PlacedComponent fields are always
  // populated (empty string / 0 / false defaults) so AI clients can
  // count on a deterministic shape. Pin that "" rather than
  // undefined for missing strings.
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const pending = platform.getComponents({});
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: {
      items: [{ primitiveId: "p-1" }],
      total: 1,
    },
  });
  const result = await pending;
  assert.equal(result.supported, true);
  if (result.supported) {
    const c = result.data.items[0];
    assert.equal(c.designator, "");
    assert.equal(c.mpn, "");
    assert.equal(c.footprint, "");
    assert.equal(c.x, 0);
    assert.equal(c.y, 0);
    assert.equal(c.layer, "unknown");
    assert.equal(c.rotation, 0);
    assert.equal(c.locked, false);
  }
  relay.__resetForTests();
});

test("EasyedaPlatform.getComponents: malformed result (no items array) → supported:false", async () => {
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const pending = platform.getComponents({});
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  relay.postResult("ws-a", { id: cmd.id, ok: true, result: { wrong: true } });
  const result = await pending;
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /items.*array/);
  }
  relay.__resetForTests();
});

test("EasyedaPlatform.getComponents: no relay → supported:false NO_BRIDGE", async () => {
  const platform = new EasyedaPlatform({ relay: null, workspaceId: null });
  const result = await platform.getComponents({});
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /extension is not connected/i);
  }
});

// ─── place_by_group wiring — Sprint 11 PR 11.5 ──────────────────────

test("EasyedaPlatform.placeByGroup: filter → grid plan → moveComponent dispatched per target", async () => {
  // End-to-end pin: server pages getComponents, applies the filter,
  // runs the grid planner, then issues moveComponent for each
  // matching designator. Verify the moves dispatch with the planned
  // coords.
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });

  const placePending = platform.placeByGroup({
    filter: "footprint=0402 AND designator=R*",
    strategy: "grid",
    grid: { originX: 100, originY: 200, spacingMm: 10, columns: 2 },
  });

  // Step 1: server calls getComponents
  const getCmd = await relay.nextCommand("ws-a", 0);
  if (!getCmd) throw new Error("expected get_components command");
  assert.equal(getCmd.method, "get_components");
  relay.postResult("ws-a", {
    id: getCmd.id,
    ok: true,
    result: {
      items: [
        // Two matching parts
        {
          primitiveId: "p1",
          designator: "R1",
          footprint: "0402",
          x: 0,
          y: 0,
          width: 1,
          height: 0.5,
          layer: "top",
          rotation: 0,
        },
        {
          primitiveId: "p2",
          designator: "R2",
          footprint: "0402",
          x: 0,
          y: 0,
          width: 1,
          height: 0.5,
          layer: "top",
          rotation: 0,
        },
        // Non-matching part (different footprint)
        {
          primitiveId: "p3",
          designator: "R3",
          footprint: "0805",
          x: 0,
          y: 0,
          width: 2,
          height: 1,
          layer: "top",
          rotation: 0,
        },
      ],
      total: 3,
    },
  });

  // Step 2: server issues moveComponent for R1 and R2 (in that order).
  // Use a 200ms long-poll because the orchestrator's continuation
  // runs on a microtask after the postResult above — 0ms poll
  // would race the orchestrator and return null.
  const moves: Array<{ designator: string; x: number; y: number }> = [];
  for (let i = 0; i < 2; i++) {
    const moveCmd = await relay.nextCommand("ws-a", 200);
    if (!moveCmd) throw new Error("expected move_component command");
    assert.equal(moveCmd.method, "move_component");
    const params = moveCmd.params as { designator: string; x: number; y: number };
    moves.push({ designator: params.designator, x: params.x, y: params.y });
    relay.postResult("ws-a", {
      id: moveCmd.id,
      ok: true,
      result: { designator: params.designator, message: "ok" },
    });
  }

  const result = await placePending;
  assert.equal(result.supported, true);
  if (result.supported) {
    assert.deepEqual(result.data.matched, ["R1", "R2"]);
    assert.deepEqual(result.data.moved, ["R1", "R2"]);
    assert.equal(result.data.skipped.length, 0);
    // Pin the planned coords: 2-column grid starting at (100, 200)
    // with 10mm spacing → R1 at (100,200), R2 at (110,200).
    assert.deepEqual(moves[0], { designator: "R1", x: 100, y: 200 });
    assert.deepEqual(moves[1], { designator: "R2", x: 110, y: 200 });
  }
  relay.__resetForTests();
});

test("EasyedaPlatform.placeByGroup: failed move → recorded in skipped[] with platform's reason, doesn't abort the rest", async () => {
  // Defense in depth: a failed move (e.g., locked target appeared
  // mid-batch) shouldn't kill the whole place_by_group call.
  // Subsequent moves should still dispatch and the failed one ends
  // up in skipped[] with the upstream reason.
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });

  const pending = platform.placeByGroup({
    filter: "designator=R*",
    strategy: "grid",
    grid: { originX: 0, originY: 0 },
  });
  // get_components
  const getCmd = await relay.nextCommand("ws-a", 0);
  if (!getCmd) throw new Error("expected get_components");
  relay.postResult("ws-a", {
    id: getCmd.id,
    ok: true,
    result: {
      items: ["R1", "R2"].map((d) => ({
        primitiveId: `p_${d}`,
        designator: d,
        footprint: "0402",
        x: 0,
        y: 0,
        width: 1,
        height: 0.5,
        layer: "top",
        rotation: 0,
      })),
      total: 2,
    },
  });
  // First move: succeeds. 200ms poll — orchestrator continuation
  // runs on a microtask after the get_components postResult above.
  const m1 = await relay.nextCommand("ws-a", 200);
  if (!m1) throw new Error("expected move 1");
  relay.postResult("ws-a", { id: m1.id, ok: true, result: { message: "ok" } });
  // Second move: fails
  const m2 = await relay.nextCommand("ws-a", 200);
  if (!m2) throw new Error("expected move 2");
  relay.postResult("ws-a", {
    id: m2.id,
    ok: false,
    error: { message: "Component R2 was locked by a concurrent edit." },
  });

  const result = await pending;
  assert.equal(result.supported, true);
  if (result.supported) {
    assert.deepEqual(result.data.moved, ["R1"]);
    assert.equal(result.data.skipped.length, 1);
    assert.equal(result.data.skipped[0].designator, "R2");
    assert.match(result.data.skipped[0].reason, /locked by a concurrent edit/);
  }
  relay.__resetForTests();
});

test("AltiumPlatform.placeByGroup: malformed filter → supported:false WITHOUT calling getComponents", async () => {
  // Fail-fast pin: bad filter input must not pay the
  // getComponents round-trip. The platform stub throws if execute
  // is called, so this test fails loudly if the orchestrator
  // forgets to validate before paging.
  const stubRelay = {
    status: () => ({ connected: true, polling: true }),
    execute: async () => {
      throw new Error("execute called when filter parse should have short-circuited");
    },
  } as unknown as import("../ad-relay/relay.js").AdRelay;
  const platform = new AltiumPlatform({
    relay: stubRelay,
    nexar: null,
    altiumWorkspaceUrl: null,
  });
  const result = await platform.placeByGroup({
    filter: "no_equals_sign",
    strategy: "grid",
    grid: { originX: 0, originY: 0 },
  });
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /missing '='/);
  }
});

test("AltiumPlatform.placeByGroup: around-component target not found → supported:false", async () => {
  const stubRelay = {
    status: () => ({ connected: true, polling: true }),
    execute: async () => ({
      items: [
        {
          primitiveId: "p1",
          designator: "R1",
          footprint: "0402",
          x: 0,
          y: 0,
          width: 1,
          height: 0.5,
          layer: "eTopLayer",
          rotation: 0,
        },
      ],
      total: 1,
    }),
  } as unknown as import("../ad-relay/relay.js").AdRelay;
  const platform = new AltiumPlatform({
    relay: stubRelay,
    nexar: null,
    altiumWorkspaceUrl: null,
  });
  const result = await platform.placeByGroup({
    filter: "designator=R*",
    strategy: "around-component",
    around: { target: "DOES_NOT_EXIST" },
  });
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /DOES_NOT_EXIST/);
    assert.match(result.reason, /not found/);
  }
});

test("EasyedaPlatform.placeByGroup: zero matches → empty result, NO move calls dispatched", async () => {
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const pending = platform.placeByGroup({
    filter: "footprint=NOTHING_MATCHES",
    strategy: "grid",
    grid: { originX: 0, originY: 0 },
  });
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected get_components");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: {
      items: [
        {
          primitiveId: "p1",
          designator: "R1",
          footprint: "0402",
          x: 0,
          y: 0,
          width: 1,
          height: 0.5,
          layer: "top",
          rotation: 0,
        },
      ],
      total: 1,
    },
  });
  const result = await pending;
  assert.equal(result.supported, true);
  if (result.supported) {
    assert.equal(result.data.matched.length, 0);
    assert.equal(result.data.moved.length, 0);
  }
  // No move command was queued — relay queue should be empty.
  // (A nextCommand call with a 0ms timeout returns null when nothing
  //  is queued, distinguishing "queue empty" from "test deadlock".)
  const noCmd = await relay.nextCommand("ws-a", 0);
  assert.equal(noCmd, null, "no move_component should have been queued");
  relay.__resetForTests();
});

// ─── validatePlacement wiring — Sprint 11 PR 11.4 ───────────────────

test("AltiumPlatform.validatePlacement: pages getComponents + runs shared validator", async () => {
  // Wire-format pin: validatePlacement's job is to page through
  // getComponents (calling the AD relay's get_components) and feed
  // the result into the shared validateComponents. Mocked relay
  // returns two overlapping parts in a single page.
  const stubRelay = {
    status: () => ({ connected: true, polling: true }),
    execute: async (method: string) => {
      assert.equal(method, "get_components");
      return {
        items: [
          {
            primitiveId: "p_R1",
            designator: "R1",
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            layer: "eTopLayer",
            rotation: 0,
            locked: false,
          },
          {
            primitiveId: "p_R2",
            designator: "R2",
            x: 0.3,
            y: 0,
            width: 1,
            height: 1,
            layer: "eTopLayer",
            rotation: 0,
            locked: false,
          },
        ],
        total: 2,
      };
    },
  } as unknown as import("../ad-relay/relay.js").AdRelay;

  const platform = new AltiumPlatform({
    relay: stubRelay,
    nexar: null,
    altiumWorkspaceUrl: null,
  });
  const result = await platform.validatePlacement({});
  assert.equal(result.supported, true);
  if (result.supported) {
    assert.equal(result.data.violations.length, 1);
    assert.equal(result.data.violations[0].type, "overlap");
    assert.equal(result.data.totalChecked, 2);
    assert.equal(result.data.approximateBboxCount, 0, "real bbox provided, no heuristic");
  }
});

test("AltiumPlatform.validatePlacement: passes through getComponents supported:false", async () => {
  // When the relay can't run getComponents, validatePlacement must
  // surface the same supported:false reason rather than throw or
  // mask it. AI clients see "relay is not connected" rather than
  // a confusing "validation failed".
  const platform = new AltiumPlatform({
    relay: null,
    nexar: null,
    altiumWorkspaceUrl: null,
  });
  const result = await platform.validatePlacement({});
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /relay is not connected/i);
  }
});

test("EasyedaPlatform.validatePlacement: pages getComponents + flags missing bbox as approximate", async () => {
  // EasyEDA path with components missing width/height — exercise
  // both the wiring AND the heuristic-bbox flag. Two parts at the
  // same coords with no bbox data → heuristic 1mm boxes overlap
  // → overlap violation tagged as approximate.
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });

  const pending = platform.validatePlacement({});
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  assert.equal(cmd.method, "get_components");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: {
      items: [
        {
          primitiveId: "p_R1",
          designator: "R1",
          x: 0,
          y: 0,
          // no width/height
          layer: "top",
          rotation: 0,
        },
        {
          primitiveId: "p_R2",
          designator: "R2",
          x: 0,
          y: 0,
          layer: "top",
          rotation: 0,
        },
      ],
      total: 2,
    },
  });

  const result = await pending;
  assert.equal(result.supported, true);
  if (result.supported) {
    assert.equal(result.data.violations.length, 1);
    assert.equal(result.data.approximateBboxCount, 2);
    assert.match(result.data.violations[0].message, /approximate/);
  }
  relay.__resetForTests();
});

test("EasyedaPlatform.getComponents: extracts width/height from boundingBox fallback", async () => {
  // Pin the bbox-fallback chain pin from Sprint 11 PR 11.4: when
  // top-level width/height are missing, fall back to
  // boundingBox: {width, height} and bbox: {w, h}.
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const pending = platform.getComponents({});
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: {
      items: [
        {
          primitiveId: "p_R1",
          designator: "R1",
          x: 0,
          y: 0,
          layer: "top",
          rotation: 0,
          // top-level width/height absent — uses boundingBox
          boundingBox: { width: 2, height: 1.5 },
        },
        {
          primitiveId: "p_R2",
          designator: "R2",
          x: 0,
          y: 0,
          layer: "top",
          rotation: 0,
          // alias path: bbox.w / bbox.h
          bbox: { w: 0.5, h: 0.25 },
        },
      ],
      total: 2,
    },
  });
  const result = await pending;
  assert.equal(result.supported, true);
  if (result.supported) {
    assert.equal(result.data.items[0].width, 2);
    assert.equal(result.data.items[0].height, 1.5);
    assert.equal(result.data.items[1].width, 0.5);
    assert.equal(result.data.items[1].height, 0.25);
  }
  relay.__resetForTests();
});

// ─── unrouteNet — Sprint 12 PR 12.3 ──────────────────────────────────

import { buildUnrouteResult } from "./altium.js";

test("buildUnrouteResult: forwards relay's count fields + message verbatim", () => {
  // Pin the happy path: when the relay supplies all four fields,
  // the helper returns them unchanged. Used by both platforms;
  // ensures the count contract is single-sourced.
  const result = buildUnrouteResult("VCC", {
    deletedTraces: 23,
    deletedVias: 4,
    skippedLocked: 1,
    message: "Unrouted 'VCC': deleted 23 trace(s), 4 via(s), 1 locked skipped on Altium.",
  });
  assert.equal(result.net, "VCC");
  assert.equal(result.deletedTraces, 23);
  assert.equal(result.deletedVias, 4);
  assert.equal(result.skippedLocked, 1);
  assert.match(result.message, /Unrouted 'VCC'/);
});

test("buildUnrouteResult: synthesizes message when relay didn't supply one (older relay version)", () => {
  // Defense in depth: an older relay version that returns counts
  // without a message gets a synthesized fallback so AI clients
  // still see a coherent confirmation.
  const result = buildUnrouteResult("GND", {
    deletedTraces: 5,
    deletedVias: 0,
    skippedLocked: 0,
  });
  assert.equal(result.deletedTraces, 5);
  assert.match(result.message, /Unrouted 'GND'/);
  assert.match(result.message, /5 trace\(s\), 0 via\(s\)/);
});

test("buildUnrouteResult: empty result (no traces) → 'already unrouted or doesn't exist' message", () => {
  // Pin the disambiguation message: zero deletions + zero
  // skipped means the net was either already clean or
  // doesn't exist on this board. Distinct from a successful
  // unroute that happened to have only locked traces.
  const result = buildUnrouteResult("MysteryNet", {
    deletedTraces: 0,
    deletedVias: 0,
    skippedLocked: 0,
  });
  assert.match(result.message, /already unrouted or doesn't exist/);
});

test("AltiumPlatform.unrouteNet: forwards net to relay; returns count envelope", async () => {
  const captured: Array<{ method: string; params: Record<string, unknown> }> = [];
  const stubRelay = {
    status: () => ({ connected: true, polling: true }),
    execute: async (method: string, params: Record<string, unknown>) => {
      captured.push({ method, params });
      return {
        net: "VCC",
        deletedTraces: 12,
        deletedVias: 2,
        skippedLocked: 0,
        message: "Unrouted 'VCC': deleted 12 trace(s), 2 via(s) on Altium.",
      };
    },
  } as unknown as import("../ad-relay/relay.js").AdRelay;

  const platform = new AltiumPlatform({
    relay: stubRelay,
    nexar: null,
    altiumWorkspaceUrl: null,
  });
  const result = await platform.unrouteNet({ net: "VCC" });
  assert.equal(captured[0].method, "unroute_net");
  assert.deepEqual(captured[0].params, { net: "VCC" });
  assert.equal(result.supported, true);
  if (result.supported) {
    assert.equal(result.data.deletedTraces, 12);
    assert.equal(result.data.deletedVias, 2);
  }
});

test("AltiumPlatform.unrouteNet: relay disconnected → supported:false", async () => {
  const platform = new AltiumPlatform({
    relay: null,
    nexar: null,
    altiumWorkspaceUrl: null,
  });
  const result = await platform.unrouteNet({ net: "VCC" });
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /relay is not connected/i);
  }
});

test("EasyedaPlatform.unrouteNet: round-trips with locked-skipped count surfaced", async () => {
  // Pin the locked-skipped path: extension reports that some
  // traces couldn't be deleted due to lock state. AI client must
  // see the count so it can decide whether to call lock_component
  // (when implemented for traces) or accept the partial unroute.
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });

  const pending = platform.unrouteNet({ net: "GND" });
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected unroute_net command");
  assert.equal(cmd.method, "unroute_net");
  assert.equal(cmd.params.net, "GND");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: {
      net: "GND",
      deletedTraces: 8,
      deletedVias: 0,
      skippedLocked: 3,
      message: "Unrouted 'GND': deleted 8 trace(s), 0 via(s), 3 locked skipped on EasyEDA.",
    },
  });
  const result = await pending;
  assert.equal(result.supported, true);
  if (result.supported) {
    assert.equal(result.data.deletedTraces, 8);
    assert.equal(result.data.skippedLocked, 3);
    assert.match(result.data.message, /3 locked skipped/);
  }
  relay.__resetForTests();
});

test("EasyedaPlatform.unrouteNet: no relay → supported:false NO_BRIDGE", async () => {
  const platform = new EasyedaPlatform({ relay: null, workspaceId: null });
  const result = await platform.unrouteNet({ net: "VCC" });
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /extension is not connected/i);
  }
});

// ─── Design rules — Sprint 12 PR 12.2 ────────────────────────────────

import { normalizeRuleKind } from "./altium.js";

test("normalizeRuleKind: AD enum flavors and EasyEDA variants collapse to the cross-platform union", () => {
  // Common AD rule type names
  assert.equal(normalizeRuleKind("Clearance"), "clearance");
  assert.equal(normalizeRuleKind("MinClearance"), "clearance");
  assert.equal(normalizeRuleKind("Width"), "width");
  assert.equal(normalizeRuleKind("RoutingVias"), "via");
  // Order pin: "via" must beat "width" since AD has rule types
  // like "ViaWidth" that include both substrings.
  assert.equal(normalizeRuleKind("ViaWidth"), "via");
  // Hole-related rules collapse to "via"
  assert.equal(normalizeRuleKind("HoleSize"), "via");
  // Anything we can't classify → "other" (safer than guessing)
  assert.equal(normalizeRuleKind("PolygonConnect"), "other");
  assert.equal(normalizeRuleKind(undefined), "other");
});

test("AltiumPlatform.getDesignRules: relay round-trip maps all three kinds + scope DSL", async () => {
  const stubRelay = {
    status: () => ({ connected: true, polling: true }),
    execute: async (method: string) => {
      assert.equal(method, "get_design_rules");
      return {
        items: [
          {
            name: "DefaultClearance",
            kind: "Clearance",
            scope: "All",
            clearanceMm: 0.2,
          },
          {
            name: "VccWidth",
            kind: "Width",
            scope: { type: "net", target: "VCC" },
            widthMm: { min: 0.2, preferred: 0.3, max: 0.5 },
          },
          {
            name: "PowerVias",
            kind: "RoutingVias",
            scope: { type: "net-class", target: "Power" },
            viaMm: { holeDiameter: 0.3, padDiameter: 0.6 },
          },
        ],
      };
    },
  } as unknown as import("../ad-relay/relay.js").AdRelay;

  const platform = new AltiumPlatform({
    relay: stubRelay,
    nexar: null,
    altiumWorkspaceUrl: null,
  });
  const result = await platform.getDesignRules();
  assert.equal(result.supported, true);
  if (result.supported) {
    assert.equal(result.data.length, 3);
    const clr = result.data[0];
    assert.equal(clr.kind, "clearance");
    assert.equal(clr.scope.type, "all");
    assert.equal(clr.clearanceMm, 0.2);
    const w = result.data[1];
    assert.equal(w.kind, "width");
    assert.equal(w.scope.type, "net");
    assert.equal(w.scope.target, "VCC");
    assert.deepEqual(w.widthMm, { min: 0.2, preferred: 0.3, max: 0.5 });
    const v = result.data[2];
    assert.equal(v.kind, "via");
    assert.equal(v.scope.type, "net-class");
    assert.equal(v.scope.target, "Power");
    assert.deepEqual(v.viaMm, { holeDiameter: 0.3, padDiameter: 0.6 });
  }
});

test("AltiumPlatform.getDesignRules: scope as 'InNet(VCC)' string parses to {type:net, target:VCC}", async () => {
  // AD's RuleScope returns string DSL like InNet('VCC') /
  // InNetClass('Power'). normalizeDesignRule must parse these.
  const stubRelay = {
    status: () => ({ connected: true, polling: true }),
    execute: async () => ({
      items: [{ name: "R1", kind: "clearance", scope: "InNet('VCC')", clearanceMm: 0.15 }],
    }),
  } as unknown as import("../ad-relay/relay.js").AdRelay;
  const platform = new AltiumPlatform({
    relay: stubRelay,
    nexar: null,
    altiumWorkspaceUrl: null,
  });
  const result = await platform.getDesignRules();
  assert.equal(result.supported, true);
  if (result.supported) {
    assert.equal(result.data[0].scope.type, "net");
    assert.equal(result.data[0].scope.target, "VCC");
  }
});

test("AltiumPlatform.getDesignRules: unrecognized rule kind → 'other' with raw preserved", async () => {
  const stubRelay = {
    status: () => ({ connected: true, polling: true }),
    execute: async () => ({
      items: [{ name: "Polygon1", kind: "PolygonConnect", scope: "All", strangeField: 42 }],
    }),
  } as unknown as import("../ad-relay/relay.js").AdRelay;
  const platform = new AltiumPlatform({
    relay: stubRelay,
    nexar: null,
    altiumWorkspaceUrl: null,
  });
  const result = await platform.getDesignRules();
  assert.equal(result.supported, true);
  if (result.supported) {
    assert.equal(result.data[0].kind, "other");
    assert.equal(result.data[0].clearanceMm, undefined);
    // Raw preserved for callers that need finer detail
    const rawObj = result.data[0].raw as { strangeField: number };
    assert.equal(rawObj.strangeField, 42);
  }
});

test("AltiumPlatform.getDesignRules: relay disconnected + malformed result → supported:false", async () => {
  // Two failure modes in one test for compactness.
  const disconnected = await new AltiumPlatform({
    relay: null,
    nexar: null,
    altiumWorkspaceUrl: null,
  }).getDesignRules();
  assert.equal(disconnected.supported, false);
  if (disconnected.supported === false) {
    assert.match(disconnected.reason, /relay is not connected/i);
  }
  const stubRelay = {
    status: () => ({ connected: true, polling: true }),
    execute: async () => ({ wrong: true }),
  } as unknown as import("../ad-relay/relay.js").AdRelay;
  const malformed = await new AltiumPlatform({
    relay: stubRelay,
    nexar: null,
    altiumWorkspaceUrl: null,
  }).getDesignRules();
  assert.equal(malformed.supported, false);
  if (malformed.supported === false) {
    assert.match(malformed.reason, /AltiumRelay\.js/);
  }
});

test("AltiumPlatform.setRouteRule: forwards full envelope to relay; returns confirmation", async () => {
  const captured: Array<{ method: string; params: Record<string, unknown> }> = [];
  const stubRelay = {
    status: () => ({ connected: true, polling: true }),
    execute: async (method: string, params: Record<string, unknown>) => {
      captured.push({ method, params });
      return { name: "DefaultClearance", message: "Updated rule 'DefaultClearance' (clearance) on Altium." };
    },
  } as unknown as import("../ad-relay/relay.js").AdRelay;
  const platform = new AltiumPlatform({
    relay: stubRelay,
    nexar: null,
    altiumWorkspaceUrl: null,
  });
  const result = await platform.setRouteRule({
    name: "DefaultClearance",
    kind: "clearance",
    clearanceMm: 0.3,
  });
  assert.equal(captured[0].method, "set_route_rule");
  assert.equal(captured[0].params.name, "DefaultClearance");
  assert.equal(captured[0].params.kind, "clearance");
  assert.equal(captured[0].params.clearanceMm, 0.3);
  assert.equal(result.supported, true);
  if (result.supported) {
    assert.equal(result.data.designator, "DefaultClearance");
    assert.match(result.data.message, /Updated rule/);
  }
});

test("AltiumPlatform.setRouteRule: relay throws 'rule not found' → supported:false carries the reason", async () => {
  const stubRelay = {
    status: () => ({ connected: true, polling: true }),
    execute: async () => {
      throw new Error("Design rule 'GhostRule' not found on the active PCB.");
    },
  } as unknown as import("../ad-relay/relay.js").AdRelay;
  const platform = new AltiumPlatform({
    relay: stubRelay,
    nexar: null,
    altiumWorkspaceUrl: null,
  });
  const result = await platform.setRouteRule({
    name: "GhostRule",
    kind: "clearance",
    clearanceMm: 0.2,
  });
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /'GhostRule' not found/);
  }
});

test("EasyedaPlatform.getDesignRules + setRouteRule: route through correct relay methods", async () => {
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });

  // get_design_rules
  const getPending = platform.getDesignRules();
  let cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected get_design_rules command");
  assert.equal(cmd.method, "get_design_rules");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: {
      items: [
        { name: "MinGap", kind: "clearance", scope: "All", clearanceMm: 0.15 },
      ],
    },
  });
  const getResult = await getPending;
  assert.equal(getResult.supported, true);
  if (getResult.supported) {
    assert.equal(getResult.data.length, 1);
    assert.equal(getResult.data[0].kind, "clearance");
  }

  // set_route_rule
  const setPending = platform.setRouteRule({
    name: "MinGap",
    kind: "clearance",
    clearanceMm: 0.25,
  });
  cmd = await relay.nextCommand("ws-a", 200);
  if (!cmd) throw new Error("expected set_route_rule command");
  assert.equal(cmd.method, "set_route_rule");
  assert.equal(cmd.params.kind, "clearance");
  assert.equal(cmd.params.clearanceMm, 0.25);
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: { name: "MinGap", message: "Updated rule 'MinGap' (clearance) on EasyEDA." },
  });
  const setResult = await setPending;
  assert.equal(setResult.supported, true);
  if (setResult.supported) {
    assert.match(setResult.data.message, /Updated rule 'MinGap'/);
  }
  relay.__resetForTests();
});

test("EasyedaPlatform.getDesignRules + setRouteRule: no relay → supported:false NO_BRIDGE", async () => {
  const platform = new EasyedaPlatform({ relay: null, workspaceId: null });
  for (const result of [
    await platform.getDesignRules(),
    await platform.setRouteRule({
      name: "X",
      kind: "clearance",
      clearanceMm: 0.1,
    }),
  ]) {
    assert.equal(result.supported, false);
    if (result.supported === false) {
      assert.match(result.reason, /extension is not connected/i);
    }
  }
});

// ─── getNetRouting — Sprint 12 PR 12.1 ──────────────────────────────

test("AltiumPlatform.getNetRouting: relay round-trip maps full payload + normalizes layer keys", async () => {
  // The AD relay returns layer keys like "eTopLayer" / "eMidLayer1"
  // — the platform must normalize them to the cross-platform union
  // (top/bottom/inner/unknown) AND collapse multiple inner-layer
  // keys into a single "inner" sum.
  const stubRelay = {
    status: () => ({ connected: true, polling: true }),
    execute: async (method: string, params: Record<string, unknown>) => {
      assert.equal(method, "get_net_routing");
      assert.deepEqual(params, { offset: 0, limit: 200 });
      return {
        items: [
          {
            netName: "VCC",
            totalLengthMm: 45.5,
            layers: {
              eTopLayer: 30.0,
              eMidLayer1: 8.0,
              eMidLayer2: 7.5,
            },
            viaCount: 3,
            unroutedSegments: 0,
          },
          {
            netName: "GND",
            totalLengthMm: 120.0,
            layers: { eBottomLayer: 120.0 },
            viaCount: 0,
            unroutedSegments: 2,
          },
        ],
        total: 2,
      };
    },
  } as unknown as import("../ad-relay/relay.js").AdRelay;

  const platform = new AltiumPlatform({
    relay: stubRelay,
    nexar: null,
    altiumWorkspaceUrl: null,
  });
  const result = await platform.getNetRouting({});
  assert.equal(result.supported, true);
  if (result.supported) {
    assert.equal(result.data.items.length, 2);
    const vcc = result.data.items[0];
    assert.equal(vcc.netName, "VCC");
    assert.equal(vcc.totalLengthMm, 45.5);
    // Two AD inner layers must collapse to a single "inner" key
    assert.equal(vcc.layers.top, 30.0);
    assert.equal(vcc.layers.inner, 15.5, "8.0 + 7.5 inner-layer collisions sum");
    const gnd = result.data.items[1];
    assert.equal(gnd.layers.bottom, 120.0);
    assert.equal(gnd.unroutedSegments, 2);
  }
});

test("AltiumPlatform.getNetRouting: malformed AD result (no items) → actionable supported:false naming AltiumRelay.js", async () => {
  const stubRelay = {
    status: () => ({ connected: true, polling: true }),
    execute: async () => ({ wrong: true }),
  } as unknown as import("../ad-relay/relay.js").AdRelay;
  const platform = new AltiumPlatform({
    relay: stubRelay,
    nexar: null,
    altiumWorkspaceUrl: null,
  });
  const result = await platform.getNetRouting({});
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /AltiumRelay\.js/);
  }
});

test("AltiumPlatform.getNetRouting: relay disconnected → supported:false RELAY_DISCONNECTED", async () => {
  const platform = new AltiumPlatform({
    relay: null,
    nexar: null,
    altiumWorkspaceUrl: null,
  });
  const result = await platform.getNetRouting({});
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /relay is not connected/i);
  }
});

test("EasyedaPlatform.getNetRouting: extension reports unsupported:true → supported:false naming the missing accessor", async () => {
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const pending = platform.getNetRouting({});
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: { unsupported: true },
  });
  const result = await pending;
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /pcb_Net\.getAll/);
  }
  relay.__resetForTests();
});

test("EasyedaPlatform.getNetRouting: maps extension result with `name` fallback for netName", async () => {
  // The extension may return entries with `name` instead of
  // `netName` depending on how pcb_Net surfaces the data.
  // Pin the fallback wiring.
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const pending = platform.getNetRouting({});
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: {
      items: [
        {
          name: "GND",
          totalLengthMm: 50,
          layers: { top: 30, bottom: 20 },
          viaCount: 2,
          unroutedSegments: 0,
        },
      ],
      total: 1,
    },
  });
  const result = await pending;
  assert.equal(result.supported, true);
  if (result.supported) {
    assert.equal(result.data.items[0].netName, "GND");
    assert.equal(result.data.items[0].totalLengthMm, 50);
  }
  relay.__resetForTests();
});

test("EasyedaPlatform.getNetRouting: no relay → supported:false NO_BRIDGE", async () => {
  const platform = new EasyedaPlatform({ relay: null, workspaceId: null });
  const result = await platform.getNetRouting({});
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /extension is not connected/i);
  }
});

// ─── Keepouts — Sprint 11 PR 11.3 ───────────────────────────────────

import {
  extractVertices,
  normalizeKeepoutKind,
  normalizeKeepoutLayer,
} from "./altium.js";

test("normalizeKeepoutKind: AD enum flavors and EasyEDA variants collapse to the cross-platform union", () => {
  // Altium: ePlacementKeepout / eRoutingKeepout / etc.
  assert.equal(normalizeKeepoutKind("eComponentKeepout"), "placement");
  assert.equal(normalizeKeepoutKind("Placement"), "placement");
  assert.equal(normalizeKeepoutKind("eRoutingKeepout"), "routing");
  assert.equal(normalizeKeepoutKind("track"), "routing");
  assert.equal(normalizeKeepoutKind("via"), "via");
  // Order-sensitive: "via" must beat "routing" since some AD enums
  // include both substrings ("eViaRoutingKeepout"). Pin that
  // explicitly.
  assert.equal(normalizeKeepoutKind("eViaRoutingKeepout"), "via");
  // Defensive default: anything unrecognized treated as the
  // most-restrictive "all" rather than silently letting the AI
  // place/route through it.
  assert.equal(normalizeKeepoutKind("MysteryEnum"), "all");
  assert.equal(normalizeKeepoutKind(undefined), "all");
});

test("normalizeKeepoutLayer: top/bottom/inner/all collapses with 'all' as defensive default", () => {
  assert.equal(normalizeKeepoutLayer("eTopLayer"), "top");
  assert.equal(normalizeKeepoutLayer("Top"), "top");
  assert.equal(normalizeKeepoutLayer("eBottomLayer"), "bottom");
  assert.equal(normalizeKeepoutLayer("eMidLayer3"), "inner");
  // Multi-layer / unknown → "all" (broadest scope) rather than
  // "unknown" — applying a keepout broadly is safer than skipping
  // one we can't classify.
  assert.equal(normalizeKeepoutLayer("eKeepoutLayer"), "all");
  assert.equal(normalizeKeepoutLayer("MultiLayer"), "all");
  assert.equal(normalizeKeepoutLayer(undefined), "all");
});

test("extractVertices: drops malformed entries; preserves valid {x,y} pairs", () => {
  // Pin the input-validation contract for vertex arrays. AD's
  // GetState_Vertices() can return mixed arrays across builds —
  // the helper must drop garbage rather than crash.
  const vertices = extractVertices([
    { x: 1, y: 2 },
    { x: "not a number", y: 0 },
    null,
    "junk",
    { x: 3, y: 4 },
  ]);
  assert.deepEqual(vertices, [
    { x: 1, y: 2 },
    { x: 3, y: 4 },
  ]);
  // Non-array input → empty array, not throw.
  assert.deepEqual(extractVertices(undefined), []);
  assert.deepEqual(extractVertices({ wrong: "shape" }), []);
});

test("AltiumPlatform.getKeepouts: relay round-trip maps full payload + normalizes kind/layer", async () => {
  const stubRelay = {
    status: () => ({ connected: true, polling: true }),
    execute: async (method: string, params: Record<string, unknown>) => {
      assert.equal(method, "get_keepouts");
      assert.deepEqual(params, {});
      return {
        items: [
          {
            id: "kpo_0",
            kind: "ePlacementKeepout",
            layer: "eTopLayer",
            vertices: [
              { x: 0, y: 0 },
              { x: 10, y: 0 },
              { x: 10, y: 5 },
              { x: 0, y: 5 },
            ],
          },
          {
            id: "kpo_1",
            kind: "eRoutingKeepout",
            layer: "eKeepoutLayer",
            vertices: [],
          },
        ],
      };
    },
  } as unknown as import("../ad-relay/relay.js").AdRelay;

  const platform = new AltiumPlatform({
    relay: stubRelay,
    nexar: null,
    altiumWorkspaceUrl: null,
  });
  const result = await platform.getKeepouts();
  assert.equal(result.supported, true);
  if (result.supported) {
    assert.equal(result.data.length, 2);
    const k0 = result.data[0];
    assert.equal(k0.kind, "placement", "ePlacementKeepout normalizes to placement");
    assert.equal(k0.layer, "top");
    assert.equal(k0.vertices.length, 4);
    const k1 = result.data[1];
    assert.equal(k1.kind, "routing");
    assert.equal(k1.layer, "all", "eKeepoutLayer scope normalizes to 'all'");
    assert.equal(k1.vertices.length, 0, "empty vertex array preserved, not dropped");
  }
});

test("AltiumPlatform.getKeepouts: malformed AD result (no items) → actionable supported:false naming AltiumRelay.js", async () => {
  const stubRelay = {
    status: () => ({ connected: true, polling: true }),
    execute: async () => ({ wrong: true }),
  } as unknown as import("../ad-relay/relay.js").AdRelay;
  const platform = new AltiumPlatform({
    relay: stubRelay,
    nexar: null,
    altiumWorkspaceUrl: null,
  });
  const result = await platform.getKeepouts();
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /AltiumRelay\.js/);
  }
});

test("AltiumPlatform.getKeepouts: relay disconnected → supported:false RELAY_DISCONNECTED", async () => {
  const platform = new AltiumPlatform({
    relay: null,
    nexar: null,
    altiumWorkspaceUrl: null,
  });
  const result = await platform.getKeepouts();
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /relay is not connected/i);
  }
});

test("EasyedaPlatform.getKeepouts: extension reports unsupported:true → supported:false naming spike question", async () => {
  // The "API doesn't exist on this Pro version" path. Pin that the
  // reason explicitly references the spike question + names the
  // EasyEDA-specific symbol so an AI client can route the user
  // toward the documented-as-unstable surface.
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const pending = platform.getKeepouts();
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: { unsupported: true },
  });
  const result = await pending;
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /pcb_PrimitiveRegion/);
    assert.match(result.reason, /spike question/i);
  }
  relay.__resetForTests();
});

test("EasyedaPlatform.getKeepouts: maps extension result with defensive properties+points fallback", async () => {
  // Pro version drift: kind/layer/vertices can live under top-level
  // OR `properties` OR `points` (alias). Pin the fallback wiring.
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const pending = platform.getKeepouts();
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: {
      items: [
        {
          uuid: "kpo-1",
          properties: { kind: "routing", layer: "bottom" },
          points: [
            { x: 0, y: 0 },
            { x: 5, y: 5 },
          ],
        },
      ],
    },
  });
  const result = await pending;
  assert.equal(result.supported, true);
  if (result.supported) {
    assert.equal(result.data.length, 1);
    const k = result.data[0];
    assert.equal(k.id, "kpo-1");
    assert.equal(k.kind, "routing");
    assert.equal(k.layer, "bottom");
    assert.equal(k.vertices.length, 2);
  }
  relay.__resetForTests();
});

test("EasyedaPlatform.getKeepouts: no relay → supported:false NO_BRIDGE", async () => {
  const platform = new EasyedaPlatform({ relay: null, workspaceId: null });
  const result = await platform.getKeepouts();
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /extension is not connected/i);
  }
});

// ─── Component mutate tools — Sprint 11 PR 11.2 ─────────────────────

test("AltiumPlatform.moveComponent: forwards designator/x/y to relay; returns confirmation", async () => {
  // Pin the wire format: server passes the full param block through
  // to AltiumRelay.js's move_component; the relay does the
  // BoardIterator walk + mm→coord conversion + SetState_* + guard
  // checks. The platform stays out of designator math.
  const captured: Array<{ method: string; params: Record<string, unknown> }> = [];
  const stubRelay = {
    status: () => ({ connected: true, polling: true }),
    execute: async (method: string, params: Record<string, unknown>) => {
      captured.push({ method, params });
      return { designator: "R1", message: "Moved R1 to (10.50, 20.00) on Altium." };
    },
  } as unknown as import("../ad-relay/relay.js").AdRelay;

  const platform = new AltiumPlatform({
    relay: stubRelay,
    nexar: null,
    altiumWorkspaceUrl: null,
  });
  const result = await platform.moveComponent({ designator: "R1", x: 10.5, y: 20 });
  assert.equal(captured[0].method, "move_component");
  assert.deepEqual(captured[0].params, { designator: "R1", x: 10.5, y: 20 });
  assert.equal(result.supported, true);
  if (result.supported) {
    assert.equal(result.data.designator, "R1");
    assert.match(result.data.message, /Moved R1/);
  }
});

test("AltiumPlatform.moveComponent: relay disconnected → supported:false", async () => {
  const platform = new AltiumPlatform({
    relay: null,
    nexar: null,
    altiumWorkspaceUrl: null,
  });
  const result = await platform.moveComponent({ designator: "R1", x: 0, y: 0 });
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /relay is not connected/i);
  }
});

test("AltiumPlatform.moveComponent: relay throws designator-not-found → supported:false carries the reason", async () => {
  // The "no component" path: the relay throws because
  // FindComponentByDesignator couldn't match. The platform must
  // surface the relay's message verbatim — that's the AI's signal
  // of what went wrong.
  const stubRelay = {
    status: () => ({ connected: true, polling: true }),
    execute: async () => {
      throw new Error("No component with designator 'XR9' on the active PCB.");
    },
  } as unknown as import("../ad-relay/relay.js").AdRelay;
  const platform = new AltiumPlatform({
    relay: stubRelay,
    nexar: null,
    altiumWorkspaceUrl: null,
  });
  const result = await platform.moveComponent({ designator: "XR9", x: 0, y: 0 });
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /designator 'XR9'/);
  }
});

test("AltiumPlatform.rotateComponent + lockComponent: route through correct relay methods", async () => {
  // One test for the full method-name surface — wire format pin:
  // every mutate tool must dispatch to the matching relay command.
  const seen: string[] = [];
  const stubRelay = {
    status: () => ({ connected: true, polling: true }),
    execute: async (method: string) => {
      seen.push(method);
      return { message: "ok" };
    },
  } as unknown as import("../ad-relay/relay.js").AdRelay;
  const platform = new AltiumPlatform({
    relay: stubRelay,
    nexar: null,
    altiumWorkspaceUrl: null,
  });
  await platform.rotateComponent({ designator: "R1", rotation: 90 });
  await platform.lockComponent({ designator: "R1", locked: true });
  assert.deepEqual(seen, ["rotate_component", "lock_component"]);
});

test("AltiumPlatform.lockComponent: confirmation message says 'Locked' or 'Unlocked' per the locked flag", async () => {
  // The verb in the fallback confirmation must reflect the actual
  // direction. AI clients reading transcripts shouldn't see "Locked
  // R1" when they just unlocked it.
  const stubRelay = {
    status: () => ({ connected: true, polling: true }),
    execute: async () => ({}), // no message → fallback path
  } as unknown as import("../ad-relay/relay.js").AdRelay;
  const platform = new AltiumPlatform({
    relay: stubRelay,
    nexar: null,
    altiumWorkspaceUrl: null,
  });
  const lockResult = await platform.lockComponent({ designator: "R1", locked: true });
  if (lockResult.supported) {
    assert.match(lockResult.data.message, /^Locked R1/);
  }
  const unlockResult = await platform.lockComponent({ designator: "R1", locked: false });
  if (unlockResult.supported) {
    assert.match(unlockResult.data.message, /^Unlocked R1/);
  }
});

test("EasyedaPlatform.moveComponent: round-trips via relay; designator/x/y forwarded", async () => {
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const pending = platform.moveComponent({ designator: "U1", x: 5.5, y: 10 });
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  assert.equal(cmd.method, "move_component");
  assert.deepEqual(cmd.params, { designator: "U1", x: 5.5, y: 10 });
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: { designator: "U1", message: "Moved U1 to (5.50, 10.00) on EasyEDA." },
  });
  const result = await pending;
  assert.equal(result.supported, true);
  if (result.supported) {
    assert.match(result.data.message, /Moved U1/);
  }
  relay.__resetForTests();
});

test("EasyedaPlatform.moveComponent: extension reports designator-not-found → supported:false", async () => {
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const pending = platform.moveComponent({ designator: "XR9", x: 0, y: 0 });
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: false,
    error: { message: "No component with designator 'XR9' on the active PCB." },
  });
  const result = await pending;
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /designator 'XR9'/);
  }
  relay.__resetForTests();
});

test("EasyedaPlatform.rotateComponent + lockComponent: route through correct relay methods", async () => {
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  // Rotate
  const rotPending = platform.rotateComponent({ designator: "R1", rotation: 270 });
  let cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  assert.equal(cmd.method, "rotate_component");
  assert.deepEqual(cmd.params, { designator: "R1", rotation: 270 });
  relay.postResult("ws-a", { id: cmd.id, ok: true, result: { message: "ok" } });
  await rotPending;
  // Lock
  const lockPending = platform.lockComponent({ designator: "R1", locked: false });
  cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  assert.equal(cmd.method, "lock_component");
  assert.deepEqual(cmd.params, { designator: "R1", locked: false });
  relay.postResult("ws-a", { id: cmd.id, ok: true, result: { message: "ok" } });
  await lockPending;
  relay.__resetForTests();
});

test("Mutate tools: no relay → supported:false NO_BRIDGE for EasyEDA, RELAY_DISCONNECTED for Altium", async () => {
  // Pin the no-bridge contract for every mutate path so AI clients
  // get a consistent reason regardless of which tool was attempted.
  const ed = new EasyedaPlatform({ relay: null, workspaceId: null });
  const ad = new AltiumPlatform({ relay: null, nexar: null, altiumWorkspaceUrl: null });
  for (const result of [
    await ed.moveComponent({ designator: "R1", x: 0, y: 0 }),
    await ed.rotateComponent({ designator: "R1", rotation: 0 }),
    await ed.lockComponent({ designator: "R1", locked: true }),
  ]) {
    assert.equal(result.supported, false);
    if (result.supported === false) {
      assert.match(result.reason, /extension is not connected/i);
    }
  }
  for (const result of [
    await ad.moveComponent({ designator: "R1", x: 0, y: 0 }),
    await ad.rotateComponent({ designator: "R1", rotation: 0 }),
    await ad.lockComponent({ designator: "R1", locked: true }),
  ]) {
    assert.equal(result.supported, false);
    if (result.supported === false) {
      assert.match(result.reason, /relay is not connected/i);
    }
  }
});

// ─── EasyedaPlatform.getMessages — Sprint 10 PR 10.5 ────────────────

test("EasyedaPlatform.getMessages: maps {messages:[...]} to PlatformMessage[] with severity coercion", async () => {
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });

  const pending = platform.getMessages();
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  assert.equal(cmd.method, "get_messages");

  // Pin a few flavors the EasyEDA DRC engine actually emits:
  //   - "warn" (gets coerced to "warning" — the platform contract
  //     uses the "warning" spelling)
  //   - bare "Error" (different case)
  //   - source/document tagging from the extension's merge
  //   - text under both `message` and `description` keys
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: {
      messages: [
        {
          severity: "Error",
          source: "schematic",
          message: "Floating pin on U1.3",
          document: "main.esch",
        },
        {
          level: "warn",
          source: "pcb",
          description: "Trace width below clearance rule",
        },
        {
          type: "info",
          source: "pcb",
          message: "Auto-routed 23 nets",
        },
      ],
    },
  });

  const result = await pending;
  assert.equal(result.supported, true);
  if (result.supported) {
    assert.equal(result.data.length, 3);
    assert.equal(result.data[0].severity, "error");
    assert.equal(result.data[0].source, "schematic");
    assert.equal(result.data[0].text, "Floating pin on U1.3");
    assert.equal(result.data[0].document, "main.esch");
    // "warn" → "warning" coercion contract
    assert.equal(result.data[1].severity, "warning");
    assert.equal(result.data[1].text, "Trace width below clearance rule");
    assert.equal(result.data[2].severity, "info");
  }
  relay.__resetForTests();
});

test("EasyedaPlatform.getMessages: empty messages array → supported:true with [] data", async () => {
  // A clean design with no DRC violations is a valid state, NOT
  // a tool failure. Distinct from "extension failed" — let the
  // tool wrapper render "no messages" rather than an error.
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const pending = platform.getMessages();
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  relay.postResult("ws-a", { id: cmd.id, ok: true, result: { messages: [] } });
  const result = await pending;
  assert.equal(result.supported, true);
  if (result.supported) assert.equal(result.data.length, 0);
  relay.__resetForTests();
});

test("EasyedaPlatform.getMessages: malformed result (no messages array) → supported:false", async () => {
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const pending = platform.getMessages();
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  relay.postResult("ws-a", { id: cmd.id, ok: true, result: { wrong: true } });
  const result = await pending;
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /messages.*array/);
  }
  relay.__resetForTests();
});

test("EasyedaPlatform.getMessages: no relay → supported:false NO_BRIDGE", async () => {
  const platform = new EasyedaPlatform({ relay: null, workspaceId: null });
  const result = await platform.getMessages();
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
