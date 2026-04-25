/**
 * Tests for the meter() wrapper. Covers the spec §4.4 contract:
 *   - quota check before fn() runs
 *   - fn() result returned untouched on success
 *   - UsageEvent recorded post-fn (not pre-)
 *   - failed fn() does NOT bill
 *   - retry with same requestId is idempotent (no double-decrement)
 *   - overage-allowed plans bypass the cap
 *   - unlimited (-1) sentinel bypasses the cap entirely
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryQuotaStore } from "./in-memory-store.js";
import { meter, idempotencyKeyFor } from "./meter.js";
import { UNLIMITED } from "./plan-resolver.js";
import {
  QuotaExceeded,
  type MeterContext,
  type RecordUsage,
  type UsageEntry,
} from "./types.js";

const PERIOD = {
  start: new Date("2026-04-01T00:00:00Z"),
  end: new Date("2026-05-01T00:00:00Z"),
};

function ctxWith(overrides: Partial<MeterContext> = {}): MeterContext {
  return {
    orgId: "org-1",
    userId: "user-1",
    requestId: "req-abc",
    plan: {
      name: "starter",
      quotas: { bom_lookup: 5, cost_analysis: 1, export: 1 },
      overageAllowed: false,
    },
    period: PERIOD,
    ...overrides,
  };
}

/**
 * Test recordUsage that emulates the UNIQUE constraint on
 * idempotencyKey: returns true the first time a key is seen, false
 * for repeats.
 */
function makeRecorder(): {
  fn: RecordUsage;
  writes: UsageEntry[];
  seen: Set<string>;
} {
  const writes: UsageEntry[] = [];
  const seen = new Set<string>();
  const fn: RecordUsage = async (entry) => {
    if (seen.has(entry.idempotencyKey)) return false;
    seen.add(entry.idempotencyKey);
    writes.push(entry);
    return true;
  };
  return { fn, writes, seen };
}

test("happy path: returns fn() result, increments counter, writes UsageEvent", async () => {
  const store = new InMemoryQuotaStore();
  const rec = makeRecorder();
  const ctx = ctxWith();

  const out = await meter(
    ctx,
    { tool: "search_parts", metric: "bom_lookup" },
    async () => "result-value",
    { store, recordUsage: rec.fn }
  );

  assert.equal(out, "result-value");
  assert.equal(await store.getUsed(ctx.orgId, "bom_lookup", PERIOD), 1);
  assert.equal(rec.writes.length, 1);
  assert.equal(rec.writes[0]!.tool, "search_parts");
  assert.equal(rec.writes[0]!.metric, "bom_lookup");
  assert.equal(rec.writes[0]!.quantity, 1);
  assert.equal(rec.writes[0]!.userId, "user-1");
});

test("quota check runs before fn(); throws QuotaExceeded without invoking fn", async () => {
  const store = new InMemoryQuotaStore();
  const rec = makeRecorder();
  const ctx = ctxWith();

  // Pre-load 5 of 5 — next call should refuse.
  await store.increment(ctx.orgId, "bom_lookup", 5, PERIOD);

  let fnRan = false;
  await assert.rejects(
    () =>
      meter(
        ctx,
        { tool: "search_parts", metric: "bom_lookup" },
        async () => {
          fnRan = true;
          return "should not run";
        },
        { store, recordUsage: rec.fn }
      ),
    QuotaExceeded
  );
  assert.equal(fnRan, false);
  // Counter unchanged; no UsageEvent.
  assert.equal(await store.getUsed(ctx.orgId, "bom_lookup", PERIOD), 5);
  assert.equal(rec.writes.length, 0);
});

test("QuotaExceeded carries metric/limit/used for the route to surface", async () => {
  const store = new InMemoryQuotaStore();
  const rec = makeRecorder();
  const ctx = ctxWith();
  await store.increment(ctx.orgId, "bom_lookup", 5, PERIOD);

  try {
    await meter(
      ctx,
      { tool: "search_parts", metric: "bom_lookup" },
      async () => "x",
      { store, recordUsage: rec.fn }
    );
    assert.fail("expected QuotaExceeded");
  } catch (err) {
    assert.ok(err instanceof QuotaExceeded);
    assert.equal(err.metric, "bom_lookup");
    assert.equal(err.limit, 5);
    assert.equal(err.used, 5);
  }
});

test("failed fn() does NOT bill — no counter change, no UsageEvent", async () => {
  // The spec wraps fn() so usage is recorded after fn() returns.
  // A throwing fn() should propagate without recording — failed
  // tool calls (e.g. Nexar 502s) don't burn customer quota.
  const store = new InMemoryQuotaStore();
  const rec = makeRecorder();
  const ctx = ctxWith();

  await assert.rejects(
    () =>
      meter(
        ctx,
        { tool: "search_parts", metric: "bom_lookup" },
        async () => {
          throw new Error("upstream fail");
        },
        { store, recordUsage: rec.fn }
      ),
    /upstream fail/
  );
  assert.equal(await store.getUsed(ctx.orgId, "bom_lookup", PERIOD), 0);
  assert.equal(rec.writes.length, 0);
});

