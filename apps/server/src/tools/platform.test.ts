/**
 * Platform tool registration tests — Sprint 10 PR 10.1b.
 *
 * Pins the contract between the platform-agnostic `screenshot`
 * MCP tool and the underlying `Platform.screenshot()` method:
 *
 *   - supported: true → MCP image content + a text caption naming
 *     the platform (so the AI client renders the PNG and gets a
 *     hint for which EDA captured it)
 *   - supported: false → MCP error result with the reason verbatim,
 *     not a thrown exception (the dispatcher must keep running)
 *
 * Both branches exercised against both AltiumPlatform and
 * EasyedaPlatform stubs — per the cross-platform-validation rule
 * from amendment #50 (every cross-platform tool ships with
 * hermetic tests on every supported platform).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPlatformTools } from "./platform.js";
import { EasyedaPlatform } from "../platforms/easyeda.js";
import { AltiumPlatform } from "../platforms/altium.js";
import { EdaRelay } from "../eda-relay/relay.js";
import type { ToolContext } from "../mcp/dispatch.js";
import type { NexarService } from "../services/nexar.js";
import type { Platform, PlatformResponse, ScreenshotResult } from "../platforms/types.js";

const STUB_NEXAR = {} as NexarService;

function buildToolCtx(platform: Platform): ToolContext {
  return { nexar: STUB_NEXAR, metering: null, platform };
}

/**
 * Pull the registered `screenshot` tool's handler out of the MCP
 * server. The SDK doesn't surface a public "list tools" — but we
 * registered the tool ourselves, so we can re-bind handler-style
 * by calling the same registration code path with a sniffer.
 */
type CapturedHandler = () => Promise<{
  content: Array<{ type: string }>;
  isError?: boolean;
}>;

function captureHandler(ctx: ToolContext, toolName: string): CapturedHandler {
  let handler: CapturedHandler | null = null;
  const fakeServer = {
    tool: (
      name: string,
      _desc: string,
      _shape: unknown,
      fn: CapturedHandler
    ) => {
      if (name === toolName) handler = fn;
    },
  } as unknown as McpServer;
  registerPlatformTools(fakeServer, ctx);
  if (!handler) throw new Error(`registerPlatformTools didn't register \`${toolName}\``);
  return handler;
}

function captureScreenshotHandler(ctx: ToolContext): CapturedHandler {
  return captureHandler(ctx, "screenshot");
}

function captureGetActiveProjectHandler(ctx: ToolContext): CapturedHandler {
  return captureHandler(ctx, "get_active_project");
}

function captureListProjectsHandler(ctx: ToolContext): CapturedHandler {
  return captureHandler(ctx, "list_projects");
}

/**
 * list_schematic_components carries pagination args, so its
 * captured handler signature differs. Pull it via a typed wrapper
 * rather than the bare CapturedHandler so test bodies can pass
 * {offset, limit}.
 */
type ListSchematicComponentsHandler = (args: {
  offset?: number;
  limit?: number;
}) => Promise<{ content: Array<{ type: string }>; isError?: boolean }>;

function captureListSchematicComponentsHandler(
  ctx: ToolContext
): ListSchematicComponentsHandler {
  let handler: ListSchematicComponentsHandler | null = null;
  const fakeServer = {
    tool: (
      name: string,
      _desc: string,
      _shape: unknown,
      fn: ListSchematicComponentsHandler
    ) => {
      if (name === "list_schematic_components") handler = fn;
    },
  } as unknown as McpServer;
  registerPlatformTools(fakeServer, ctx);
  if (!handler)
    throw new Error("registerPlatformTools didn't register `list_schematic_components`");
  return handler;
}

// ─── EasyEDA: success path ───────────────────────────────────────────

test("screenshot tool: EasyEDA supported:true → MCP image content + platform-named text", async () => {
  // Drive the round-trip through a real EdaRelay so the platform's
  // resolution path is the same as production.
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });

  const handler = captureScreenshotHandler(buildToolCtx(platform));

  // Fire the tool call + provide the relay's response in parallel.
  const result = (async () => handler())();
  const cmd = await relay.nextCommand("ws-a", 0);
  assert.ok(cmd, "relay should have queued the screenshot command");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: { base64Png: "iVBORw0KGgo=", byteLength: 99 },
  });

  const res = await result;
  assert.equal(res.isError, undefined, "supported:true must NOT mark the result as an error");
  assert.equal(res.content.length, 2, "expected text caption + image");
  // The text caption's exact wording matters less than that it
  // names the platform; the AI uses this to disambiguate
  // multi-platform captures.
  assert.equal(res.content[0].type, "text");
  assert.match(
    (res.content[0] as unknown as { text: string }).text,
    /easyeda/,
    "caption should name the platform that produced the screenshot"
  );
  // Image content shape: { type: "image", data: base64, mimeType }.
  assert.equal(res.content[1].type, "image");
  assert.equal((res.content[1] as unknown as { data: string }).data, "iVBORw0KGgo=");
  assert.equal((res.content[1] as unknown as { mimeType: string }).mimeType, "image/png");
  relay.__resetForTests();
});

// ─── EasyEDA: failure path ───────────────────────────────────────────

test("screenshot tool: EasyEDA supported:false (no bridge) → MCP error result, not thrown", async () => {
  // No relay → EasyedaPlatform.screenshot() returns
  // {supported: false, reason: "...not connected..."}. The tool
  // wrapper must surface that as isError: true rather than letting
  // the dispatcher's catch-all see an exception.
  const platform = new EasyedaPlatform({ relay: null, workspaceId: null });
  const handler = captureScreenshotHandler(buildToolCtx(platform));

  const res = await handler();
  assert.equal(res.isError, true);
  assert.equal(res.content.length, 1);
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.match(
    text,
    /Screenshot unavailable/,
    "error result should be prefixed so the AI client can recognize it"
  );
  // The reason from the Platform must round-trip into the user-
  // visible message — this is why the Platform contract carries
  // a non-empty reason, pinned in platforms.test.ts.
  assert.match(text, /not connected/i);
});

// ─── Altium: success path (mocked) ───────────────────────────────────

test("screenshot tool: Altium supported:true → MCP image content + 'altium' caption", async () => {
  // Altium's screenshot path uses PowerShell + System.Drawing
  // locally; we can't run that in CI. Stub a Platform that returns
  // the success branch directly so the tool wrapper's mapping is
  // exercised against an Altium-shaped response.
  const stubAltium: Platform = {
    name: "altium",
    getActiveProject: async () => ({ supported: false, reason: "stub" }),
    listProjects: async () => ({ supported: false, reason: "stub" }),
    listSchematicComponents: async () => ({ supported: false, reason: "stub" }),
    listPcbComponents: async () => ({ supported: false, reason: "stub" }),
    listLibraryComponents: async () => ({ supported: false, reason: "stub" }),
    getComponents: async () => ({ supported: false, reason: "stub" }),
    moveComponent: async () => ({ supported: false, reason: "stub" }),
    rotateComponent: async () => ({ supported: false, reason: "stub" }),
    lockComponent: async () => ({ supported: false, reason: "stub" }),
    getKeepouts: async () => ({ supported: false, reason: "stub" }),
    validatePlacement: async () => ({ supported: false, reason: "stub" }),
    placeByGroup: async () => ({ supported: false, reason: "stub" }),
    getNetRouting: async () => ({ supported: false, reason: "stub" }),
    getDesignRules: async () => ({ supported: false, reason: "stub" }),
    setRouteRule: async () => ({ supported: false, reason: "stub" }),
    unrouteNet: async () => ({ supported: false, reason: "stub" }),
    routeDiffPair: async () => ({ supported: false, reason: "stub" }),
    screenshot: async (): Promise<PlatformResponse<ScreenshotResult>> => ({
      supported: true,
      data: { base64Png: "fakePngBase64Body", byteLength: 12 },
    }),
    runDrc: async () => ({ supported: false, reason: "stub" }),
    getMessages: async () => ({ supported: false, reason: "stub" }),
  };

  const handler = captureScreenshotHandler(buildToolCtx(stubAltium));
  const res = await handler();
  assert.equal(res.isError, undefined);
  assert.equal(res.content[0].type, "text");
  assert.match((res.content[0] as unknown as { text: string }).text, /altium/);
  assert.equal(res.content[1].type, "image");
  assert.equal((res.content[1] as unknown as { data: string }).data, "fakePngBase64Body");
});

