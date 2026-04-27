/**
 * `EasyedaPlatform` — `Platform` implementation for EasyEDA Pro
 * workspaces.
 *
 * Sprint 10+ replaces stub methods one at a time with real impls
 * that route through `EdaRelay.execute(workspaceId, method, ...)`.
 *
 * Sprint 10 PR 10.1 wires `screenshot()` as the first real method —
 * lays down the architectural pattern for every subsequent
 * cross-platform tool. The other three methods
 * (getActiveProject / runDrc / getMessages) stay stubbed; Sprint 10
 * PRs 10.2–10.5 fill them in using the API methods documented in
 * the PR 9.1 spike report (`eda.dmt_Project.getCurrentProjectInfo()`,
 * `eda.pcb_Drc.check()`, etc.).
 *
 * Sprint 9 PR 9.4a (this PR) introduces the constructor surface:
 * `EasyedaPlatform` now takes an optional `EdaRelay` + `workspaceId`
 * pair. Sprint 9 PR 9.4b adds the HTTP routes that let the extension
 * push commands through the relay; PR 9.4c ships the extension
 * package itself. With both halves landed, Sprint 10's real-impl PRs
 * can call `relay.execute(workspaceId, "screenshot", {})` and resolve
 * the result without further architectural plumbing.
 *
 * The stub methods stay returning `{supported: false}` until each
 * Sprint 10+ PR replaces them — keeping the AI client's contract
 * stable while real impls land incrementally.
 *
 * Why ship a stub at all: every Sprint 10+ tool registers through
 * the `Platform` interface (per cross-platform-validation amendment
 * #50). Without this stub, those PRs would either skip EasyEDA
 * support entirely (violating the rule) or each invent its own
 * `{supported: false}` fallback (violating single-source-of-truth).
 * The stub gives every future PR a consistent target to point its
 * EasyEDA tests at while the real impls land one by one.
 */

import type { EdaRelay } from "../eda-relay/relay.js";
import {
  notSupported,
  ok,
  type ActiveProject,
  type DrcSummary,
  type Platform,
  type PlatformMessage,
  type PlatformResponse,
  type ScreenshotResult,
} from "./types.js";

export interface EasyedaPlatformDeps {
  /**
   * The in-memory broker shared across all EasyEDA-platform requests.
   * Optional today — when null (Sprint 9 PR 9.4a), every method
   * returns `{supported: false}` regardless. PR 9.4b's HTTP routes
   * give the extension a way to feed it; Sprint 10+ PRs replace the
   * stubs with `relay.execute(this.workspaceId, ...)` calls.
   */
  relay: EdaRelay | null;
  /**
   * The workspace whose extension instance this Platform is bound
   * to. Required when `relay` is non-null — the relay's per-
   * workspace state isolation is the security boundary that keeps
   * cross-tenant traffic from mixing.
   */
  workspaceId: string | null;
}

/**
 * Single reason string used by every stub method when neither the
 * relay nor the per-method implementation has landed yet. Sprint 10+
 * PRs replace per-method as the impls arrive, so this constant
 * shrinks in scope over time rather than getting more
 * runtime-state-aware.
 */
const STUB_REASON =
  "EasyEDA support is being wired up. The in-editor extension's request bridge lands in Sprint 9 PR 9.4b; the per-method implementations land in Sprint 10+.";

/**
 * Returned by methods that DO have a real impl when the relay
 * bridge isn't usable for this request. Distinct from STUB_REASON
 * so an AI client can tell "this tool isn't built yet" from "the
 * tool exists, but the extension isn't connected to your workspace
 * right now."
 */
const NO_BRIDGE_REASON =
  "EasyEDA extension is not connected to this workspace. Open EasyEDA Pro with the PCBviber extension installed; the bottom-dock panel should read 'Connected' before tools are usable.";

export class EasyedaPlatform implements Platform {
  readonly name = "easyeda" as const;

  constructor(
    private readonly deps: EasyedaPlatformDeps = {
      relay: null,
      workspaceId: null,
    }
  ) {}

  async getActiveProject(): Promise<PlatformResponse<ActiveProject>> {
    return notSupported(STUB_REASON);
  }

  async screenshot(): Promise<PlatformResponse<ScreenshotResult>> {
    if (!this.deps.relay || !this.deps.workspaceId) {
      // The route layer only constructs an EasyedaPlatform with a
      // relay + workspaceId after the user has bound an API key to
      // an easyeda workspace AND the extension has connected. With
      // either missing, surface the same `{supported: false}` shape
      // every other branch uses so the AI client doesn't see a
      // sometimes-throws-sometimes-typed-fallback contract.
      return notSupported(NO_BRIDGE_REASON);
    }
    try {
      // The extension's `screenshot` handler returns a `{base64Png,
      // byteLength}` payload (or throws via the relay's
      // postResult-failure path). 30s timeout is the relay's
      // default; canvas capture inside the editor is fast (~ms),
      // but a busy editor or slow network can stretch.
      const raw = await this.deps.relay.execute<{
        base64Png?: unknown;
        byteLength?: unknown;
      }>(this.deps.workspaceId, "screenshot", {});
      const base64Png =
        typeof raw?.base64Png === "string" ? raw.base64Png : null;
      const byteLength =
        typeof raw?.byteLength === "number"
          ? raw.byteLength
          : base64Png
            ? Math.floor((base64Png.length * 3) / 4)
            : 0;
      if (!base64Png) {
        // The extension returned an envelope shaped wrong for this
        // tool. Treat as supported:false rather than crashing the
        // tool dispatcher — the AI client's same fallback path
        // applies.
        return notSupported(
          "EasyEDA extension returned a screenshot result without a base64Png field."
        );
      }
      return ok({ base64Png, byteLength });
    } catch (err) {
      return notSupported(
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  async runDrc(): Promise<PlatformResponse<DrcSummary>> {
    return notSupported(STUB_REASON);
  }

  async getMessages(): Promise<PlatformResponse<PlatformMessage[]>> {
    return notSupported(STUB_REASON);
  }
}