test("retry with same requestId is idempotent — single UsageEvent, single counter bump", async () => {
  // SPA / MCP client retries the same request after a transient
  // network blip. Same req.id → same idempotency key → second
  // recordUsage returns false → second increment is skipped.
  const store = new InMemoryQuotaStore();
  const rec = makeRecorder();
  const ctx = ctxWith();

  await meter(
    ctx,
    { tool: "search_parts", metric: "bom_lookup" },
    async () => "first",
    { store, recordUsage: rec.fn }
  );
  await meter(
    ctx,
    { tool: "search_parts", metric: "bom_lookup" },
    async () => "second",
    { store, recordUsage: rec.fn }
  );
  assert.equal(rec.writes.length, 1);
  assert.equal(await store.getUsed(ctx.orgId, "bom_lookup", PERIOD), 1);
});

test("different requestIds for the same tool produce different idempotency keys", async () => {
  const store = new InMemoryQuotaStore();
  const rec = makeRecorder();

  await meter(
    ctxWith({ requestId: "req-a" }),
    { tool: "search_parts", metric: "bom_lookup" },
    async () => "a",
    { store, recordUsage: rec.fn }
  );
  await meter(
    ctxWith({ requestId: "req-b" }),
    { tool: "search_parts", metric: "bom_lookup" },
    async () => "b",
    { store, recordUsage: rec.fn }
  );
  assert.equal(rec.writes.length, 2);
  assert.equal(await store.getUsed("org-1", "bom_lookup", PERIOD), 2);
});

test("overageAllowed plans bypass the cap and still record + increment", async () => {
  // Team / Starter: requests beyond the included allowance succeed
  // and the UsageEvent rows feed the Stripe overage push downstream.
  const store = new InMemoryQuotaStore();
  const rec = makeRecorder();
  const ctx = ctxWith({
    plan: {
      name: "team",
      quotas: { bom_lookup: 1, cost_analysis: 1, export: 1 },
      overageAllowed: true,
    },
  });

  await store.increment(ctx.orgId, "bom_lookup", 5, PERIOD); // already over

  const out = await meter(
    ctx,
    { tool: "search_parts", metric: "bom_lookup" },
    async () => "ok",
    { store, recordUsage: rec.fn }
  );
  assert.equal(out, "ok");
  assert.equal(await store.getUsed(ctx.orgId, "bom_lookup", PERIOD), 6);
  assert.equal(rec.writes.length, 1);
});

test("unlimited (-1) sentinel bypasses the cap regardless of overageAllowed", async () => {
  // Enterprise: limit = -1 means we never check used + units > limit.
  const store = new InMemoryQuotaStore();
  const rec = makeRecorder();
  const ctx = ctxWith({
    plan: {
      name: "enterprise",
      quotas: { bom_lookup: UNLIMITED, cost_analysis: UNLIMITED, export: UNLIMITED },
      overageAllowed: true,
    },
  });

  // Even with a huge pre-loaded count, the call succeeds.
  await store.increment(ctx.orgId, "bom_lookup", 10_000_000, PERIOD);
  const out = await meter(
    ctx,
    { tool: "search_parts", metric: "bom_lookup" },
    async () => "ok",
    { store, recordUsage: rec.fn }
  );
  assert.equal(out, "ok");
});

test("units > 1: quota is checked against used + units, increment matches", async () => {
  // Tools that bill per quantity tier (e.g. analyze_bom_cost) pass
  // units=N. Here we simulate units=3 against a 5-cap.
  const store = new InMemoryQuotaStore();
  const rec = makeRecorder();
  const ctx = ctxWith();

  await store.increment(ctx.orgId, "bom_lookup", 3, PERIOD);
  // 3 + 3 = 6 > 5 → reject.
  await assert.rejects(
    () =>
      meter(
        ctx,
        { tool: "analyze_bom_cost", metric: "bom_lookup", units: 3 },
        async () => "x",
        { store, recordUsage: rec.fn }
      ),
    QuotaExceeded
  );
  // 3 + 2 = 5 → succeeds.
  await meter(
    ctxWith({ requestId: "req-2" }),
    { tool: "analyze_bom_cost", metric: "bom_lookup", units: 2 },
    async () => "ok",
    { store, recordUsage: rec.fn }
  );
  assert.equal(await store.getUsed(ctx.orgId, "bom_lookup", PERIOD), 5);
  assert.equal(rec.writes[0]!.quantity, 2);
});

test("rejects units < 1 as a programmer error", async () => {
  const store = new InMemoryQuotaStore();
  const rec = makeRecorder();
  await assert.rejects(
    () =>
      meter(
        ctxWith(),
        { tool: "search_parts", metric: "bom_lookup", units: 0 },
        async () => "x",
        { store, recordUsage: rec.fn }
      ),
    /units must be >= 1/
  );
});

test("idempotencyKeyFor is deterministic and orgId/tool/requestId-keyed", () => {
  const a = idempotencyKeyFor({ orgId: "o1", tool: "search_parts", requestId: "req-1" });
  const b = idempotencyKeyFor({ orgId: "o1", tool: "search_parts", requestId: "req-1" });
  assert.equal(a, b);
  // Differing inputs produce differing keys.
  assert.notEqual(
    a,
    idempotencyKeyFor({ orgId: "o2", tool: "search_parts", requestId: "req-1" })
  );
  assert.notEqual(
    a,
    idempotencyKeyFor({ orgId: "o1", tool: "check_part_availability", requestId: "req-1" })
  );
  assert.notEqual(
    a,
    idempotencyKeyFor({ orgId: "o1", tool: "search_parts", requestId: "req-2" })
  );
  // Output is hex-only sha256 length.
  assert.match(a, /^[0-9a-f]{64}$/);
});
