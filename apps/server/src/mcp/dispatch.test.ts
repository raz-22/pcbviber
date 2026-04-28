/**
 * dispatchTool tests — pin the contract between the MCP tool
 * registrations and meter():
 *
 *   - Non-metered tool → calls handler, shapes via toMcpResponse
 *   - Metered tool with metering ctx → goes through meter(); the
 *     UsageEvent is written; the result is returned
 *   - Metered tool, quota exhausted → returns isError: true with a
 *     `quota_exceeded` body that mirrors the REST 429 shape
 *   - Metered tool, no metering ctx (stdio path) → bypasses meter()
 *   - Handler throws → toMcpResponse-style error response
 *
 * Pure-ish tests: stub QuotaStore + RecordUsage, no Prisma, no
 * Fastify. The only collaborators are the meter() function and
 * the metered-tools registry.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryQuotaStore,
  type MeterContext,
  type UsageEntry,
} from "@altium-mcp/metering";
import { dispatchTool, type ToolContext } from "./dispatch.js";
import { EasyedaPlatform } from "../platforms/easyeda.js";

/**
 * Stub platform for dispatch tests — every method returns
 * supported:false. dispatchTool itself doesn't read ctx.platform
 * (that's the platform-tools' concern), so the value is irrelevant
 * to the dispatch contract; it just needs to satisfy the type.
 */
const STUB_PLATFORM = new EasyedaPlatform();
import type { NexarService } from "../services/nexar.js";

// We don't need a real NexarService — the dispatch layer just
// passes ctx around. Cast a stub.
const STUB_NEXAR = {} as unknown as NexarService;

const PERIOD = {
  start: new Date("2099-04-01T00:00:00Z"),
  end: new Date("2099-05-01T00:00:00Z"),
};

function makeMeterCtx(overrides: Partial<MeterContext> = {}): MeterContext {
  return {
    orgId: "org-test",
    userId: null,
    requestId: "req-test-1",
    plan: {
      name: "team",
      quotas: { bom_lookup: 5, cost_analysis: 5, export: 5 },
      overageAllowed: false,
    },
    period: PERIOD,
    ...overrides,
  };
}

function makeUsageRecorder() {
  const writes: UsageEntry[] = [];
  const seen = new Set<string>();
  return {
    fn: async (entry: UsageEntry) => {
      if (seen.has(entry.idempotencyKey)) return false;
      seen.add(entry.idempotencyKey);
      writes.push(entry);
      return true;
    },
    writes,
  };
}

test("non-metered tool runs handler and returns a normal MCP response", async () => {
  const recorder = makeUsageRecorder();
  const ctx: ToolContext = {
    nexar: STUB_NEXAR,
    platform: STUB_PLATFORM,
    metering: {
      meterCtx: makeMeterCtx(),
      store: new InMemoryQuotaStore(),
      recordUsage: recorder.fn,
    },
  };

  let handlerRan = false;
  const result = await dispatchTool("list_workspaces", ctx, async () => {
    handlerRan = true;
    return [{ id: "ws_a365", name: "Acme" }];
  });

  assert.equal(handlerRan, true);
  assert.equal(result.isError, undefined);
  assert.equal(result.content.length, 1);
  // Non-metered tools never touch recordUsage.
  assert.equal(recorder.writes.length, 0);
});

test("metered tool: runs through meter(), records UsageEvent, returns result", async () => {
  const recorder = makeUsageRecorder();
  const store = new InMemoryQuotaStore();
  const ctx: ToolContext = {
    nexar: STUB_NEXAR,
    platform: STUB_PLATFORM,
    metering: {
      meterCtx: makeMeterCtx(),
      store,
      recordUsage: recorder.fn,
    },
  };

  const result = await dispatchTool("search_parts", ctx, async () => [
    { mpn: "STM32F407" },
  ]);

  assert.equal(result.isError, undefined);
  // UsageEvent written, with the right metric + tool name.
  assert.equal(recorder.writes.length, 1);
  assert.equal(recorder.writes[0]!.tool, "search_parts");
  assert.equal(recorder.writes[0]!.metric, "bom_lookup");
  assert.equal(recorder.writes[0]!.quantity, 1);
  // Counter incremented in the store.
  assert.equal(await store.getUsed("org-test", "bom_lookup", PERIOD), 1);
});

