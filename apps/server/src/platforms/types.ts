/**
 * `Platform` — cross-platform abstraction over EDA tools.
 *
 * Sprint 9 PR 9.3. Per the post-amendment roadmap (#50), every tool
 * that touches a concept any EDA platform has — projects, components,
 * placement, routing, verification, manufacturing — must be registered
 * cross-platform. The `Platform` interface is the abstraction every
 * Sprint 10+ tool registers through. Adding a new EDA in a future
 * sprint means writing a new `XPlatform implements Platform` class;
 * the tool registrations don't change.
 *
 * ## Why an interface, not a discriminated union?
 *
 * Two reasons. First, the methods we'll add have heterogeneous arg
 * shapes (move-component takes coordinates; screenshot takes nothing;
 * run-drc takes a strictness flag). A discriminated union forces every
 * call site to switch on platform; an interface lets the compiler check
 * each call's arg shape against a single signature. Second, future
 * platforms (KiCad, Eagle) extend the surface naturally — implement
 * the interface, the existing call sites work unchanged.
 *
 * ## The `PlatformResponse` contract
 *
 * Every method returns `PlatformResponse<T>`: either `{supported: true,
 * data: T}` or `{supported: false, reason: string}`. The motivation
 * comes from xSignals — Altium has a length-tuning concept; EasyEDA
 * doesn't. Forcing every method to throw on the unsupported case
 * would force every tool registration to wrap calls in try/catch.
 * Instead, the AI client gets a typed signal it can reason about:
 * "this tool isn't supported here, here's why" — and degrades
 * gracefully without surfacing an error.
 *
 * ## Scope of THIS PR
 *
 * 4 methods declared:
 *   - getActiveProject — Altium has a real impl (via AD relay);
 *     EasyEDA returns `{supported: false}` until Sprint 9 PR 9.4
 *     wires the EasyEDA extension bridge.
 *   - screenshot — same shape.
 *   - runDrc — same shape.
 *   - getMessages — same shape.
 *
 * The interface grows in Sprint 10+ as each PR adds a new
 * cross-platform tool. The `screenshot` and `getActiveProject`
 * methods exist today as `ad_screenshot` and `ad_get_active_project`
 * — those legacy registrations stay as direct AdRelay adapters until
 * Sprint 10 PR 10.x replaces them with `screenshot(platform)` and
 * `get_active_project(platform)` going through this interface.
 */

/**
 * Discriminated union returned by every Platform method. The `data`
 * field on the success branch holds whatever the method's return
 * type is; on the failure branch, `reason` is one human-readable
 * sentence the AI client / SPA can surface.
 */
export type PlatformResponse<T> =
  | { supported: true; data: T }
  | { supported: false; reason: string };

/** Convenience helpers for callers — narrow the union without explicit type guards. */
export function ok<T>(data: T): PlatformResponse<T> {
  return { supported: true, data };
}

export function notSupported<T>(reason: string): PlatformResponse<T> {
  return { supported: false, reason };
}

/**
 * Active project metadata. Concrete shape will be tightened as
 * Sprint 10+ tools settle on what fields they need across platforms.
 * Today this is the lowest-common-denominator: a name + an id.
 *
 * Altium today returns a richer payload from `adGetActiveProject`
 * (path, loaded documents, active document). EasyEDA's
 * `dmt_Project.getCurrentProjectInfo()` returns its own richer
 * shape. Sprint 10 PR 10.2 normalizes these.
 */
export interface ActiveProject {
  id: string;
  name: string;
  /** Platform-specific raw payload, kept for tools that need it. */
  raw: unknown;
}

/**
 * Screenshot return shape. Base64-encoded PNG so it round-trips
 * through MCP's text-only tool result format. Size is informational.
 */
export interface ScreenshotResult {
  base64Png: string;
  byteLength: number;
}

/**
 * DRC run summary. Sprint 13 will widen this with a structured
 * violations array (the EasyEDA Pro extension API supports
 * `pcb_Drc.check(verbose=true)` returning an array; Altium's
 * Messages-panel parsing produces the same shape). For Sprint 9
 * the return is just a pass/fail summary — matches the existing
 * `ad_run_drc` behavior.
 */
export interface DrcSummary {
  ok: boolean;
  /** Platform-specific raw payload from the DRC engine. */
  raw: unknown;
}

/**
 * One entry returned by `listProjects()`. Cross-platform shape;
 * the platform-specific blob lives in `raw` for tools that need
 * fields beyond id + name. Altium: Nexar's `AltiumProject`;
 * EasyEDA: the `IDMT_BriefProjectItem` returned by
 * `eda.dmt_Project.getProjectInfo()`.
 */
export interface ProjectListEntry {
  id: string;
  name: string;
  raw: unknown;
}

/**
 * One entry from the platform's messages panel — DRC violations,
 * ERC errors, compile warnings. Filtering by severity / source is
 * the caller's job.
 */
export interface PlatformMessage {
  severity: "info" | "warning" | "error" | "unknown";
  source: string;
  text: string;
  document?: string;
}

/**
 * The cross-platform abstraction. Every Sprint 10+ tool registers
 * through one of these methods. Concrete platforms are constructed
 * per-request; they hold whatever per-workspace state they need
 * (Altium: NexarService + AdRelay handle; EasyEDA: EdaRelay handle
 * once Sprint 9 PR 9.4 lands).
 */
export interface Platform {
  /** Stable, human-readable name. Logged in audit + Sentry tags. */
  readonly name: "altium" | "easyeda";

  /**
   * Read the user's currently-active project on this platform.
   * Altium: via AD relay if connected, else via Altium 365 cloud.
   * EasyEDA: via the in-editor extension's
   * `eda.dmt_Project.getCurrentProjectInfo()`.
   */
  getActiveProject(): Promise<PlatformResponse<ActiveProject>>;

  /**
   * List every project the platform exposes for this workspace.
   * Altium: Nexar's `desProjects(workspaceUrl)` (requires the
   * workspace's Altium 365 URL be configured — returns
   * supported:false otherwise).
   * EasyEDA: the in-editor extension's
   * `eda.dmt_Project.getAllProjectsUuid()` + per-uuid
   * `getProjectInfo()`.
   */
  listProjects(): Promise<PlatformResponse<ProjectListEntry[]>>;

  /**
   * Capture a PNG screenshot of the platform's editor view.
   * Altium: PowerShell-driven local screenshot of the AD window.
   * EasyEDA: extension API canvas capture (Sprint 9 PR 9.4+).
   */
  screenshot(): Promise<PlatformResponse<ScreenshotResult>>;

  /**
   * Trigger Design Rule Check on the active PCB. Sprint 13 will add
   * a separate `getDrcViolations` for the structured-array form;
   * this one returns just the pass/fail summary that matches the
   * existing `ad_run_drc`.
   */
  runDrc(): Promise<PlatformResponse<DrcSummary>>;

  /**
   * Read the platform's messages panel (DRC violations, ERC errors,
   * compile warnings). Filtering by severity / source is the
   * caller's job — this returns the raw entries.
   */
  getMessages(): Promise<PlatformResponse<PlatformMessage[]>>;
}