// ─── Altium: failure path (the relay-disconnected case) ──────────────

test("screenshot tool: Altium supported:false (relay disconnected) → MCP error result", async () => {
  // Real AltiumPlatform with no relay — the existing PR 9.3 path.
  const platform = new AltiumPlatform({ relay: null, nexar: null, altiumWorkspaceUrl: null });
  const handler = captureScreenshotHandler(buildToolCtx(platform));

  // `screenshot` on AltiumPlatform tries the local PowerShell path
  // first (works without a relay) — so this test asserts only on
  // shape: either supported (PowerShell happens to work in CI) or
  // unsupported (no display attached). Both branches must produce a
  // valid MCP response shape; that's what the assertion enforces.
  const res = await handler();
  assert.ok(res.content.length >= 1);
  if (res.isError) {
    // Headless CI typical case.
    assert.equal(res.content[0].type, "text");
    assert.match(
      (res.content[0] as unknown as { text: string }).text,
      /Screenshot unavailable|altium/i
    );
  } else {
    // Workstation with PowerShell + System.Drawing available.
    assert.equal(res.content[1]?.type, "image");
  }
});

// ─── get_active_project tool ─────────────────────────────────────────

test("get_active_project tool: EasyEDA supported:true → text caption with name + id", async () => {
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const handler = captureGetActiveProjectHandler(buildToolCtx(platform));

  const result = (async () => handler())();
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  assert.equal(cmd.method, "get_active_project");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: { uuid: "proj-acme-123", name: "Acme PSU" },
  });

  const res = await result;
  assert.equal(res.isError, undefined);
  assert.equal(res.content.length, 1);
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.match(text, /easyeda/);
  assert.match(text, /Acme PSU/);
  assert.match(text, /proj-acme-123/);
  relay.__resetForTests();
});

test("get_active_project tool: supported:false → MCP error result, not thrown", async () => {
  // No bridge → returns supported:false. Tool wrapper surfaces the
  // platform's reason so the AI client knows what went wrong.
  const platform = new EasyedaPlatform({ relay: null, workspaceId: null });
  const handler = captureGetActiveProjectHandler(buildToolCtx(platform));
  const res = await handler();
  assert.equal(res.isError, true);
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.match(text, /No active project available/);
  assert.match(text, /not connected/i);
});

test("get_active_project tool: stubbed Altium Platform supported:true → 'altium' caption", async () => {
  // Mirror the cross-platform-validation rule: every tool must
  // have an Altium-side test. Stub a Platform that returns success
  // with an Altium-shaped payload.
  const stubAltium: Platform = {
    name: "altium",
    getActiveProject: async () => ({
      supported: true,
      data: { id: "C:/proj/Acme.PrjPcb", name: "Acme.PrjPcb", raw: {} },
    }),
    listProjects: async () => ({ supported: false, reason: "stub" }),
    listSchematicComponents: async () => ({ supported: false, reason: "stub" }),
    listPcbComponents: async () => ({ supported: false, reason: "stub" }),
    listLibraryComponents: async () => ({ supported: false, reason: "stub" }),
    getComponents: async () => ({ supported: false, reason: "stub" }),
    moveComponent: async () => ({ supported: false, reason: "stub" }),
    rotateComponent: async () => ({ supported: false, reason: "stub" }),
    lockComponent: async () => ({ supported: false, reason: "stub" }),
    getKeepouts: async () => ({ supported: false, reason: "stub" }),
    validatePlacement: async () => ({ supported: false, reason: "stub" }),
    placeByGroup: async () => ({ supported: false, reason: "stub" }),
    getNetRouting: async () => ({ supported: false, reason: "stub" }),
    getDesignRules: async () => ({ supported: false, reason: "stub" }),
    setRouteRule: async () => ({ supported: false, reason: "stub" }),
    unrouteNet: async () => ({ supported: false, reason: "stub" }),
    routeDiffPair: async () => ({ supported: false, reason: "stub" }),
    screenshot: async () => ({ supported: false, reason: "stub" }),
    runDrc: async () => ({ supported: false, reason: "stub" }),
    getMessages: async () => ({ supported: false, reason: "stub" }),
  };
  const handler = captureGetActiveProjectHandler(buildToolCtx(stubAltium));
  const res = await handler();
  assert.equal(res.isError, undefined);
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.match(text, /altium/);
  assert.match(text, /Acme\.PrjPcb/);
});

// ─── list_projects tool ──────────────────────────────────────────────

test("list_projects tool: EasyEDA supported:true → text caption with one line per project", async () => {
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const handler = captureListProjectsHandler(buildToolCtx(platform));

  const result = (async () => handler())();
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  assert.equal(cmd.method, "list_projects");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: [
      { uuid: "p-1", name: "Power Monitor" },
      { uuid: "p-2", name: "DAQ Card" },
    ],
  });

  const res = await result;
  assert.equal(res.isError, undefined);
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.match(text, /Found 2 project/);
  assert.match(text, /easyeda/);
  assert.match(text, /Power Monitor/);
  assert.match(text, /DAQ Card/);
  relay.__resetForTests();
});

test("list_projects tool: empty result → 'no projects found' (not an error)", async () => {
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const handler = captureListProjectsHandler(buildToolCtx(platform));

  const result = (async () => handler())();
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  relay.postResult("ws-a", { id: cmd.id, ok: true, result: [] });

  const res = await result;
  // Empty list is a normal state, not isError. The AI client
  // distinguishes "no projects" (action: create one) from
  // "couldn't list" (action: check connection).
  assert.equal(res.isError, undefined);
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.match(text, /No projects found/);
  relay.__resetForTests();
});

test("list_projects tool: supported:false → MCP error result with platform's reason", async () => {
  // Common case: Altium workspace without an Altium 365 URL.
  const platform = new AltiumPlatform({
    relay: null,
    nexar: {} as never,
    altiumWorkspaceUrl: null,
  });
  const handler = captureListProjectsHandler(buildToolCtx(platform));
  const res = await handler();
  assert.equal(res.isError, true);
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.match(text, /Could not list projects/);
  assert.match(text, /Altium 365 URL/);
});

// ─── list_schematic_components tool ──────────────────────────────────

test("list_schematic_components tool: EasyEDA happy path → caption + one line per component", async () => {
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const handler = captureListSchematicComponentsHandler(buildToolCtx(platform));

  const result = (async () => handler({ offset: 0, limit: 2 }))();
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  assert.deepEqual(cmd.params, { offset: 0, limit: 2 });
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

  const res = await result;
  assert.equal(res.isError, undefined);
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.match(text, /Schematic components/);
  assert.match(text, /R1/);
  assert.match(text, /10k/);
  assert.match(text, /C1/);
  // No pagination footer when nextOffset is null.
  assert.doesNotMatch(text, /More available/);
  relay.__resetForTests();
});

test("list_schematic_components tool: pagination footer when more pages available", async () => {
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const handler = captureListSchematicComponentsHandler(buildToolCtx(platform));

  const result = (async () => handler({ offset: 0, limit: 200 }))();
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
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

  const res = await result;
  assert.equal(res.isError, undefined);
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.match(text, /More available — call again with offset=200/);
  relay.__resetForTests();
});

test("list_schematic_components tool: empty schematic → 'No components' caption (not isError)", async () => {
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const handler = captureListSchematicComponentsHandler(buildToolCtx(platform));

  const result = (async () => handler({}))();
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: { items: [], total: 0 },
  });
  const res = await result;
  assert.equal(res.isError, undefined);
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.match(text, /No components on the active easyeda schematic/);
  relay.__resetForTests();
});

