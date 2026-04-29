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

// ─── production-readiness wiring — Sprint 13 PR 13.3 ────────────────

test("EasyedaPlatform.checkProductionReadiness: orchestrates DRC + getComponents + exports → 5 checks", async () => {
  // End-to-end pin: orchestrator calls each Platform method,
  // aggregates into a 5-check ProductionReadinessResult.
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });

  const pending = platform.checkProductionReadiness({});

  // Step 1: run_drc → empty array (clean DRC)
  let cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected run_drc");
  assert.equal(cmd.method, "run_drc");
  relay.postResult("ws-a", { id: cmd.id, ok: true, result: [] });

  // Step 2: get_components → two well-spaced components
  cmd = await relay.nextCommand("ws-a", 200);
  if (!cmd) throw new Error("expected get_components");
  assert.equal(cmd.method, "get_components");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: {
      items: [
        {
          primitiveId: "p1",
          designator: "U1",
          x: 10,
          y: 10,
          width: 5,
          height: 5,
          layer: "top",
          rotation: 0,
        },
        // FID1 has the fiducial substring in designator
        {
          primitiveId: "p2",
          designator: "FID1",
          footprint: "FIDUCIAL_1mm",
          x: 50,
          y: 50,
          width: 1,
          height: 1,
          layer: "top",
          rotation: 0,
        },
      ],
      total: 2,
    },
  });

  // Steps 3 & 4: exports run in parallel via Promise.all. Both
  // fail (no extension wired up here — EasyEDA returns whatever
  // the relay sends). For this test, simulate both throwing.
  // The orchestrator's buildExportsCheck downgrades to warning.
  // We need to handle two parallel commands — accept either order.
  const cmds = [];
  cmd = await relay.nextCommand("ws-a", 500);
  if (cmd) cmds.push(cmd);
  cmd = await relay.nextCommand("ws-a", 500);
  if (cmd) cmds.push(cmd);
  assert.equal(cmds.length, 2,
    "exports phase issues two commands (gerbers + pick-and-place)");
  // Reply to both as failures (extension missing API)
  for (const c of cmds) {
    relay.postResult("ws-a", {
      id: c.id,
      ok: false,
      error: { message: `${c.method} failed (extension missing API)` },
    });
  }

  const result = await pending;
  assert.equal(result.supported, true);
  if (result.supported) {
    // 5 checks total: drc, drill-aspect, copper-edge, fiducials, exports
    assert.equal(result.data.checks.length, 5);
    const byCategory = Object.fromEntries(
      result.data.checks.map((c) => [c.category, c])
    );
    assert.ok(byCategory.drc.passed);
    assert.equal(byCategory.drc.severity, "info");
    assert.ok(byCategory["drill-aspect"].passed,
      "drill-aspect is informational pass in v1");
    // copper-edge: two components define a 40×40 extent; both
    // sit AT the corners → fails clearance.
    assert.equal(byCategory["copper-edge"].passed, false);
    // Fiducials: only 1 found (FID1), default min is 3 → fails
    // with severity:warning (not error → ready can still depend
    // on whether DRC failed).
    assert.equal(byCategory.fiducials.passed, false);
    assert.equal(byCategory.fiducials.severity, "warning");
    relay.__resetForTests();
  }
});

test("EasyedaPlatform.checkProductionReadiness: clean board with default thresholds → fiducial warning surfaces but DRC passes", async () => {
  // Fresh wire-format pin focused on the per-check breakdown.
  // Default minFiducials=3; we provide 0 → fiducial check fails
  // with severity:warning (NOT error → ready stays true).
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });

  const pending = platform.checkProductionReadiness({});

  let cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected run_drc");
  relay.postResult("ws-a", { id: cmd.id, ok: true, result: [] });

  cmd = await relay.nextCommand("ws-a", 200);
  if (!cmd) throw new Error("expected get_components");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: {
      items: [
        {
          primitiveId: "p1",
          designator: "U1",
          x: 5,
          y: 5,
          width: 1,
          height: 1,
          layer: "top",
          rotation: 0,
        },
        {
          primitiveId: "p2",
          designator: "U2",
          x: 50,
          y: 50,
          width: 1,
          height: 1,
          layer: "top",
          rotation: 0,
        },
      ],
      total: 2,
    },
  });

  // Two parallel exports — fail both
  for (let i = 0; i < 2; i++) {
    const c = await relay.nextCommand("ws-a", 500);
    if (!c) throw new Error("expected export command");
    relay.postResult("ws-a", {
      id: c.id,
      ok: false,
      error: { message: "extension missing API" },
    });
  }

  const result = await pending;
  assert.equal(result.supported, true);
  if (result.supported) {
    // No errors → ready=true even with warnings
    assert.equal(result.data.errorCount, 0);
    assert.equal(result.data.ready, true,
      "warnings don't block — only error-severity does");
    assert.ok(result.data.warningCount >= 1,
      "fiducial check should fail (0 found, default min 3) as warning");
  }
  relay.__resetForTests();
});

