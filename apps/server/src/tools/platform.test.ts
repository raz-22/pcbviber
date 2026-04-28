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
