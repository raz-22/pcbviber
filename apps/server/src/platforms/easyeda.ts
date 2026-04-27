/**
 * `EasyedaPlatform` — `Platform` implementation for EasyEDA Pro
 * workspaces.
 *
 * STUB. Every method still returns `{supported: false}`. Sprint 10+
 * fills in the per-method real implementations using the API methods
 * documented in the PR 9.1 spike report (`eda.dmt_Project.getCurrentProjectInfo()`,
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

export class EasyedaPlatform implements Platform {
  readonly name = "easyeda" as const;

  // deps is consumed by Sprint 10+ when stubs become real impls;
  // accept it now so the constructor signature is stable.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- forward-compat
  constructor(_deps: EasyedaPlatformDeps = { relay: null, workspaceId: null }) {}

  async getActiveProject(): Promise<PlatformResponse<ActiveProject>> {
    return notSupported(STUB_REASON);
  }

  async screenshot(): Promise<PlatformResponse<ScreenshotResult>> {
    return notSupported(STUB_REASON);
  }

  async runDrc(): Promise<PlatformResponse<DrcSummary>> {
    return notSupported(STUB_REASON);
  }

  async getMessages(): Promise<PlatformResponse<PlatformMessage[]>> {
    return notSupported(STUB_REASON);
  }
}