test("list_schematic_components tool: Altium platform returns supported:false → MCP error result", async () => {
  // Altium-side stub today; the AI client should see a clear
  // actionable reason, not a thrown exception.
  const platform = new AltiumPlatform({
    relay: null,
    nexar: null,
    altiumWorkspaceUrl: null,
  });
  const handler = captureListSchematicComponentsHandler(buildToolCtx(platform));
  const res = await handler({});
  assert.equal(res.isError, true);
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.match(text, /Could not list schematic components/);
  assert.match(text, /AD relay/);
});

// ─── list_pcb_components tool ────────────────────────────────────────

function captureListPcbComponentsHandler(
  ctx: ToolContext
): ListSchematicComponentsHandler {
  // Same handler signature as schematic — both take {offset?, limit?}.
  // Reuse the type rather than introducing a parallel one that would
  // drift over time.
  let handler: ListSchematicComponentsHandler | null = null;
  const fakeServer = {
    tool: (
      name: string,
      _desc: string,
      _shape: unknown,
      fn: ListSchematicComponentsHandler
    ) => {
      if (name === "list_pcb_components") handler = fn;
    },
  } as unknown as McpServer;
  registerPlatformTools(fakeServer, ctx);
  if (!handler)
    throw new Error("registerPlatformTools didn't register `list_pcb_components`");
  return handler;
}

test("list_pcb_components tool: EasyEDA happy path → caption + one line per component", async () => {
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const handler = captureListPcbComponentsHandler(buildToolCtx(platform));

  const result = (async () => handler({ offset: 0, limit: 2 }))();
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  assert.deepEqual(cmd.params, { offset: 0, limit: 2 });
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

  const res = await result;
  assert.equal(res.isError, undefined);
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.match(text, /PCB components/);
  assert.match(text, /R1/);
  assert.match(text, /0402/);
  assert.match(text, /U1/);
  assert.match(text, /QFN-32/);
  assert.doesNotMatch(text, /More available/);
  relay.__resetForTests();
});

test("list_pcb_components tool: pagination footer when more pages available", async () => {
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const handler = captureListPcbComponentsHandler(buildToolCtx(platform));

  const result = (async () => handler({ offset: 0, limit: 200 }))();
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

  const res = await result;
  assert.equal(res.isError, undefined);
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.match(text, /More available — call again with offset=200/);
  relay.__resetForTests();
});

test("list_pcb_components tool: empty board → 'No components' caption (not isError)", async () => {
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const handler = captureListPcbComponentsHandler(buildToolCtx(platform));

  const result = (async () => handler({}))();
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: { items: [], total: 0 },
  });
  const res = await result;
  assert.equal(res.isError, undefined);
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.match(text, /No components on the active easyeda PCB/);
  relay.__resetForTests();
});

test("list_pcb_components tool: Altium platform returns supported:false → MCP error result", async () => {
  const platform = new AltiumPlatform({
    relay: null,
    nexar: null,
    altiumWorkspaceUrl: null,
  });
  const handler = captureListPcbComponentsHandler(buildToolCtx(platform));
  const res = await handler({});
  assert.equal(res.isError, true);
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.match(text, /Could not list PCB components/);
  assert.match(text, /AD relay/);
});

// ─── list_library_components tool ────────────────────────────────────

type ListLibraryHandler = (args: {
  offset?: number;
  limit?: number;
  enrichWithLcsc?: boolean;
}) => Promise<{ content: Array<{ type: string }>; isError?: boolean }>;

function captureListLibraryComponentsHandler(
  ctx: ToolContext
): ListLibraryHandler {
  let handler: ListLibraryHandler | null = null;
  const fakeServer = {
    tool: (
      name: string,
      _desc: string,
      _shape: unknown,
      fn: ListLibraryHandler
    ) => {
      if (name === "list_library_components") handler = fn;
    },
  } as unknown as McpServer;
  registerPlatformTools(fakeServer, ctx);
  if (!handler)
    throw new Error("registerPlatformTools didn't register `list_library_components`");
  return handler;
}

test("list_library_components tool: EasyEDA happy path → caption + one line per entry", async () => {
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({
    relay,
    workspaceId: "ws-a",
    nexar: null,
  });
  const handler = captureListLibraryComponentsHandler(buildToolCtx(platform));

  const result = (async () => handler({ offset: 0, limit: 2 }))();
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: {
      items: [
        {
          uuid: "lib-1",
          name: "ESP32-WROOM",
          manufacturerPartNumber: "ESP32-WROOM-32E-N4",
          footprint: "QFN-48",
        },
        {
          uuid: "lib-2",
          name: "10k Resistor",
          lcscId: "C25804",
        },
      ],
      total: 2,
    },
  });

  const res = await result;
  assert.equal(res.isError, undefined);
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.match(text, /Library components/);
  assert.match(text, /ESP32-WROOM/);
  assert.match(text, /ESP32-WROOM-32E-N4/);
  assert.match(text, /QFN-48/);
  assert.match(text, /C25804/);
  assert.doesNotMatch(text, /More available/);
  relay.__resetForTests();
});

test("list_library_components tool: octopart enrichment renders stock summary in line", async () => {
  // Pin the enrichment-visible-in-text contract: when octopart
  // populates with offers, the text rendering surfaces a {N dist,
  // K stk} summary so the AI client sees enrichment hit without
  // having to read the structured payload.
  const stubNexar = {
    searchParts: async () => [
      {
        mpn: "ESP32-WROOM-32E-N4",
        manufacturer: "Espressif",
        description: "Module",
        category: "Modules",
        datasheetUrl: undefined,
        lifecycle: "Active",
        offers: [
          { supplier: "LCSC", sku: "C701341", stock: 50000, moq: 1, prices: [] },
          { supplier: "Digikey", sku: "DK-001", stock: 1200, moq: 1, prices: [] },
        ],
      },
    ],
  } as unknown as import("../services/nexar.js").NexarService;
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({
    relay,
    workspaceId: "ws-a",
    nexar: stubNexar,
  });
  const handler = captureListLibraryComponentsHandler(buildToolCtx(platform));

  const result = (async () => handler({}))();
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
  const res = await result;
  assert.equal(res.isError, undefined);
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.match(text, /\{2 dist, 51200 stk\}/);
  relay.__resetForTests();
});

test("list_library_components tool: empty library → 'No components in library' caption (not isError)", async () => {
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({
    relay,
    workspaceId: "ws-a",
    nexar: null,
  });
  const handler = captureListLibraryComponentsHandler(buildToolCtx(platform));

  const result = (async () => handler({}))();
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: { items: [], total: 0 },
  });
  const res = await result;
  assert.equal(res.isError, undefined);
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.match(text, /No components in this easyeda workspace's library/);
  relay.__resetForTests();
});

test("list_library_components tool: Altium with no nexar configured → MCP error result", async () => {
  const platform = new AltiumPlatform({
    relay: null,
    nexar: null,
    altiumWorkspaceUrl: "https://acme.altium365.com",
  });
  const handler = captureListLibraryComponentsHandler(buildToolCtx(platform));
  const res = await handler({});
  assert.equal(res.isError, true);
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.match(text, /Could not list library components/);
  assert.match(text, /Nexar credentials/);
});

// ─── get_messages tool ───────────────────────────────────────────────

type GetMessagesHandler = (args: {
  minSeverity?: "info" | "warning" | "error";
  limit?: number;
}) => Promise<{ content: Array<{ type: string }>; isError?: boolean }>;

function captureGetMessagesHandler(ctx: ToolContext): GetMessagesHandler {
  let handler: GetMessagesHandler | null = null;
  const fakeServer = {
    tool: (
      name: string,
      _desc: string,
      _shape: unknown,
      fn: GetMessagesHandler
    ) => {
      if (name === "get_messages") handler = fn;
    },
  } as unknown as McpServer;
  registerPlatformTools(fakeServer, ctx);
  if (!handler)
    throw new Error("registerPlatformTools didn't register `get_messages`");
  return handler;
}