test("AltiumPlatform.checkProductionReadiness: DRC supported:false propagates as whole-result supported:false", async () => {
  // Pin upstream-error passthrough — when DRC can't run, the
  // whole readiness check fails with the upstream reason. AI
  // sees "couldn't run readiness check: relay is not connected"
  // rather than a confusing partial result.
  const platform = new AltiumPlatform({
    relay: null,
    nexar: null,
    altiumWorkspaceUrl: null,
  });
  const result = await platform.checkProductionReadiness({});
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /relay is not connected/i);
  }
});

test("EasyedaPlatform.checkProductionReadiness: DRC error → ready:false; warnings alone keep ready:true", async () => {
  // Two-axis pin: ready=false ONLY when error-severity check
  // fails. The DRC check uses error severity when it fails;
  // other checks use warning severity. Test the error path.
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const pending = platform.checkProductionReadiness({ minFiducials: 0 });

  let cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected run_drc");
  // DRC returns one error-severity violation
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: [
      {
        severity: "error",
        category: "Clearance",
        message: "Trace too close to via",
      },
    ],
  });

  cmd = await relay.nextCommand("ws-a", 200);
  if (!cmd) throw new Error("expected get_components");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: {
      items: [
        {
          primitiveId: "p1",
          designator: "U1",
          x: 10,
          y: 10,
          width: 1,
          height: 1,
          layer: "top",
          rotation: 0,
        },
        {
          primitiveId: "p2",
          designator: "U2",
          x: 50,
          y: 50,
          width: 1,
          height: 1,
          layer: "top",
          rotation: 0,
        },
      ],
      total: 2,
    },
  });

  // Exports — fail both
  for (let i = 0; i < 2; i++) {
    const c = await relay.nextCommand("ws-a", 500);
    if (!c) throw new Error("expected export command");
    relay.postResult("ws-a", {
      id: c.id,
      ok: false,
      error: { message: "extension missing API" },
    });
  }

  const result = await pending;
  assert.equal(result.supported, true);
  if (result.supported) {
    assert.equal(result.data.errorCount, 1, "DRC error counted as error");
    assert.equal(result.data.ready, false, "any error → ready=false");
  }
  relay.__resetForTests();
});

// ─── runDrc — Sprint 13 PR 13.2 ──────────────────────────────────────

test("AltiumPlatform.runDrc: triggers DRC, parses Messages-panel for structured violations", async () => {
  // End-to-end pin: relay's run_drc populates the Messages panel,
  // server reads via get_messages, parses DRC entries via the
  // shared parseDrcViolations, returns DrcResult with counts.
  let runDrcCalled = false;
  let getMessagesCalled = false;
  const stubRelay = {
    status: () => ({ connected: true, polling: true }),
    execute: async (method: string) => {
      if (method === "run_drc") {
        runDrcCalled = true;
        return { ok: true };
      }
      if (method === "get_messages") {
        getMessagesCalled = true;
        return {
          messages: [
            {
              severity: "error",
              source: "DRC",
              message: "Clearance: U1 ↔ R7 — 0.05mm gap (rule 0.20mm) at (15.3, 22.1)mm",
            },
            {
              severity: "warning",
              source: "DRC",
              message: "Width: trace 0.15mm below minimum",
            },
            {
              severity: "info",
              source: "Compiler",
              message: "Compile completed", // not DRC, should be filtered
            },
          ],
        };
      }
      return null;
    },
  } as unknown as import("../ad-relay/relay.js").AdRelay;

  const platform = new AltiumPlatform({
    relay: stubRelay,
    nexar: null,
    altiumWorkspaceUrl: null,
  });
  const result = await platform.runDrc();
  assert.equal(runDrcCalled, true, "must trigger DRC first");
  assert.equal(getMessagesCalled, true, "must read Messages panel after");
  assert.equal(result.supported, true);
  if (result.supported) {
    assert.equal(result.data.violations.length, 2,
      "Compiler entries filtered out; only DRC entries surface");
    assert.equal(result.data.errorCount, 1);
    assert.equal(result.data.warningCount, 1);
    assert.equal(result.data.passed, false, "any error → failed");
    // Pin that location parsing worked on the first violation
    assert.deepEqual(result.data.violations[0].location, { x: 15.3, y: 22.1 });
    assert.deepEqual(result.data.violations[0].objects, ["U1", "R7"]);
  }
});

