/**
 * `EasyedaPlatform` — `Platform` implementation for EasyEDA Pro
 * workspaces.
 *
 * STUB. Sprint 9 PR 9.3 lands this returning `{supported: false}` for
 * every method, with a uniform "coming in PR 9.4+" reason. Sprint 9 PR
 * 9.4 wires the in-editor extension's WebSocket bridge (`EdaRelay`,
 * sibling to `AdRelay`); Sprint 10 fills in the real implementations
 * for each method using `eda.dmt_Project.getCurrentProjectInfo()`,
 * `eda.pcb_Drc.check()`, etc., per the PR 9.1 spike report.
 *
 * Why ship a stub now: every Sprint 10+ tool registers through the
 * `Platform` interface (per cross-platform-validation amendment #50).
 * Without this stub, those PRs would either skip EasyEDA support
 * entirely (violating the rule) or each invent its own
 * `{supported: false}` fallback (violating the single-source-of-truth
 * principle). The stub gives every future PR a consistent target to
 * point its EasyEDA tests at while the real bridge lands.
 */

import {
  notSupported,
  type ActiveProject,
  type DrcSummary,
  type Platform,
  type PlatformMessage,
  type PlatformResponse,
  type ScreenshotResult,
} from "./types.js";

/**
 * Single reason string used by every stub method. Centralized so the
 * upgrade in PR 9.4+ flips one constant from "stub" to "no extension
 * connected" or similar runtime-state-aware message.
 */
const STUB_REASON =
  "EasyEDA support is being wired up. The in-editor extension bridge lands in Sprint 9 PR 9.4; the per-method implementations land in Sprint 10+.";

export class EasyedaPlatform implements Platform {
  readonly name = "easyeda" as const;

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