test("get_messages tool: severity-counts header + one line per message, default minSeverity=warning drops info", async () => {
  // Default filter is 'warning' so info-class noise drops. Pin the
  // header shape (counts of what's left) and the per-line tagging.
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const handler = captureGetMessagesHandler(buildToolCtx(platform));

  const result = (async () => handler({}))();
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: {
      messages: [
        { severity: "error", source: "pcb", message: "Short on VCC" },
        { severity: "warning", source: "pcb", message: "Tight clearance R3↔R4" },
        { severity: "info", source: "pcb", message: "Routed 12 nets" },
      ],
    },
  });

  const res = await result;
  assert.equal(res.isError, undefined);
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.match(text, /Messages \(easyeda\): 1 error\(s\), 1 warning\(s\)\./);
  assert.match(text, /\[ERROR\] \(pcb\) Short on VCC/);
  assert.match(text, /\[WARNING\] \(pcb\) Tight clearance/);
  // Info dropped by the default filter
  assert.doesNotMatch(text, /Routed 12 nets/);
  relay.__resetForTests();
});

test("get_messages tool: minSeverity=info keeps everything; counts include info", async () => {
  // Opt-in path: AI clients that want the full picture (e.g. compile
  // chatter, info-class DRC entries) pass minSeverity:'info'.
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const handler = captureGetMessagesHandler(buildToolCtx(platform));

  const result = (async () => handler({ minSeverity: "info" }))();
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: {
      messages: [
        { severity: "error", source: "pcb", message: "Short" },
        { severity: "info", source: "pcb", message: "Note" },
      ],
    },
  });

  const res = await result;
  assert.equal(res.isError, undefined);
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.match(text, /1 error\(s\), 1 info/);
  assert.match(text, /\[INFO\] \(pcb\) Note/);
  relay.__resetForTests();
});

test("get_messages tool: clean design (no messages) → 'No messages on the active platform project' (not isError)", async () => {
  // No DRC issues is a happy state — should NOT surface as a tool
  // error. The text differs from the "filtered everything out" case
  // (covered by the next test) so the AI client can tell them apart.
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const handler = captureGetMessagesHandler(buildToolCtx(platform));

  const result = (async () => handler({}))();
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  relay.postResult("ws-a", { id: cmd.id, ok: true, result: { messages: [] } });

  const res = await result;
  assert.equal(res.isError, undefined);
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.match(text, /No messages on the active easyeda project/);
  relay.__resetForTests();
});

// ─── get_components tool ─────────────────────────────────────────────

function captureGetComponentsHandler(
  ctx: ToolContext
): ListSchematicComponentsHandler {
  // Reuses the schematic handler signature — both take {offset?,
  // limit?} and the return shape matches the rest of the tool tests.
  let handler: ListSchematicComponentsHandler | null = null;
  const fakeServer = {
    tool: (
      name: string,
      _desc: string,
      _shape: unknown,
      fn: ListSchematicComponentsHandler
    ) => {
      if (name === "get_components") handler = fn;
    },
  } as unknown as McpServer;
  registerPlatformTools(fakeServer, ctx);
  if (!handler)
    throw new Error("registerPlatformTools didn't register `get_components`");
  return handler;
}

test("get_components tool: caption + one line per placement, fields rendered with units", async () => {
  // Pin the rendered shape AI clients see — it's the contract for
  // anyone reasoning about placement decisions from text output.
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const handler = captureGetComponentsHandler(buildToolCtx(platform));

  const result = (async () => handler({ offset: 0, limit: 2 }))();
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
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
          designator: "U1",
          footprint: "QFN-48",
          x: 5.123456,
          y: 5,
          layer: "bottom",
          rotation: 90,
          locked: true,
        },
      ],
      total: 2,
    },
  });

  const res = await result;
  assert.equal(res.isError, undefined);
  const text = (res.content[0] as unknown as { text: string }).text;
  // Header carries platform + range
  assert.match(text, /Placed components 1–2 of 2 \(easyeda\):/);
  // Per-line: designator, footprint, mm-rounded coords, layer,
  // rotation°, mpn (when present), [LOCKED] (when set)
  assert.match(text, /R1 \(0402\) @ \(10\.50, 20\.25\) top 0° mpn=RC0402-10K/);
  assert.match(text, /U1 \(QFN-48\) @ \(5\.12, 5\.00\) bottom 90° \[LOCKED\]/);
  relay.__resetForTests();
});

test("get_components tool: pagination footer when more pages available", async () => {
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const handler = captureGetComponentsHandler(buildToolCtx(platform));

  const result = (async () => handler({ offset: 0, limit: 200 }))();
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  const items = Array.from({ length: 200 }, (_, i) => ({
    primitiveId: `p-${i}`,
    designator: `R${i}`,
    footprint: "0402",
    x: 0,
    y: 0,
    layer: "top",
    rotation: 0,
    locked: false,
  }));
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: { items, total: 350 },
  });
  const res = await result;
  assert.equal(res.isError, undefined);
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.match(text, /More available — call again with offset=200/);
  relay.__resetForTests();
});

test("get_components tool: empty board → 'No components' caption (not isError)", async () => {
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const handler = captureGetComponentsHandler(buildToolCtx(platform));

  const result = (async () => handler({}))();
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: { items: [], total: 0 },
  });
  const res = await result;
  assert.equal(res.isError, undefined);
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.match(text, /No components on the active easyeda PCB/);
  relay.__resetForTests();
});

// ─── route_diff_pair tool — Sprint 12 PR 12.4 ────────────────────────

type RouteDiffPairHandler = (args: {
  positiveNet: string;
  negativeNet: string;
}) => Promise<{ content: Array<{ type: string }>; isError?: boolean }>;

function captureRouteDiffPairHandler(ctx: ToolContext): RouteDiffPairHandler {
  let handler: RouteDiffPairHandler | null = null;
  const fakeServer = {
    tool: (name: string, _desc: string, _shape: unknown, fn: RouteDiffPairHandler) => {
      if (name === "route_diff_pair") handler = fn;
    },
  } as unknown as McpServer;
  registerPlatformTools(fakeServer, ctx);
  if (!handler) throw new Error("registerPlatformTools didn't register `route_diff_pair`");
  return handler;
}

test("route_diff_pair tool: routed:true → confirmation rendered verbatim, NOT isError", async () => {
  const stubPlatform = {
    name: "easyeda" as const,
    routeDiffPair: async () => ({
      supported: true as const,
      data: {
        positiveNet: "USB_DP",
        negativeNet: "USB_DN",
        routed: true,
        totalLengthMm: 24.5,
        message: "Routed diff pair (USB_DP, USB_DN): 24.50mm total trace on EasyEDA.",
      },
    }),
  } as unknown as Platform;
  const handler = captureRouteDiffPairHandler(buildToolCtx(stubPlatform));
  const res = await handler({ positiveNet: "USB_DP", negativeNet: "USB_DN" });
  assert.equal(res.isError, undefined);
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.equal(text, "Routed diff pair (USB_DP, USB_DN): 24.50mm total trace on EasyEDA.");
});

test("route_diff_pair tool: routed:false is NOT isError — tool ran, router didn't", async () => {
  // Critical contract pin at the tool layer: the AI client
  // distinguishes "tool unavailable" (isError:true, retry-or-abort)
  // from "router couldn't find a path" (no isError, retry with
  // adjusted params).
  const stubPlatform = {
    name: "altium" as const,
    routeDiffPair: async () => ({
      supported: true as const,
      data: {
        positiveNet: "USB_DP",
        negativeNet: "USB_DN",
        routed: false,
        totalLengthMm: 0,
        message: "Diff pair router could not lay traces for (USB_DP, USB_DN); too tight a clearance rule.",
      },
    }),
  } as unknown as Platform;
  const handler = captureRouteDiffPairHandler(buildToolCtx(stubPlatform));
  const res = await handler({ positiveNet: "USB_DP", negativeNet: "USB_DN" });
  assert.equal(res.isError, undefined, "routed:false must NOT set isError — tool ran successfully");
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.match(text, /could not lay traces/);
});

