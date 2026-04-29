/**
 * EdaRelay — in-memory broker between PCBviber server and the
 * PCBviber EasyEDA Pro extension.
 *
 * Mirror of `AdRelay` (`apps/server/src/ad-relay/relay.ts`) with one
 * critical difference: **per-workspace state**. AD lives on a single
 * machine alongside the server and the relay is global; EasyEDA runs
 * in N customer browsers across the public internet, each polling
 * for commands targeting a specific workspace. Each workspace gets
 * its own queue / pending / waiters so cross-tenant traffic can't
 * mix.
 *
 * Flow (per workspace):
 *   tool   ─ enqueue(workspaceId, ...) ─►  EdaRelay  ◄─ long-poll ─  EasyEDA extension
 *      (awaits promise)                    ─ dispatch ─►
 *                                          ◄─ result POST ──────────
 *   tool ◄─ resolve ─────
 *
 * Routes that wire the extension's HTTP calls to this broker land in
 * Sprint 9 PR 9.4b (`apps/server/src/eda-relay/routes.ts`). The
 * extension package itself lands in PR 9.4c (`eda-script/`). This
 * PR (9.4a) is the broker primitive — no I/O, fully unit-testable.
 *
 * Sprint 10+ adds methods to the `Platform` interface that call into
 * this relay via `EasyedaPlatform`. Today the platform's stub returns
 * `{supported: false}` for everything; PR 9.4b's routes + PR 9.4c's
 * extension are needed before any real call can complete.
 */

import { randomUUID } from "node:crypto";

/**
 * Method names mirror the EasyEDA Pro Extension API surface. The set
 * here grows as Sprint 10+ adds cross-platform tools — keeping it as
 * a string union (rather than an unbounded `string`) means the
 * compiler catches typos in `relay.execute("get_componenets", ...)`
 * before they ship.
 */
export type EdaMethod =
  | "screenshot"
  | "get_active_project"
  | "list_projects"
  | "list_schematic_components"
  | "list_pcb_components"
  | "list_library_components"
  | "get_components"
  | "move_component"
  | "rotate_component"
  | "lock_component"
  | "get_keepouts"
  | "get_net_routing"
  | "get_design_rules"
  | "set_route_rule"
  | "unroute_net"
  | "run_drc"
  | "get_messages";

export interface EdaCommandEnvelope {
  id: string;
  method: EdaMethod;
  params: Record<string, unknown>;
  timeoutMs: number;
}

export interface EdaResultEnvelope {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { message: string; code?: string; detail?: string };
}

interface PendingCommand {
  envelope: EdaCommandEnvelope;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface Waiter {
  resolve: (envelope: EdaCommandEnvelope | null) => void;
  timer: NodeJS.Timeout;
}

/**
 * Per-workspace broker state. Each workspace gets its own bucket so
 * a slow extension on one workspace can't starve another's queue.
 */
interface WorkspaceState {
  queue: EdaCommandEnvelope[];
  pending: Map<string, PendingCommand>;
  waiters: Waiter[];
  lastPollAt: number;
  totalDispatched: number;
  totalResolved: number;
  totalErrored: number;
}

export interface EdaRelayWorkspaceStatus {
  queued: number;
  inFlight: number;
  pollersWaiting: number;
  /** True iff a poll has happened in the last 60 seconds. */
  connected: boolean;
  lastPollAt: string | null;
  totals: {
    dispatched: number;
    resolved: number;
    errored: number;
  };
}

export class EdaRelay {
  private workspaces = new Map<string, WorkspaceState>();

  /**
   * Tool handler entry point. Enqueues a command targeting `workspaceId`
   * and returns a Promise that resolves when the matching extension
   * posts the result back, or rejects on timeout.
   */
  execute<T>(
    workspaceId: string,
    method: EdaMethod,
    params: Record<string, unknown>,
    timeoutMs = 30_000
  ): Promise<T> {
    const state = this.stateFor(workspaceId);
    const envelope: EdaCommandEnvelope = {
      id: randomUUID(),
      method,
      params,
      timeoutMs,
    };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        state.pending.delete(envelope.id);
        const qi = state.queue.findIndex((c) => c.id === envelope.id);
        if (qi >= 0) state.queue.splice(qi, 1);
        state.totalErrored++;
        reject(
          new Error(
            `EasyEDA relay timeout after ${timeoutMs}ms waiting for ` +
              `'${method}' (workspace=${workspaceId}, id=${envelope.id}). ` +
              `Is the PCBviber EasyEDA extension running and connected?`
          )
        );
      }, timeoutMs);