test("AltiumPlatform.runDrc: relay disconnected → supported:false", async () => {
  const platform = new AltiumPlatform({
    relay: null,
    nexar: null,
    altiumWorkspaceUrl: null,
  });
  const result = await platform.runDrc();
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /relay is not connected/i);
  }
});

test("EasyedaPlatform.runDrc: relay round-trip with verbose-error array, parsed to DrcResult", async () => {
  // Pin the EasyEDA verbose-error path: extension calls
  // pcb_Drc.check(true, false, true), returns Array<any>; server
  // unpacks via parseEasyedaDrcArray.
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const pending = platform.runDrc();
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected run_drc command");
  assert.equal(cmd.method, "run_drc");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: [
      {
        severity: "error",
        category: "Clearance",
        message: "Trace too close to via",
        x: 12,
        y: 34,
        objects: ["R1"],
      },
      {
        severity: "warning",
        kind: "Width Rule",
        text: "Trace narrower than minimum",
      },
    ],
  });
  const result = await pending;
  assert.equal(result.supported, true);
  if (result.supported) {
    assert.equal(result.data.violations.length, 2);
    assert.equal(result.data.errorCount, 1);
    assert.equal(result.data.warningCount, 1);
    assert.equal(result.data.passed, false);
    assert.deepEqual(result.data.violations[0].location, { x: 12, y: 34 });
  }
  relay.__resetForTests();
});

test("EasyedaPlatform.runDrc: clean board (empty array) → passed:true with zero counts", async () => {
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const pending = platform.runDrc();
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected run_drc command");
  relay.postResult("ws-a", { id: cmd.id, ok: true, result: [] });
  const result = await pending;
  assert.equal(result.supported, true);
  if (result.supported) {
    assert.equal(result.data.passed, true);
    assert.equal(result.data.violations.length, 0);
  }
  relay.__resetForTests();
});

test("EasyedaPlatform.runDrc: no relay → supported:false NO_BRIDGE", async () => {
  const platform = new EasyedaPlatform({ relay: null, workspaceId: null });
  const result = await platform.runDrc();
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /extension is not connected/i);
  }
});

// ─── Manufacturing exports — Sprint 13 PR 13.1 ───────────────────────

import { readEasyedaArtifactFromUpload } from "./exports.js";

test("readEasyedaArtifactFromUpload: maps upload-route envelope to ExportResult", () => {
  // Pin the wire format the EasyEDA extension's
  // sys_ClientUrl.request → /api/artifacts response shape.
  const result = readEasyedaArtifactFromUpload("gerber-zip", {
    id: "art-abc-123",
    byteSize: 12345,
    format: "gerber-zip",
    expiresAt: "2026-04-29T10:00:00.000Z",
    meta: { layers: 6 },
    downloadUrl: "/api/artifacts/art-abc-123",
  });
  assert.equal(result.supported, true);
  if (result.supported) {
    assert.equal(result.data.artifactId, "art-abc-123");
    assert.equal(result.data.byteSize, 12345);
    assert.equal(result.data.format, "gerber-zip");
    assert.equal(result.data.downloadUrl, "/api/artifacts/art-abc-123");
    assert.deepEqual(result.data.meta, { layers: 6 });
  }
});

test("readEasyedaArtifactFromUpload: missing id → supported:false naming the upload path", () => {
  // Defense-in-depth: extension version drift could change the
  // upload response shape. Surface a clear reason so AI clients
  // know what's broken.
  const result = readEasyedaArtifactFromUpload("csv-bom", {
    byteSize: 100,
    // no id field
  });
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /artifact id/);
    assert.match(result.reason, /\/api\/artifacts/);
  }
});