test("route_diff_pair tool: supported:false (e.g. pair not declared) → isError + actionable reason", async () => {
  const stubPlatform = {
    name: "altium" as const,
    routeDiffPair: async () => ({
      supported: false as const,
      reason: "No declared differential pair (FOO, BAR) on this PCB. Declare it in PCB > Design > Differential Pair Editor first.",
    }),
  } as unknown as Platform;
  const handler = captureRouteDiffPairHandler(buildToolCtx(stubPlatform));
  const res = await handler({ positiveNet: "FOO", negativeNet: "BAR" });
  assert.equal(res.isError, true);
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.match(text, /Could not route diff pair/);
  assert.match(text, /Differential Pair Editor/);
});

// ─── unroute_net tool — Sprint 12 PR 12.3 ────────────────────────────

type UnrouteNetHandler = (args: {
  net: string;
}) => Promise<{ content: Array<{ type: string }>; isError?: boolean }>;

function captureUnrouteNetHandler(ctx: ToolContext): UnrouteNetHandler {
  let handler: UnrouteNetHandler | null = null;
  const fakeServer = {
    tool: (name: string, _desc: string, _shape: unknown, fn: UnrouteNetHandler) => {
      if (name === "unroute_net") handler = fn;
    },
  } as unknown as McpServer;
  registerPlatformTools(fakeServer, ctx);
  if (!handler) throw new Error("registerPlatformTools didn't register `unroute_net`");
  return handler;
}

test("unroute_net tool: renders the platform's confirmation verbatim", async () => {
  const stubPlatform = {
    name: "easyeda" as const,
    unrouteNet: async (params: { net: string }) => ({
      supported: true as const,
      data: {
        net: params.net,
        deletedTraces: 12,
        deletedVias: 2,
        skippedLocked: 0,
        message: "Unrouted 'VCC': deleted 12 trace(s), 2 via(s) on EasyEDA.",
      },
    }),
  } as unknown as Platform;
  const handler = captureUnrouteNetHandler(buildToolCtx(stubPlatform));
  const res = await handler({ net: "VCC" });
  assert.equal(res.isError, undefined);
  const text = (res.content[0] as unknown as { text: string }).text;
  // Pin the platform-supplied message reaches the AI verbatim
  assert.equal(text, "Unrouted 'VCC': deleted 12 trace(s), 2 via(s) on EasyEDA.");
});

test("unroute_net tool: skipped-locked count visible in confirmation", async () => {
  // AI reasoning about partial unroutes needs to see the locked
  // count tagged in the message — pin that the message format
  // doesn't drop the skipped-count info.
  const stubPlatform = {
    name: "altium" as const,
    unrouteNet: async () => ({
      supported: true as const,
      data: {
        net: "GND",
        deletedTraces: 8,
        deletedVias: 0,
        skippedLocked: 3,
        message: "Unrouted 'GND': deleted 8 trace(s), 0 via(s), 3 locked skipped on Altium.",
      },
    }),
  } as unknown as Platform;
  const handler = captureUnrouteNetHandler(buildToolCtx(stubPlatform));
  const res = await handler({ net: "GND" });
  assert.equal(res.isError, undefined);
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.match(text, /3 locked skipped/);
});

test("unroute_net tool: supported:false → MCP error result with reason", async () => {
  const stubPlatform = {
    name: "altium" as const,
    unrouteNet: async () => ({
      supported: false as const,
      reason: "Altium Designer relay is not connected.",
    }),
  } as unknown as Platform;
  const handler = captureUnrouteNetHandler(buildToolCtx(stubPlatform));
  const res = await handler({ net: "VCC" });
  assert.equal(res.isError, true);
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.match(text, /Could not unroute net/);
  assert.match(text, /relay is not connected/i);
});

// ─── design rules tools — Sprint 12 PR 12.2 ─────────────────────────

type GetDesignRulesHandler = () => Promise<{ content: Array<{ type: string }>; isError?: boolean }>;
type SetRouteRuleHandler = (args: {
  name: string;
  kind: "clearance" | "width" | "via";
  scope?: { type: "all" | "net" | "net-class"; target?: string };
  clearanceMm?: number;
  widthMm?: { min: number; preferred: number; max: number };
  viaMm?: { holeDiameter: number; padDiameter: number };
}) => Promise<{ content: Array<{ type: string }>; isError?: boolean }>;

function captureGetDesignRulesHandler(ctx: ToolContext): GetDesignRulesHandler {
  let handler: GetDesignRulesHandler | null = null;
  const fakeServer = {
    tool: (name: string, _desc: string, _shape: unknown, fn: GetDesignRulesHandler) => {
      if (name === "get_design_rules") handler = fn;
    },
  } as unknown as McpServer;
  registerPlatformTools(fakeServer, ctx);
  if (!handler) throw new Error("registerPlatformTools didn't register `get_design_rules`");
  return handler;
}

function captureSetRouteRuleHandler(ctx: ToolContext): SetRouteRuleHandler {
  let handler: SetRouteRuleHandler | null = null;
  const fakeServer = {
    tool: (name: string, _desc: string, _shape: unknown, fn: SetRouteRuleHandler) => {
      if (name === "set_route_rule") handler = fn;
    },
  } as unknown as McpServer;
  registerPlatformTools(fakeServer, ctx);
  if (!handler) throw new Error("registerPlatformTools didn't register `set_route_rule`");
  return handler;
}

test("get_design_rules tool: header counts by kind + per-line value summaries", async () => {
  const stubPlatform = {
    name: "easyeda" as const,
    getDesignRules: async () => ({
      supported: true as const,
      data: [
        {
          name: "MinGap",
          kind: "clearance" as const,
          scope: { type: "all" as const },
          clearanceMm: 0.2,
          raw: {},
        },
        {
          name: "VccWidth",
          kind: "width" as const,
          scope: { type: "net" as const, target: "VCC" },
          widthMm: { min: 0.2, preferred: 0.3, max: 0.5 },
          raw: {},
        },
        {
          name: "PowerVias",
          kind: "via" as const,
          scope: { type: "net-class" as const, target: "Power" },
          viaMm: { holeDiameter: 0.3, padDiameter: 0.6 },
          raw: {},
        },
      ],
    }),
  } as unknown as Platform;
  const handler = captureGetDesignRulesHandler(buildToolCtx(stubPlatform));
  const res = await handler();
  assert.equal(res.isError, undefined);
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.match(text, /Design rules on easyeda: 3 total \(1 clearance, 1 via, 1 width\)/);
  // Per-line value summaries
  assert.match(text, /\[clearance\] MinGap \(all\) clearance=0\.200mm/);
  assert.match(text, /\[width\] VccWidth \(net=VCC\) width=0\.200\/0\.300\/0\.500mm/);
  assert.match(text, /\[via\] PowerVias \(net-class=Power\) via=hole 0\.300mm \/ pad 0\.600mm/);
});

test("get_design_rules tool: empty result → 'No design rules' caption (not isError)", async () => {
  const stubPlatform = {
    name: "altium" as const,
    getDesignRules: async () => ({ supported: true as const, data: [] }),
  } as unknown as Platform;
  const handler = captureGetDesignRulesHandler(buildToolCtx(stubPlatform));
  const res = await handler();
  assert.equal(res.isError, undefined);
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.match(text, /No design rules on the active altium PCB/);
});

