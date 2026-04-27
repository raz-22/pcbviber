/**
 * EdaRelay broker tests — Sprint 9 PR 9.4a.
 *
 * Pins the per-workspace state isolation that makes the EasyEDA relay
 * different from the AD relay (single-instance) — and the request /
 * response lifecycle invariants every Sprint 10+ tool will rely on.
 *
 * Five behaviors covered:
 *   1. enqueue then immediate poll round-trips fast (head-of-queue)
 *   2. long-poll resolves when a command lands AFTER the poll started
 *   3. timeout rejects the promise + cleans the queue (no leak)
 *   4. cross-workspace isolation: a command on ws-a doesn't surface to
 *      a poller on ws-b. The single biggest reason this relay is
 *      per-workspace, so it gets a hard pin here.
 *   5. postResult routes the response back to the right pending
 *      Promise, success and failure paths
 *
 * No timers run unmocked — every test that needs to advance time uses
 * a tight pollTimeoutMs / timeoutMs so the suite finishes in <100ms.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EdaRelay, type EdaCommandEnvelope } from "./relay.js";

// ─── Round-trip ───────────────────────────────────────────────────────

test("execute + nextCommand: command queued before poll is delivered immediately", async () => {
  const relay = new EdaRelay();
  const pending = relay.execute("ws-a", "screenshot", {}, 1_000);

  const cmd = await relay.nextCommand("ws-a", 0);
  assert.ok(cmd, "next short-poll should return the queued command");
  assert.equal(cmd.method, "screenshot");

  // Don't actually post a result here — just check shape. The
  // pending promise will resolve in a later test scenario; we
  // detach this one with a result post to avoid timeout-cascade.
  relay.postResult("ws-a", { id: cmd.id, ok: true, result: "stub-png" });
  const resolved = await pending;
  assert.equal(resolved, "stub-png");
});

test("execute + nextCommand: command landing after poll-start is delivered to the long-poll", async () => {
  const relay = new EdaRelay();
  // Long-poll first — nothing in queue, will hold open.
  const pollPromise = relay.nextCommand("ws-a", 500);

  // Fire the command 5ms later so the poll is genuinely waiting.
  // Capture the pending promise so we can settle it before the test
  // ends — otherwise it leaks an unhandled timeout 1s later.
  let pending!: Promise<unknown>;
  setTimeout(() => {
    pending = relay.execute("ws-a", "get_active_project", {}, 1_000);
  }, 5);

  const cmd = await pollPromise;
  assert.ok(cmd, "long-poll should resolve with the late-arriving command");
  assert.equal(cmd.method, "get_active_project");

  // Detach: post a result so the pending promise resolves cleanly.
  relay.postResult("ws-a", { id: cmd.id, ok: true, result: null });
  await pending;
});

// ─── Timeouts ─────────────────────────────────────────────────────────

test("execute: rejects + cleans state when timeoutMs elapses with no result", async () => {
  const relay = new EdaRelay();
  // 30ms timeout — short enough to keep the test fast, long enough
  // that timer scheduling overhead doesn't steal the deadline.
  const pending = relay.execute("ws-a", "run_drc", {}, 30);

  // Drain the command via short-poll so it's "in flight" (would-be
  // dispatched to an extension). The command id moves out of queue
  // and into pending; timeout still fires at 30ms.
  await relay.nextCommand("ws-a", 0);

  await assert.rejects(pending, /timeout after 30ms/);

  // After the rejection, the per-workspace status should show 0
  // queued + 0 in-flight (the timeout cleaner removed both).
  const status = relay.status("ws-a");
  assert.equal(status.queued, 0);
  assert.equal(status.inFlight, 0);
  assert.equal(status.totals.errored, 1);
});

// ─── Cross-workspace isolation ────────────────────────────────────────

test("nextCommand on ws-b does NOT see a command queued on ws-a", async () => {
  // The single most important invariant of EdaRelay vs AdRelay.
  // If this regressed, a tenant's tool calls could leak to another
  // tenant's extension session. Anything else here can be debug-
  // friction; this one is a security boundary.
  const relay = new EdaRelay();

  // Queue a command on ws-a.
  const aPending = relay.execute("ws-a", "screenshot", {}, 1_000);

  // ws-b polls — must NOT receive ws-a's command.
  const bResult = await relay.nextCommand("ws-b", 0);
  assert.equal(
    bResult,
    null,
    "ws-b's queue must be empty even though ws-a has a queued command"
  );

  // ws-a polls — gets its own command, as expected.
  const aResult = await relay.nextCommand("ws-a", 0);
  assert.ok(aResult);
  assert.equal(aResult?.method, "screenshot");

  // Detach the pending promise.
  relay.postResult("ws-a", { id: aResult.id, ok: true, result: null });
  await aPending;
});

test("status: per-workspace counters stay isolated", async () => {
  const relay = new EdaRelay();
  // ws-a: one execute that times out -> errored count 1
  const aPending = relay.execute("ws-a", "run_drc", {}, 20);
  await assert.rejects(aPending);

  // ws-b: one successful round-trip -> resolved count 1
  const bPending = relay.execute("ws-b", "get_messages", {}, 1_000);
  const bCmd = await relay.nextCommand("ws-b", 0);
  assert.ok(bCmd);
  relay.postResult("ws-b", { id: bCmd.id, ok: true, result: [] });
  await bPending;

  const a = relay.status("ws-a");
  const b = relay.status("ws-b");
  assert.equal(a.totals.errored, 1);
  assert.equal(a.totals.resolved, 0);
  assert.equal(b.totals.errored, 0);
  assert.equal(b.totals.resolved, 1);
});

// ─── postResult success + failure paths ───────────────────────────────

test("postResult success path resolves the pending promise with the result payload", async () => {
  const relay = new EdaRelay();
  const pending = relay.execute("ws-a", "get_active_project", {}, 1_000);
  const cmd = (await relay.nextCommand("ws-a", 0)) as EdaCommandEnvelope;
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: true,
    result: { id: "proj-1", name: "Acme PSU" },
  });
  const resolved = await pending;
  assert.deepEqual(resolved, { id: "proj-1", name: "Acme PSU" });
});

test("postResult failure path rejects the pending promise with the extension's error message", async () => {
  const relay = new EdaRelay();
  const pending = relay.execute("ws-a", "run_drc", {}, 1_000);
  const cmd = (await relay.nextCommand("ws-a", 0)) as EdaCommandEnvelope;
  relay.postResult("ws-a", {
    id: cmd.id,
    ok: false,
    error: { message: "DRC engine returned no output", code: "drc_no_output" },
  });
  await assert.rejects(pending, /DRC engine returned no output/);
});

test("postResult on an unknown id returns accepted:false (no panic)", () => {
  const relay = new EdaRelay();
  const outcome = relay.postResult("ws-a", {
    id: "never-dispatched",
    ok: true,
    result: null,
  });
  assert.equal(outcome.accepted, false);
  assert.match(
    outcome.reason ?? "",
    /unknown id/,
    "reason should explain why the result was rejected"
  );
});