test("readEasyedaArtifactFromUpload: synthesizes downloadUrl when extension didn't supply one", () => {
  // Older extension versions may return only the id. The helper
  // synthesizes a default downloadUrl so the AI client still
  // gets a usable URL.
  const result = readEasyedaArtifactFromUpload("excellon-drill", {
    id: "art-xyz",
    byteSize: 5000,
  });
  assert.equal(result.supported, true);
  if (result.supported) {
    assert.equal(result.data.downloadUrl, "/api/artifacts/art-xyz");
  }
});

test("AltiumPlatform.exportGerbers: relay disconnected → supported:false", async () => {
  const platform = new AltiumPlatform({
    relay: null,
    nexar: null,
    altiumWorkspaceUrl: null,
    orgId: "org-1",
  });
  const result = await platform.exportGerbers();
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /relay is not connected/i);
  }
});

test("AltiumPlatform.exportGerbers: missing orgId → supported:false naming the stdio limitation", async () => {
  // Pin the architectural contract: export tools require the
  // workspace API key context for artifact scoping. Stdio path
  // doesn't carry one — the error message tells AI clients
  // (and CLI users) what to do.
  const stubRelay = {
    status: () => ({ connected: true, polling: true }),
    execute: async () => ({ path: "/tmp/g.zip" }),
  } as unknown as import("../ad-relay/relay.js").AdRelay;
  const platform = new AltiumPlatform({
    relay: stubRelay,
    nexar: null,
    altiumWorkspaceUrl: null,
    orgId: null,
  });
  const result = await platform.exportGerbers();
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /orgId/);
    assert.match(result.reason, /stdio/);
  }
});

test("AltiumPlatform.exportGerbers: relay throws 'not yet wired' → supported:false carries the actionable message", async () => {
  // Today's AD relay stub throws altiumExportNotWiredYet — pin
  // that the AI client sees the actionable wiring-status message
  // verbatim, with the EasyEDA-fallback hint.
  const stubRelay = {
    status: () => ({ connected: true, polling: true }),
    execute: async () => {
      throw new Error(
        "AD-side Gerber export needs hands-on wiring against OutJob output paths. " +
          "Sprint 13 PR 13.1 ships the architecture (relay → server → artifact store); " +
          "the OutJob-path-resolution piece is tracked as a follow-up. " +
          "Use the EasyEDA workspace for now, or run Project:Generate manually + retrieve the file from the project output directory."
      );
    },
  } as unknown as import("../ad-relay/relay.js").AdRelay;
  const platform = new AltiumPlatform({
    relay: stubRelay,
    nexar: null,
    altiumWorkspaceUrl: null,
    orgId: "org-1",
  });
  const result = await platform.exportGerbers();
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /AD-side Gerber export needs hands-on wiring/);
    assert.match(result.reason, /EasyEDA workspace/);
  }
});

test("EasyedaPlatform.exportGerbers: relay round-trip → ExportResult unpacked from upload envelope", async () => {
  // End-to-end pin: extension returns the upload-route envelope,
  // server unpacks via readEasyedaArtifactFromUpload, returns
  // ExportResult to the caller.
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });

  const pending = platform.exportGerbers();
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected export_gerbers command");
  assert.equal(cmd.method, "export_gerbers");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: {
      id: "art-gerber-1",
      byteSize: 65536,
      format: "gerber-zip",
      expiresAt: "2026-04-29T11:00:00.000Z",
      meta: {},
      downloadUrl: "/api/artifacts/art-gerber-1",
    },
  });
  const result = await pending;
  assert.equal(result.supported, true);
  if (result.supported) {
    assert.equal(result.data.artifactId, "art-gerber-1");
    assert.equal(result.data.format, "gerber-zip");
    assert.equal(result.data.byteSize, 65536);
  }
  relay.__resetForTests();
});

test("EasyedaPlatform.exportBom: passes withLcsc flag to the extension; defaults to true", async () => {
  // Pin the param-passthrough: tool layer accepts withLcsc,
  // platform forwards to the extension.
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });

  // Test 1: explicit withLcsc=false
  let pending = platform.exportBom({ withLcsc: false });
  let cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected export_bom command");
  assert.equal(cmd.params.withLcsc, false);
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: { id: "art-bom-1", byteSize: 100, format: "csv-bom" },
  });
  await pending;

  // Test 2: omit withLcsc — defaults to true on the platform side
  pending = platform.exportBom({});
  cmd = await relay.nextCommand("ws-a", 200);
  if (!cmd) throw new Error("expected export_bom command (2)");
  assert.equal(cmd.params.withLcsc, true,
    "platform must default withLcsc to true when caller omits the flag");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: { id: "art-bom-2", byteSize: 100, format: "csv-bom" },
  });
  await pending;

  relay.__resetForTests();
});

