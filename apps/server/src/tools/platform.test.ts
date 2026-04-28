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