test("set_route_rule tool: missing kind-specific params → MCP error before any platform call", async () => {
  let platformCalled = false;
  const stubPlatform = {
    name: "easyeda" as const,
    setRouteRule: async () => {
      platformCalled = true;
      return { supported: false as const, reason: "should not be called" };
    },
  } as unknown as Platform;
  const handler = captureSetRouteRuleHandler(buildToolCtx(stubPlatform));
  // kind=width without widthMm
  const res = await handler({ name: "X", kind: "width" });
  assert.equal(res.isError, true);
  assert.equal(platformCalled, false);
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.match(text, /kind='width' requires `widthMm/);
});

test("set_route_rule tool: each kind dispatches with correct params + renders confirmation", async () => {
  // Three calls in one test for compactness — verifies the
  // discriminated-union routing on the tool layer.
  const seenParams: Array<{ kind: string; clearanceMm?: number; widthMm?: unknown; viaMm?: unknown }> = [];
  const stubPlatform = {
    name: "altium" as const,
    setRouteRule: async (params: {
      name: string;
      kind: string;
      clearanceMm?: number;
      widthMm?: unknown;
      viaMm?: unknown;
    }) => {
      seenParams.push(params);
      return {
        supported: true as const,
        data: { designator: params.name, message: `Updated ${params.name}.` },
      };
    },
  } as unknown as Platform;
  const handler = captureSetRouteRuleHandler(buildToolCtx(stubPlatform));

  const r1 = await handler({ name: "C1", kind: "clearance", clearanceMm: 0.25 });
  assert.equal(r1.isError, undefined);
  const r2 = await handler({
    name: "W1",
    kind: "width",
    widthMm: { min: 0.1, preferred: 0.2, max: 0.4 },
  });
  assert.equal(r2.isError, undefined);
  const r3 = await handler({
    name: "V1",
    kind: "via",
    viaMm: { holeDiameter: 0.3, padDiameter: 0.6 },
  });
  assert.equal(r3.isError, undefined);

  // Each call should reach the platform with only the matching value field
  assert.equal(seenParams[0].kind, "clearance");
  assert.equal(seenParams[0].clearanceMm, 0.25);
  assert.equal(seenParams[0].widthMm, undefined);
  assert.equal(seenParams[1].kind, "width");
  assert.deepEqual(seenParams[1].widthMm, { min: 0.1, preferred: 0.2, max: 0.4 });
  assert.equal(seenParams[2].kind, "via");
  assert.deepEqual(seenParams[2].viaMm, { holeDiameter: 0.3, padDiameter: 0.6 });

  // Confirmation rendered verbatim
  assert.match(
    (r1.content[0] as unknown as { text: string }).text,
    /Updated C1\./
  );
});

test("set_route_rule tool: supported:false → MCP error result with reason", async () => {
  const stubPlatform = {
    name: "altium" as const,
    setRouteRule: async () => ({
      supported: false as const,
      reason: "Design rule 'X' not found.",
    }),
  } as unknown as Platform;
  const handler = captureSetRouteRuleHandler(buildToolCtx(stubPlatform));
  const res = await handler({ name: "X", kind: "clearance", clearanceMm: 0.2 });
  assert.equal(res.isError, true);
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.match(text, /Could not set route rule/);
  assert.match(text, /not found/);
});

// ─── get_net_routing tool — Sprint 12 PR 12.1 ────────────────────────

type GetNetRoutingHandler = (args: {
  offset?: number;
  limit?: number;
}) => Promise<{ content: Array<{ type: string }>; isError?: boolean }>;

function captureGetNetRoutingHandler(ctx: ToolContext): GetNetRoutingHandler {
  let handler: GetNetRoutingHandler | null = null;
  const fakeServer = {
    tool: (name: string, _desc: string, _shape: unknown, fn: GetNetRoutingHandler) => {
      if (name === "get_net_routing") handler = fn;
    },
  } as unknown as McpServer;
  registerPlatformTools(fakeServer, ctx);
  if (!handler) throw new Error("registerPlatformTools didn't register `get_net_routing`");
  return handler;
}

test("get_net_routing tool: per-line summary with layer breakdown + UNROUTED tag when present", async () => {
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const handler = captureGetNetRoutingHandler(buildToolCtx(platform));

  const result = (async () => handler({}))();
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: {
      items: [
        {
          netName: "VCC",
          totalLengthMm: 45.5,
          layers: { top: 30, inner: 15.5 },
          viaCount: 2,
          unroutedSegments: 0,
        },
        {
          netName: "GND",
          totalLengthMm: 120,
          layers: { bottom: 120 },
          viaCount: 0,
          unroutedSegments: 3,
        },
      ],
      total: 2,
    },
  });
  const res = await result;
  assert.equal(res.isError, undefined);
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.match(text, /Net routing 1–2 of 2 \(easyeda\):/);
  assert.match(text, /VCC: 45\.50mm \(inner: 15\.50, top: 30\.00\), 2 via\(s\)/);
  // GND has unrouted segments — pin the UNROUTED tag for AI scanning
  assert.match(text, /GND: 120\.00mm \(bottom: 120\.00\), 0 via\(s\), 3 UNROUTED/);
  relay.__resetForTests();
});

test("get_net_routing tool: empty board → 'No nets' caption (not isError)", async () => {
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const handler = captureGetNetRoutingHandler(buildToolCtx(platform));
  const result = (async () => handler({}))();
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  relay.postResult("ws-a", { id: cmd.id, ok: true, result: { items: [] } });
  const res = await result;
  assert.equal(res.isError, undefined);
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.match(text, /No nets on the active easyeda PCB/);
  relay.__resetForTests();
});

test("get_net_routing tool: pagination footer when more pages available", async () => {
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const handler = captureGetNetRoutingHandler(buildToolCtx(platform));
  const result = (async () => handler({ offset: 0, limit: 200 }))();
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  const items = Array.from({ length: 200 }, (_, i) => ({
    netName: `NET_${String(i).padStart(4, "0")}`,
    totalLengthMm: 1,
    layers: { top: 1 },
    viaCount: 0,
    unroutedSegments: 0,
  }));
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: { items, total: 350 },
  });
  const res = await result;
  assert.equal(res.isError, undefined);
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.match(text, /More available — call again with offset=200/);
  relay.__resetForTests();
});

test("get_net_routing tool: AD relay disconnected → MCP error result with reason", async () => {
  const platform = new AltiumPlatform({
    relay: null,
    nexar: null,
    altiumWorkspaceUrl: null,
  });
  const handler = captureGetNetRoutingHandler(buildToolCtx(platform));
  const res = await handler({});
  assert.equal(res.isError, true);
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.match(text, /Could not read net routing/);
  assert.match(text, /relay is not connected/i);
});

// ─── place_by_group tool — Sprint 11 PR 11.5 ─────────────────────────

type PlaceByGroupHandler = (args: {
  filter: string;
  strategy: "grid" | "around-component" | "on-edge";
  grid?: { originX: number; originY: number; spacingMm?: number; columns?: number };
  around?: { target: string; radiusMm?: number };
  edge?: { side: "top" | "bottom" | "left" | "right"; offsetMm?: number };
  obstacleClearanceMm?: number;
}) => Promise<{ content: Array<{ type: string }>; isError?: boolean }>;

function capturePlaceByGroupHandler(ctx: ToolContext): PlaceByGroupHandler {
  let handler: PlaceByGroupHandler | null = null;
  const fakeServer = {
    tool: (name: string, _desc: string, _shape: unknown, fn: PlaceByGroupHandler) => {
      if (name === "place_by_group") handler = fn;
    },
  } as unknown as McpServer;
  registerPlatformTools(fakeServer, ctx);
  if (!handler) throw new Error("registerPlatformTools didn't register `place_by_group`");
  return handler;
}

test("place_by_group tool: missing strategy params → MCP error before any platform call", async () => {
  // Pin the per-strategy validation: zod can't enforce the
  // discriminated-union at the MCP-arg level cleanly, so the tool
  // checks at the handler. Verify it short-circuits with a clear
  // message before reaching the platform.
  let platformCalled = false;
  const stubPlatform = {
    name: "easyeda" as const,
    placeByGroup: async () => {
      platformCalled = true;
      return { supported: false as const, reason: "should not be called" };
    },
  } as unknown as Platform;
  const handler = capturePlaceByGroupHandler(buildToolCtx(stubPlatform));
  const res = await handler({ filter: "designator=R*", strategy: "grid" });
  assert.equal(res.isError, true);
  assert.equal(platformCalled, false);
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.match(text, /strategy='grid' requires `grid:/);
});