test("EasyedaPlatform exports: no relay → all four return supported:false NO_BRIDGE", async () => {
  // Pin the no-bridge contract for every export so AI clients
  // get a consistent reason regardless of which export was tried.
  const platform = new EasyedaPlatform({ relay: null, workspaceId: null });
  for (const result of [
    await platform.exportGerbers(),
    await platform.exportDrill(),
    await platform.exportBom({}),
    await platform.exportPickAndPlace(),
  ]) {
    assert.equal(result.supported, false);
    if (result.supported === false) {
      assert.match(result.reason, /extension is not connected/i);
    }
  }
});

// ─── xSignals status — Sprint 12 PR 12.6 ─────────────────────────────

import { parseXSignalMessages } from "./altium.js";

test("parseXSignalMessages: 'NAME: N.NNmm of N.NNmm' shape parses correctly", () => {
  const result = parseXSignalMessages([
    { text: "xSignal USB_DP: 95.20mm of 100.00mm matched" },
    { text: "xSignal CLK: 47.5mm of 50mm" },
  ]);
  assert.equal(result.length, 2);
  assert.equal(result[0].name, "USB_DP");
  assert.equal(result[0].currentLengthMm, 95.2);
  assert.equal(result[0].targetLengthMm, 100);
  assert.ok(Math.abs(result[0].matchedPercent - 95.2) < 1e-6);
  assert.equal(result[1].name, "CLK");
  assert.equal(result[1].matchedPercent, 95);
});

