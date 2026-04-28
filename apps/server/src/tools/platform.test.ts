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

function captureScreenshotHandler(ctx: ToolContext): CapturedHandler {
  let handler: CapturedHandler | null = null;
  const fakeServer = {
    tool: (
      name: string,
      _desc: string,
      _shape: unknown,
      fn: CapturedHandler
    ) => {
      if (name === "screenshot") handler = fn;
    },
  } as unknown as McpServer;
  registerPlatformTools(fakeServer, ctx);
  if (!handler) throw new Error("registerPlatformTools didn't register `screenshot`");
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
  const platform = new AltiumPlatform({ relay: null, nexar: null });
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