      state.pending.set(envelope.id, {
        envelope,
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });

      // Hand off to a waiting poller if one exists; else queue.
      const waiter = state.waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        state.totalDispatched++;
        waiter.resolve(envelope);
      } else {
        state.queue.push(envelope);
      }
    });
  }

  /**
   * Extension calls this to ask for the next command. Returns
   * immediately if the queue has one; otherwise long-polls up to
   * `pollTimeoutMs`. `pollTimeoutMs<=0` returns null right away
   * (short-poll, used by tests + when the extension wants to
   * heartbeat without holding a request open).
   */
  async nextCommand(
    workspaceId: string,
    pollTimeoutMs = 0
  ): Promise<EdaCommandEnvelope | null> {
    const state = this.stateFor(workspaceId);
    state.lastPollAt = Date.now();

    const head = state.queue.shift();
    if (head) {
      state.totalDispatched++;
      return head;
    }

    if (pollTimeoutMs <= 0) return null;

    return new Promise<EdaCommandEnvelope | null>((resolve) => {
      const timer = setTimeout(() => {
        const idx = state.waiters.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) state.waiters.splice(idx, 1);
        resolve(null);
      }, pollTimeoutMs);
      state.waiters.push({ resolve, timer });
    });
  }

  /**
   * Extension posts a result back. Resolves the pending Promise for
   * the corresponding command id (or rejects, if the extension
   * reported failure).
   */
  postResult(
    workspaceId: string,
    envelope: EdaResultEnvelope
  ): { accepted: boolean; reason?: string } {
    const state = this.stateFor(workspaceId);
    const pending = state.pending.get(envelope.id);
    if (!pending) {
      return {
        accepted: false,
        reason: "unknown id (timed out or never dispatched)",
      };
    }
    state.pending.delete(envelope.id);
    clearTimeout(pending.timer);

    if (envelope.ok) {
      state.totalResolved++;
      pending.resolve(envelope.result);
    } else {
      state.totalErrored++;
      const msg = envelope.error?.message ?? "EasyEDA extension reported failure";
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

  /** Diagnostic snapshot for `/api/eda-relay/status` (PR 9.4b). */
  status(workspaceId: string): EdaRelayWorkspaceStatus {
    const state = this.workspaces.get(workspaceId);
    if (!state) {
      return {
        queued: 0,
        inFlight: 0,
        pollersWaiting: 0,
        connected: false,
        lastPollAt: null,
        totals: { dispatched: 0, resolved: 0, errored: 0 },
      };
    }
    return {
      queued: state.queue.length,
      inFlight: state.pending.size,
      pollersWaiting: state.waiters.length,
      connected:
        state.lastPollAt > 0 && Date.now() - state.lastPollAt < 60_000,
      lastPollAt: state.lastPollAt
        ? new Date(state.lastPollAt).toISOString()
        : null,
      totals: {
        dispatched: state.totalDispatched,
        resolved: state.totalResolved,
        errored: state.totalErrored,
      },
    };
  }

  /**
   * Test helper. Drops all per-workspace state — pending Promises stay
   * un-resolved; their timeouts will eventually fire. Tests use this
   * between cases to keep state clean without recreating the relay.
   */
  __resetForTests(): void {
    for (const state of this.workspaces.values()) {
      for (const w of state.waiters) clearTimeout(w.timer);
      for (const p of state.pending.values()) clearTimeout(p.timer);
    }
    this.workspaces.clear();
  }

  private stateFor(workspaceId: string): WorkspaceState {
    let state = this.workspaces.get(workspaceId);
    if (!state) {
      state = {
        queue: [],
        pending: new Map(),
        waiters: [],
        lastPollAt: 0,
        totalDispatched: 0,
        totalResolved: 0,
        totalErrored: 0,
      };
      this.workspaces.set(workspaceId, state);
    }
    return state;
  }
}