test("parseXSignalMessages: 'target N.NNmm, current N.NNmm' shape parses (order-tolerant)", () => {
  // Pin the alternate AD message format. Order tolerance: target
  // can appear before OR after current in the text.
  const result = parseXSignalMessages([
    { text: "xSignal HDMI_TMDS: target 80mm, current 78.4mm" },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "HDMI_TMDS");
  assert.equal(result[0].targetLengthMm, 80);
  assert.equal(result[0].currentLengthMm, 78.4);
});

test("parseXSignalMessages: zero target → matchedPercent NaN, signal still emitted", () => {
  // Defensive: when target is 0 (un-set), matchedPercent must be
  // NaN — distinct from 0% which means "exists but 0mm routed".
  const result = parseXSignalMessages([
    { text: "xSignal STUB: 0mm of 0mm" },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].targetLengthMm, 0);
  assert.equal(result[0].currentLengthMm, 0);
  assert.ok(isNaN(result[0].matchedPercent),
    "matchedPercent must be NaN when target is 0 — divide-by-zero guard");
});

test("parseXSignalMessages: malformed/non-xSignal entries dropped, valid ones preserved", () => {
  // Mixed input: one good, two malformed (no length info / wrong
  // unit), one not-xSignal. Only the good one survives.
  const result = parseXSignalMessages([
    { text: "xSignal GOOD: 50mm of 60mm" },
    { text: "xSignal BAD_NO_LEN: status check pending" },
    { text: "xSignal BAD_UNIT: 1.5in of 2in" }, // mil/inch not parsed
    { text: "Compile: 0 errors, 0 warnings" }, // not xSignal
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "GOOD");
});

test("parseXSignalMessages: empty input → empty output", () => {
  const result = parseXSignalMessages([]);
  assert.deepEqual(result, []);
});

test("AltiumPlatform.getXSignalsStatus: chains getMessages, filters xSignal source, parses", async () => {
  // Stub the relay to provide get_messages output containing two
  // xSignal entries plus unrelated noise. Server filters by source
  // OR text keyword, parses the survivors, returns the structured
  // result.
  const stubRelay = {
    status: () => ({ connected: true, polling: true }),
    execute: async (method: string) => {
      assert.equal(method, "get_messages");
      return {
        messages: [
          {
            severity: "info",
            source: "xSignals",
            message: "xSignal USB_DP: 95.2mm of 100mm",
          },
          {
            severity: "warning",
            source: "xSignals",
            message: "xSignal CLK: 47.5mm of 50mm",
          },
          {
            severity: "info",
            source: "Compiler",
            message: "Compile: 0 errors",
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
  const result = await platform.getXSignalsStatus();
  assert.equal(result.supported, true);
  if (result.supported) {
    assert.equal(result.data.signals.length, 2);
    assert.equal(result.data.signals[0].name, "USB_DP");
    assert.equal(result.data.signals[1].name, "CLK");
    // rawMessages includes the source xSignal entries (not the
    // unrelated Compile entry — filter applied first)
    assert.equal(result.data.rawMessages.length, 2);
  }
});

test("AltiumPlatform.getXSignalsStatus: getMessages supported:false propagates", async () => {
  // Pin upstream-error passthrough — the AI client sees
  // "relay is not connected" rather than a misleading
  // "no xSignals" caption.
  const platform = new AltiumPlatform({
    relay: null,
    nexar: null,
    altiumWorkspaceUrl: null,
  });
  const result = await platform.getXSignalsStatus();
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /relay is not connected/i);
  }
});

test("EasyedaPlatform.getXSignalsStatus: deliberate platform exclusivity — NEVER supported, with the documented reason", async () => {
  // Architectural contract pin: EasyEDA's getXSignalsStatus must
  // NEVER return supported:true. The reason must explicitly call
  // out that this is a deliberate cross-platform difference, not
  // a missing accessor — protects against accidental
  // stub-replacement in a future PR.
  const platform = new EasyedaPlatform({ relay: null, workspaceId: null });
  const result = await platform.getXSignalsStatus();
  assert.equal(result.supported, false,
    "EasyEDA getXSignalsStatus must always be supported:false (deliberate exclusivity)");
  if (result.supported === false) {
    assert.match(result.reason, /deliberate cross-platform difference/i);
    assert.match(result.reason, /xSignals/);
  }
  // Pin: even WITH a relay+workspace, the result must still be
  // supported:false — this isn't a no-bridge fallback, it's
  // genuine exclusivity.
  const relay = new EdaRelay();
  const platformWithBridge = new EasyedaPlatform({
    relay,
    workspaceId: "ws-a",
  });
  const result2 = await platformWithBridge.getXSignalsStatus();
  assert.equal(result2.supported, false,
    "deliberate exclusivity must survive a connected bridge — extension can't be asked");
  if (result2.supported === false) {
    assert.match(result2.reason, /deliberate cross-platform difference/i);
  }
  relay.__resetForTests();
});

// ─── viaStitchPlane wiring — Sprint 12 PR 12.5 ───────────────────────

test("EasyedaPlatform.viaStitchPlane: chains getComponents → getKeepouts → getNetRouting → create_vias", async () => {
  // End-to-end pin: server reads board state in three relay calls
  // (components/keepouts/net-routing), runs the planner, then
  // dispatches create_vias with the survivor positions. Mock
  // each step to verify the chain.
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });

  const pending = platform.viaStitchPlane({
    net: "GND",
    densityMm: 5,
    edgeClearanceMm: 1.5,
  });

  // Step 1: get_components
  let cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected get_components");
  assert.equal(cmd.method, "get_components");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: {
      items: [
        // Two corner components define a 30×30 extent with 5mm pad
        // → grid extent x ∈ [-5, 35], y ∈ [-5, 35] = 9×9 = 81 candidates.
        {
          primitiveId: "p1",
          designator: "U1",
          footprint: "QFN",
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          layer: "top",
          rotation: 0,
        },
        {
          primitiveId: "p2",
          designator: "U2",
          footprint: "QFN",
          x: 30,
          y: 30,
          width: 1,
          height: 1,
          layer: "top",
          rotation: 0,
        },
      ],
      total: 2,
    },
  });

  // Step 2: get_keepouts (optional — empty result OK)
  cmd = await relay.nextCommand("ws-a", 200);
  if (!cmd) throw new Error("expected get_keepouts");
  assert.equal(cmd.method, "get_keepouts");
  relay.postResult("ws-a", { id: cmd.id, ok: true, result: { items: [] } });

  // Step 3: get_net_routing (optional — empty result OK; the
  // existingViasFromNetRouting helper returns [] regardless today)
  cmd = await relay.nextCommand("ws-a", 200);
  if (!cmd) throw new Error("expected get_net_routing");
  assert.equal(cmd.method, "get_net_routing");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: { items: [], total: 0 },
  });

  // Step 4: create_vias — pin the wire format. Server should
  // dispatch with {net, positions: [{x, y}, ...]}.
  cmd = await relay.nextCommand("ws-a", 200);
  if (!cmd) throw new Error("expected create_vias");
  assert.equal(cmd.method, "create_vias");
  assert.equal(cmd.params.net, "GND");
  assert.ok(Array.isArray(cmd.params.positions));
  assert.ok(
    (cmd.params.positions as unknown[]).length > 0,
    "planner should emit at least one survivor position for a 30×30 board"
  );
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: {
      net: "GND",
      placed: (cmd.params.positions as unknown[]).length,
      message: "ok",
    },
  });

  const result = await pending;
  assert.equal(result.supported, true);
  if (result.supported) {
    assert.equal(result.data.net, "GND");
    assert.ok(result.data.placed > 0);
    assert.match(result.data.message, /Stitched 'GND' on easyeda/);
  }
  relay.__resetForTests();
});