test("metered tool over quota: returns isError + quota_exceeded body", async () => {
  const recorder = makeUsageRecorder();
  const store = new InMemoryQuotaStore();
  // Pre-load to the cap (5) so the next call exceeds.
  await store.setExact("org-test", "bom_lookup", 5, PERIOD);

  const ctx: ToolContext = {
    nexar: STUB_NEXAR,
    platform: STUB_PLATFORM,
    metering: {
      meterCtx: makeMeterCtx(),
      store,
      recordUsage: recorder.fn,
    },
  };

  let handlerRan = false;
  const result = await dispatchTool("search_parts", ctx, async () => {
    handlerRan = true;
    return [];
  });

  assert.equal(result.isError, true);
  assert.equal(handlerRan, false, "handler must not run when quota is exhausted");
  // Body is JSON the agent / SPA can parse.
  const body = JSON.parse(result.content[0]!.text);
  assert.equal(body.error, "quota_exceeded");
  assert.equal(body.metric, "bom_lookup");
  assert.equal(body.limit, 5);
  assert.equal(body.used, 5);
  // No UsageEvent written when the call was rejected.
  assert.equal(recorder.writes.length, 0);
});

test("metered tool, no metering ctx (stdio): handler runs, no recording", async () => {
  // Stdio path constructs ToolContext with metering: null. Same
  // codepath the dispatch layer uses for non-metered tools.
  const ctx: ToolContext = { nexar: STUB_NEXAR, platform: STUB_PLATFORM, metering: null };

  const result = await dispatchTool("search_parts", ctx, async () => [
    { mpn: "STM32F407" },
  ]);

  assert.equal(result.isError, undefined);
  // The result body is the JSON-serialized handler return.
  const body = JSON.parse(result.content[0]!.text);
  assert.equal(body[0].mpn, "STM32F407");
});

test("metered tool: handler throws non-quota error → isError + Error: message", async () => {
  // Same shape as toMcpResponse's existing catch — failed Nexar
  // calls return isError: true with the error message in text.
  const recorder = makeUsageRecorder();
  const ctx: ToolContext = {
    nexar: STUB_NEXAR,
    platform: STUB_PLATFORM,
    metering: {
      meterCtx: makeMeterCtx(),
      store: new InMemoryQuotaStore(),
      recordUsage: recorder.fn,
    },
  };

  const result = await dispatchTool("search_parts", ctx, async () => {
    throw new Error("nexar 502");
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /nexar 502/);
  // Failed handler does NOT bill — meter() returns before recordUsage.
  assert.equal(recorder.writes.length, 0);
});

test("metered tool with overage allowed: passes the cap, still records", async () => {
  // Team / Starter plans allow overage. dispatchTool should NOT
  // refuse the call; it should record the UsageEvent for the
  // hourly Stripe push.
  const recorder = makeUsageRecorder();
  const store = new InMemoryQuotaStore();
  await store.setExact("org-test", "bom_lookup", 100, PERIOD);

  const ctx: ToolContext = {
    nexar: STUB_NEXAR,
    platform: STUB_PLATFORM,
    metering: {
      meterCtx: makeMeterCtx({
        plan: {
          name: "team",
          quotas: { bom_lookup: 5, cost_analysis: 5, export: 5 },
          overageAllowed: true,
        },
      }),
      store,
      recordUsage: recorder.fn,
    },
  };

  const result = await dispatchTool("search_parts", ctx, async () => ["ok"]);
  assert.equal(result.isError, undefined);
  assert.equal(recorder.writes.length, 1);
});

test("export tool maps to the export metric", async () => {
  // Pin the registry plumbing: a different tool name resolves
  // to the right metric and the UsageEvent reflects it.
  const recorder = makeUsageRecorder();
  const store = new InMemoryQuotaStore();
  const ctx: ToolContext = {
    nexar: STUB_NEXAR,
    platform: STUB_PLATFORM,
    metering: {
      meterCtx: makeMeterCtx(),
      store,
      recordUsage: recorder.fn,
    },
  };

  await dispatchTool("export_manufacturing_data", ctx, async () => ({
    jobId: "job_x",
  }));
  assert.equal(recorder.writes.length, 1);
  assert.equal(recorder.writes[0]!.metric, "export");
});
