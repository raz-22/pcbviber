/**
 * AdRelay — in-memory broker between MCP tool calls and Altium Designer.
 *
 * Flow:
 *   MCP tool  ─ enqueue ─►  AdRelay  ◄─ long-poll ─  AD script (AltiumRelay.js)
 *          (awaits promise)          ─ dispatch ─►
 *                          ◄─ result POST ──────────
 *   MCP tool ◄─ resolve ──
 *
 * Single-AD-instance assumption: one active poller at a time. If multiple
 * AD instances poll, they'll race for commands — acceptable for v1.
 */

import { randomUUID } from "node:crypto";
import type {
  AdCommandEnvelope,
  AdMethod,
  AdResultEnvelope,
} from "@altium-mcp/shared";

interface PendingCommand {
  envelope: AdCommandEnvelope;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface Waiter {
  resolve: (envelope: AdCommandEnvelope | null) => void;
  timer: NodeJS.Timeout;
}

export class AdRelay {
  /** Commands awaiting dispatch to an AD poller. */
  private queue: AdCommandEnvelope[] = [];
  /** Commands dispatched to AD, awaiting result POST. */
  private pending = new Map<string, PendingCommand>();
  /** Long-polling AD clients waiting for a command. */
  private waiters: Waiter[] = [];
  /** Connection/heartbeat tracking for /ad-relay/status. */
  private lastPollAt: number = 0;
  private totalDispatched = 0;
  private totalResolved = 0;
  private totalErrored = 0;

  /**
   * Called by an MCP tool handler. Enqueues the command and returns a
   * Promise that resolves with the result AD posts back (or rejects on
   * timeout / AD error).
   */
  execute<T>(
    method: AdMethod,
    params: Record<string, unknown>,
    timeoutMs = 30_000
  ): Promise<T> {
    const envelope: AdCommandEnvelope = {
      id: randomUUID(),
      method,
      params,
      timeoutMs,
    };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(envelope.id);
        // Also remove from queue if still waiting to be dispatched.
        const qi = this.queue.findIndex((c) => c.id === envelope.id);
        if (qi >= 0) this.queue.splice(qi, 1);
        this.totalErrored++;
        reject(
          new Error(
            `AD relay timeout after ${timeoutMs}ms waiting for '${method}' (id=${envelope.id}). ` +
              `Is AltiumRelay.js running inside Altium Designer?`
          )
        );
      }, timeoutMs);

      this.pending.set(envelope.id, {
        envelope,
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });

      // Deliver to a waiting poller if one exists; else queue.
      const waiter = this.waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        this.totalDispatched++;
        waiter.resolve(envelope);
      } else {
        this.queue.push(envelope);
      }
    });
  }

  /**
   * Called by GET /ad-relay/next. Returns a pending command immediately
   * if one is queued; otherwise:
   *   - pollTimeoutMs <= 0: resolves null right away (AD-style short poll)
   *   - pollTimeoutMs > 0: waits up to that many ms (classic long-poll)
   */
  async nextCommand(pollTimeoutMs = 0): Promise<AdCommandEnvelope | null> {
    this.lastPollAt = Date.now();

    const head = this.queue.shift();
    if (head) {
      this.totalDispatched++;
      return head;
    }

    if (pollTimeoutMs <= 0) return null;

    return new Promise<AdCommandEnvelope | null>((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) this.waiters.splice(idx, 1);
        resolve(null);
      }, pollTimeoutMs);
      this.waiters.push({ resolve, timer });
    });
  }

  /**
   * Called by POST /ad-relay/result. Resolves the pending Promise for
   * this command id.
   */
  postResult(envelope: AdResultEnvelope): { accepted: boolean; reason?: string } {
    const pending = this.pending.get(envelope.id);
    if (!pending) {
      return { accepted: false, reason: "unknown id (timed out or never dispatched)" };
    }
    this.pending.delete(envelope.id);
    clearTimeout(pending.timer);

    if (envelope.ok) {
      this.totalResolved++;
      pending.resolve(envelope.result);
    } else {
      this.totalErrored++;
      const msg = envelope.error?.message ?? "AD reported failure";
      const err = new Error(msg);
      if (envelope.error?.detail) {
        (err as Error & { detail?: string }).detail = envelope.error.detail;
      }
      if (envelope.error?.code) {
        (err as Error & { code?: string }).code = envelope.error.code;
      }
      pending.reject(err);
    }
    return { accepted: true };
  }

  status() {
    return {
      queued: this.queue.length,
      inFlight: this.pending.size,
      pollersWaiting: this.waiters.length,
      connected: this.lastPollAt > 0 && Date.now() - this.lastPollAt < 60_000,
      lastPollAt: this.lastPollAt ? new Date(this.lastPollAt).toISOString() : null,
      totals: {
        dispatched: this.totalDispatched,
        resolved: this.totalResolved,
        errored: this.totalErrored,
      },
    };
  }
}