test("place_by_group tool: rendering shows summary + moved + skipped sections", async () => {
  // Pin the multi-line render shape AI clients see. Includes
  // truncation behavior when moved/skipped are large.
  const stubPlatform = {
    name: "easyeda" as const,
    placeByGroup: async () => ({
      supported: true as const,
      data: {
        matched: ["R1", "R2", "R3"],
        moved: ["R1", "R2"],
        skipped: [{ designator: "R3", reason: "no valid position" }],
        strategy: "grid",
        message: "Placed 2/3 component(s) using strategy 'grid'; 1 skipped.",
      },
    }),
  } as unknown as Platform;
  const handler = capturePlaceByGroupHandler(buildToolCtx(stubPlatform));
  const res = await handler({
    filter: "designator=R*",
    strategy: "grid",
    grid: { originX: 0, originY: 0 },
  });
  assert.equal(res.isError, undefined);
  const text = (res.content[0] as unknown as { text: string }).text;
  // Summary line
  assert.match(text, /Placed 2\/3 component/);
  // Moved section
  assert.match(text, /Moved: R1, R2/);
  // Skipped section with reasons
  assert.match(text, /Skipped \(1\):/);
  assert.match(text, /R3: no valid position/);
});

test("place_by_group tool: supported:false → MCP error result with reason", async () => {
  const stubPlatform = {
    name: "altium" as const,
    placeByGroup: async () => ({
      supported: false as const,
      reason: "Altium Designer relay is not connected.",
    }),
  } as unknown as Platform;
  const handler = capturePlaceByGroupHandler(buildToolCtx(stubPlatform));
  const res = await handler({
    filter: "designator=R*",
    strategy: "grid",
    grid: { originX: 0, originY: 0 },
  });
  assert.equal(res.isError, true);
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.match(text, /Could not place by group/);
  assert.match(text, /relay is not connected/i);
});

// ─── validate_placement tool — Sprint 11 PR 11.4 ─────────────────────

type ValidatePlacementHandler = (args: {
  spacingMm?: number;
}) => Promise<{ content: Array<{ type: string }>; isError?: boolean }>;

function captureValidatePlacementHandler(ctx: ToolContext): ValidatePlacementHandler {
  let handler: ValidatePlacementHandler | null = null;
  const fakeServer = {
    tool: (name: string, _desc: string, _shape: unknown, fn: ValidatePlacementHandler) => {
      if (name === "validate_placement") handler = fn;
    },
  } as unknown as McpServer;
  registerPlatformTools(fakeServer, ctx);
  if (!handler) throw new Error("registerPlatformTools didn't register `validate_placement`");
  return handler;
}

test("validate_placement tool: violations rendered with type tag + summary header + approximate-bbox note", async () => {
  // End-to-end render pin: header with grouped counts, per-line
  // "[OVERLAP]/[SPACING]" tagging, approximate-bbox note when
  // some entries used the heuristic.
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const handler = captureValidatePlacementHandler(buildToolCtx(platform));

  const result = (async () => handler({}))();
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: {
      items: [
        // R1 vs R2: overlap, real bbox
        { primitiveId: "p1", designator: "R1", x: 0, y: 0, width: 1, height: 1, layer: "top", rotation: 0 },
        { primitiveId: "p2", designator: "R2", x: 0.5, y: 0, width: 1, height: 1, layer: "top", rotation: 0 },
        // R7 vs R8 on the same board, far apart but missing bbox
        // → heuristic kicks in. Place close enough to flag spacing.
        { primitiveId: "p7", designator: "R7", x: 50, y: 50, layer: "top", rotation: 0 },
        { primitiveId: "p8", designator: "R8", x: 51.05, y: 50, layer: "top", rotation: 0 },
      ],
      total: 4,
    },
  });
  const res = await result;
  assert.equal(res.isError, undefined);
  const text = (res.content[0] as unknown as { text: string }).text;
  // Header carries violation counts and approximate-bbox flag
  assert.match(text, /violation\(s\) on easyeda/);
  assert.match(text, /1 overlap/);
  assert.match(text, /heuristic bbox/);
  // Per-line type tagging
  assert.match(text, /\[OVERLAP\] R1 ↔ R2:/);
  relay.__resetForTests();
});

test("validate_placement tool: clean board → 'No placement violations' caption (not isError)", async () => {
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const handler = captureValidatePlacementHandler(buildToolCtx(platform));

  const result = (async () => handler({}))();
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: {
      items: [
        { primitiveId: "p1", designator: "R1", x: 0, y: 0, width: 1, height: 1, layer: "top", rotation: 0 },
        { primitiveId: "p2", designator: "R2", x: 50, y: 50, width: 1, height: 1, layer: "top", rotation: 0 },
      ],
      total: 2,
    },
  });
  const res = await result;
  assert.equal(res.isError, undefined);
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.match(text, /No placement violations on easyeda/);
  assert.match(text, /2 components checked across 1 pair/);
  relay.__resetForTests();
});

test("validate_placement tool: AD relay disconnected → MCP error with reason", async () => {
  const platform = new AltiumPlatform({
    relay: null,
    nexar: null,
    altiumWorkspaceUrl: null,
  });
  const handler = captureValidatePlacementHandler(buildToolCtx(platform));
  const res = await handler({});
  assert.equal(res.isError, true);
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.match(text, /Could not validate placement/);
  assert.match(text, /relay is not connected/i);
});

// ─── get_keepouts tool — Sprint 11 PR 11.3 ───────────────────────────

type GetKeepoutsHandler = () => Promise<{ content: Array<{ type: string }>; isError?: boolean }>;

function captureGetKeepoutsHandler(ctx: ToolContext): GetKeepoutsHandler {
  let handler: GetKeepoutsHandler | null = null;
  const fakeServer = {
    tool: (name: string, _desc: string, _shape: unknown, fn: GetKeepoutsHandler) => {
      if (name === "get_keepouts") handler = fn;
    },
  } as unknown as McpServer;
  registerPlatformTools(fakeServer, ctx);
  if (!handler) throw new Error("registerPlatformTools didn't register `get_keepouts`");
  return handler;
}

test("get_keepouts tool: severity-counts header + bbox-summary line per keepout", async () => {
  // Pin the rendering shape AI clients see: counts grouped by kind
  // in the header, then one line per keepout with kind + layer +
  // bounding-box dims + vertex count + id.
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const handler = captureGetKeepoutsHandler(buildToolCtx(platform));

  const result = (async () => handler())();
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: {
      items: [
        {
          id: "kpo-1",
          kind: "placement",
          layer: "top",
          vertices: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 5 },
            { x: 0, y: 5 },
          ],
        },
        {
          id: "kpo-2",
          kind: "routing",
          layer: "bottom",
          vertices: [{ x: 100, y: 100 }],
        },
      ],
    },
  });

  const res = await result;
  assert.equal(res.isError, undefined);
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.match(text, /Keepouts on easyeda: 2 total/);
  // Counts grouped by kind, alphabetical order
  assert.match(text, /1 placement/);
  assert.match(text, /1 routing/);
  // Per-line bounding-box rendering — 10×5mm for kpo-1, 0×0mm for
  // single-point kpo-2 (degenerate but rendered, not dropped)
  assert.match(text, /\[placement\] on top: 10\.00×5\.00mm bbox, 4 vertices \(id=kpo-1\)/);
  assert.match(text, /\[routing\] on bottom: 0\.00×0\.00mm bbox, 1 vertices \(id=kpo-2\)/);
  relay.__resetForTests();
});