test("EasyedaPlatform.viaStitchPlane: getComponents supported:false propagates through the orchestrator", async () => {
  // Pin the early-bailout: when the read phase fails, the create
  // phase should not run, and the AI client sees the upstream
  // reason verbatim.
  const platform = new EasyedaPlatform({ relay: null, workspaceId: null });
  const result = await platform.viaStitchPlane({ net: "GND" });
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /extension is not connected/i);
  }
});

test("EasyedaPlatform.viaStitchPlane: getKeepouts supported:false is non-fatal — proceeds without keepout filtering", async () => {
  // Keepouts are best-effort; an EasyEDA build without
  // pcb_PrimitiveRegion exposed (which surfaces as supported:false)
  // should NOT abort the stitch — proceed without keepout
  // filtering.
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const pending = platform.viaStitchPlane({ net: "GND", densityMm: 10 });

  let cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected get_components");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: {
      items: [
        {
          primitiveId: "p1",
          designator: "U1",
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          layer: "top",
          rotation: 0,
        },
        {
          primitiveId: "p2",
          designator: "U2",
          x: 20,
          y: 20,
          width: 1,
          height: 1,
          layer: "top",
          rotation: 0,
        },
      ],
      total: 2,
    },
  });

  // get_keepouts: extension reports unsupported (older Pro version)
  cmd = await relay.nextCommand("ws-a", 200);
  if (!cmd) throw new Error("expected get_keepouts");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: { unsupported: true },
  });

  // get_net_routing
  cmd = await relay.nextCommand("ws-a", 200);
  if (!cmd) throw new Error("expected get_net_routing");
  relay.postResult("ws-a", { id: cmd.id, ok: true, result: { items: [] } });

  // create_vias still dispatches — keepout filtering was skipped
  // but the rest of the planner ran.
  cmd = await relay.nextCommand("ws-a", 200);
  if (!cmd) throw new Error("expected create_vias");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: { placed: (cmd.params.positions as unknown[]).length },
  });

  const result = await pending;
  assert.equal(result.supported, true,
    "keepouts unsupported must NOT make the whole stitch supported:false");
  relay.__resetForTests();
});

test("AltiumPlatform.viaStitchPlane: relay disconnected → supported:false", async () => {
  const platform = new AltiumPlatform({
    relay: null,
    nexar: null,
    altiumWorkspaceUrl: null,
  });
  const result = await platform.viaStitchPlane({ net: "GND" });
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /relay is not connected/i);
  }
});

// ─── routeDiffPair — Sprint 12 PR 12.4 ───────────────────────────────

import { buildRouteDiffPairResult } from "./altium.js";

test("buildRouteDiffPairResult: routed:true with explicit message → preserved verbatim", () => {
  const result = buildRouteDiffPairResult("USB_DP", "USB_DN", {
    routed: true,
    totalLengthMm: 24.5,
    message: "Routed diff pair (USB_DP, USB_DN): 24.50mm total trace on Altium.",
  });
  assert.equal(result.routed, true);
  assert.equal(result.totalLengthMm, 24.5);
  assert.match(result.message, /Routed diff pair/);
});

test("buildRouteDiffPairResult: missing/non-boolean routed defaults false (defensive)", () => {
  // Pin the safe-default contract: when we can't tell whether
  // routing succeeded, treat as failed so AI clients don't
  // claim success and skip verification.
  const r1 = buildRouteDiffPairResult("A", "B", { routed: "yes" });
  assert.equal(r1.routed, false);
  const r2 = buildRouteDiffPairResult("A", "B", {}); // missing
  assert.equal(r2.routed, false);
  const r3 = buildRouteDiffPairResult("A", "B", null);
  assert.equal(r3.routed, false);
});