test("get_keepouts tool: empty board → 'No keepouts' caption (not isError)", async () => {
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const handler = captureGetKeepoutsHandler(buildToolCtx(platform));
  const result = (async () => handler())();
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  relay.postResult("ws-a", { id: cmd.id, ok: true, result: { items: [] } });
  const res = await result;
  assert.equal(res.isError, undefined);
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.match(text, /No keepouts on the active easyeda PCB/);
  relay.__resetForTests();
});

test("get_keepouts tool: zero-vertex keepout renders '(no vertices)' rather than crashing on Math.max([])", async () => {
  // Defense in depth: a malformed keepout with empty vertices
  // shouldn't crash the renderer with NaN bbox. Surface it
  // explicitly so the AI sees the malformed entry.
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const handler = captureGetKeepoutsHandler(buildToolCtx(platform));
  const result = (async () => handler())();
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: {
      items: [{ id: "kpo-1", kind: "placement", layer: "top", vertices: [] }],
    },
  });
  const res = await result;
  assert.equal(res.isError, undefined);
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.match(text, /\(no vertices\)/);
  relay.__resetForTests();
});

test("get_keepouts tool: AD relay disconnected → MCP error result with actionable reason", async () => {
  const platform = new AltiumPlatform({
    relay: null,
    nexar: null,
    altiumWorkspaceUrl: null,
  });
  const handler = captureGetKeepoutsHandler(buildToolCtx(platform));
  const res = await handler();
  assert.equal(res.isError, true);
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.match(text, /Could not read keepouts/);
  assert.match(text, /relay is not connected/i);
});

// ─── Mutate tools — Sprint 11 PR 11.2 ────────────────────────────────

type MutateHandler<A> = (args: A) => Promise<{ content: Array<{ type: string }>; isError?: boolean }>;

function captureToolHandler<A>(
  ctx: ToolContext,
  toolName: string
): MutateHandler<A> {
  let handler: MutateHandler<A> | null = null;
  const fakeServer = {
    tool: (name: string, _desc: string, _shape: unknown, fn: MutateHandler<A>) => {
      if (name === toolName) handler = fn;
    },
  } as unknown as McpServer;
  registerPlatformTools(fakeServer, ctx);
  if (!handler) throw new Error(`registerPlatformTools didn't register \`${toolName}\``);
  return handler;
}

test("move_component tool: happy path renders the platform's confirmation verbatim", async () => {
  // The tool's job is thin — pass through, emit confirmation. Pin
  // that the platform's message text reaches the AI client unchanged
  // (so the platform layer's coordinate-formatting decisions are
  // the ones AI clients see).
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const handler = captureToolHandler<{ designator: string; x: number; y: number }>(
    buildToolCtx(platform),
    "move_component"
  );

  const result = (async () =>
    handler({ designator: "R1", x: 10.5, y: 20 }))();
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: { designator: "R1", message: "Moved R1 to (10.50, 20.00) on EasyEDA." },
  });
  const res = await result;
  assert.equal(res.isError, undefined);
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.equal(text, "Moved R1 to (10.50, 20.00) on EasyEDA.");
  relay.__resetForTests();
});

test("move_component tool: supported:false → MCP error result with reason", async () => {
  // The reason should reach the AI client tagged so it's readable
  // ("Could not move component: ...") — distinct from the
  // confirmation-message format on success.
  const platform = new AltiumPlatform({
    relay: null,
    nexar: null,
    altiumWorkspaceUrl: null,
  });
  const handler = captureToolHandler<{ designator: string; x: number; y: number }>(
    buildToolCtx(platform),
    "move_component"
  );
  const res = await handler({ designator: "R1", x: 0, y: 0 });
  assert.equal(res.isError, true);
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.match(text, /Could not move component/);
  assert.match(text, /relay is not connected/i);
});

test("rotate_component tool: passes rotation through; renders confirmation", async () => {
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const handler = captureToolHandler<{ designator: string; rotation: number }>(
    buildToolCtx(platform),
    "rotate_component"
  );
  const result = (async () => handler({ designator: "U1", rotation: 90 }))();
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  assert.deepEqual(cmd.params, { designator: "U1", rotation: 90 });
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: { designator: "U1", message: "Rotated U1 to 90° on EasyEDA." },
  });
  const res = await result;
  assert.equal(res.isError, undefined);
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.equal(text, "Rotated U1 to 90° on EasyEDA.");
  relay.__resetForTests();
});

test("lock_component tool: locked=true and locked=false both render the platform's verb", async () => {
  // Verifies the boolean argument round-trips correctly, AND that
  // the confirmation message reflects the actual direction.
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const handler = captureToolHandler<{ designator: string; locked: boolean }>(
    buildToolCtx(platform),
    "lock_component"
  );

  // lock=true
  let pending = (async () => handler({ designator: "R1", locked: true }))();
  let cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  assert.deepEqual(cmd.params, { designator: "R1", locked: true });
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: { designator: "R1", message: "Locked R1 on EasyEDA." },
  });
  let res = await pending;
  assert.match((res.content[0] as unknown as { text: string }).text, /^Locked R1/);

  // lock=false
  pending = (async () => handler({ designator: "R1", locked: false }))();
  cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  assert.deepEqual(cmd.params, { designator: "R1", locked: false });
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: { designator: "R1", message: "Unlocked R1 on EasyEDA." },
  });
  res = await pending;
  assert.match((res.content[0] as unknown as { text: string }).text, /^Unlocked R1/);

  relay.__resetForTests();
});

test("rotate_component + lock_component tools: supported:false → tagged error text per tool", async () => {
  // Pin the per-tool error wrapping so the AI client can scan for
  // "Could not move/rotate/lock" to categorize what failed.
  const platform = new AltiumPlatform({
    relay: null,
    nexar: null,
    altiumWorkspaceUrl: null,
  });
  const rotateHandler = captureToolHandler<{ designator: string; rotation: number }>(
    buildToolCtx(platform),
    "rotate_component"
  );
  const lockHandler = captureToolHandler<{ designator: string; locked: boolean }>(
    buildToolCtx(platform),
    "lock_component"
  );
  const rotateRes = await rotateHandler({ designator: "R1", rotation: 0 });
  assert.equal(rotateRes.isError, true);
  assert.match(
    (rotateRes.content[0] as unknown as { text: string }).text,
    /Could not rotate component/
  );
  const lockRes = await lockHandler({ designator: "R1", locked: true });
  assert.equal(lockRes.isError, true);
  assert.match(
    (lockRes.content[0] as unknown as { text: string }).text,
    /Could not change lock state/
  );
});

test("get_components tool: AD relay disconnected → MCP error result with actionable reason", async () => {
  const platform = new AltiumPlatform({
    relay: null,
    nexar: null,
    altiumWorkspaceUrl: null,
  });
  const handler = captureGetComponentsHandler(buildToolCtx(platform));
  const res = await handler({});
  assert.equal(res.isError, true);
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.match(text, /Could not read components/);
  assert.match(text, /relay is not connected/i);
});

test("get_messages tool: all entries below threshold → 'No messages at or above severity X' (distinct from clean state)", async () => {
  // Defense in depth: an info-only result with default filter drops
  // everything. The user should see WHY there's nothing — "below
  // threshold, hidden" — not the same caption as a genuinely
  // clean design.
  const relay = new EdaRelay();
  const platform = new EasyedaPlatform({ relay, workspaceId: "ws-a" });
  const handler = captureGetMessagesHandler(buildToolCtx(platform));

  const result = (async () => handler({}))();
  const cmd = await relay.nextCommand("ws-a", 0);
  if (!cmd) throw new Error("expected queued command");
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: {
      messages: [
        { severity: "info", source: "pcb", message: "x" },
        { severity: "info", source: "pcb", message: "y" },
      ],
    },
  });

  const res = await result;
  assert.equal(res.isError, undefined);
  const text = (res.content[0] as unknown as { text: string }).text;
  assert.match(text, /No messages at or above severity 'warning'/);
  assert.match(text, /2 below-threshold entries hidden/);
  relay.__resetForTests();
});