test("buildRouteDiffPairResult: synthesizes message when relay didn't supply one", () => {
  // Older relay may return counts/flag without a message — pin
  // the synthesized fallback so AI clients still see a coherent
  // line. Routed-true gets a success-shaped message; routed-false
  // gets a try-again-with-different-params hint.
  const success = buildRouteDiffPairResult("USB_DP", "USB_DN", {
    routed: true,
    totalLengthMm: 12.3,
  });
  assert.match(success.message, /Routed diff pair \(USB_DP, USB_DN\): 12\.30mm/);
  const failed = buildRouteDiffPairResult("USB_DP", "USB_DN", {
    routed: false,
    totalLengthMm: 0,
  });
  assert.match(failed.message, /produced no traces/i);
  assert.match(failed.message, /retry/i);
});

test("AltiumPlatform.routeDiffPair: forwards both nets to relay; returns confirmation", async () => {
  const captured: Array<{ method: string; params: Record<string, unknown> }> = [];
  const stubRelay = {
    status: () => ({ connected: true, polling: true }),
    execute: async (method: string, params: Record<string, unknown>) => {
      captured.push({ method, params });
      return {
        positiveNet: "USB_DP",
        negativeNet: "USB_DN",
        routed: true,
        totalLengthMm: 18.5,
        message: "Routed diff pair (USB_DP, USB_DN): 18.50mm total trace on Altium.",
      };
    },
  } as unknown as import("../ad-relay/relay.js").AdRelay;
  const platform = new AltiumPlatform({
    relay: stubRelay,
    nexar: null,
    altiumWorkspaceUrl: null,
  });
  const result = await platform.routeDiffPair({
    positiveNet: "USB_DP",
    negativeNet: "USB_DN",
  });
  assert.equal(captured[0].method, "route_diff_pair");
  assert.deepEqual(captured[0].params, {
    positiveNet: "USB_DP",
    negativeNet: "USB_DN",
  });
  assert.equal(result.supported, true);
  if (result.supported) {
    assert.equal(result.data.routed, true);
    assert.equal(result.data.totalLengthMm, 18.5);
  }
});

test("AltiumPlatform.routeDiffPair: relay throws 'pair not declared' → supported:false carries reason", async () => {
  // Pin the actionable-error contract: AD relay throws with a
  // message naming the diff-pair editor, server passes through.
  const stubRelay = {
    status: () => ({ connected: true, polling: true }),
    execute: async () => {
      throw new Error(
        "No declared differential pair (FOO, BAR) on this PCB. Declare it in PCB > Design > Differential Pair Editor first."
      );
    },
  } as unknown as import("../ad-relay/relay.js").AdRelay;
  const platform = new AltiumPlatform({
    relay: stubRelay,
    nexar: null,
    altiumWorkspaceUrl: null,
  });
  const result = await platform.routeDiffPair({
    positiveNet: "FOO",
    negativeNet: "BAR",
  });
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /Differential Pair Editor/);
  }
});

test("EasyedaPlatform.routeDiffPair: routed:false from BETA API surfaces correctly (NOT supported:false)", async () => {
  // Critical contract pin: when the BETA pcb_Document.autoRouting
  // says it ran but couldn't lay traces, the tool returns
  // supported:true with routed:false. AI clients distinguish
  // "tool unavailable" from "routing failed" — only the latter
  // is retryable.
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const pending = platform.routeDiffPair({
    positiveNet: "DP",
    negativeNet: "DN",
  });
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected route_diff_pair command");
  assert.equal(cmd.method, "route_diff_pair");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: {
      positiveNet: "DP",
      negativeNet: "DN",
      routed: false,
      totalLengthMm: 0,
      message: "Diff pair router could not lay traces for (DP, DN); too tight a clearance rule for current layer.",
    },
  });
  const result = await pending;
  // Tool ran successfully: supported:true
  assert.equal(result.supported, true);
  if (result.supported) {
    // Router failed: routed:false
    assert.equal(result.data.routed, false);
    assert.match(result.data.message, /could not lay traces/);
  }
  relay.__resetForTests();
});

test("EasyedaPlatform.routeDiffPair: no relay → supported:false NO_BRIDGE", async () => {
  const platform = new EasyedaPlatform({ relay: null, workspaceId: null });
  const result = await platform.routeDiffPair({
    positiveNet: "DP",
    negativeNet: "DN",
  });
  assert.equal(result.supported, false);
  if (result.supported === false) {
    assert.match(result.reason, /extension is not connected/i);
  }
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
