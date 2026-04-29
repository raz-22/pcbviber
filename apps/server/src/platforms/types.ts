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
 * One component on a schematic — designator + value + footprint
 * reference are the universal shape. EasyEDA exposes these via
 * `eda.sch_PrimitiveComponent.get()` per primitive id; the spike
 * called out that field names aren't fully spelled out at the
 * SDK declaration level, so extraction is best-effort and the
 * raw payload preserves the rest.
 */
export interface SchematicComponent {
  primitiveId: string;
  designator: string;
  value: string;
  raw: unknown;
}

/**
 * One component placed on a PCB — the cross-platform basic-BOM shape.
 * Just designator + footprint here; placement fields (x/y/layer/
 * rotation/locked) land in Sprint 11 PR 11.1's `get_components` to
 * keep the surface focused on what's needed for read-the-BOM use
 * cases. EasyEDA exposes these via `eda.pcb_PrimitiveComponent.get()`;
 * spike question #4 (sprint-9-easyeda-spike) flagged that the exact
 * field names need hands-on confirmation, so extraction is best-
 * effort and the raw payload preserves the rest.
 */
export interface PcbComponent {
  primitiveId: string;
  designator: string;
  footprint: string;
  raw: unknown;
}

/**
 * Sprint 11 PR 11.1: a placed component with full layout-relevant
 * fields. Distinct from `PcbComponent` (10.3b's basic-BOM read) —
 * `get_components` returns this richer payload because it's the
 * foundation Sprint 11's write tools (move/rotate/lock) all build
 * on. Two tools instead of one because the basic enumeration path
 * doesn't need the placement round-trip cost.
 *
 * Coordinate convention: **millimeters, board-local origin.** Both
 * platforms convert to mm at the relay/extension boundary so the
 * cross-platform contract is unit-uniform — Altium's native is
 * 10,000ths of a mil, EasyEDA's is mm. Layer is normalized to one
 * of `top|bottom|inner|unknown` so AI clients can write portable
 * placement rules.
 *
 * `mpn` and `footprint` come from platform-specific fields:
 *   Altium: Comment / Pattern (best-effort — not all components
 *           carry MPN-style identifiers).
 *   EasyEDA: properties.mpn / properties.footprint.
 * Empty string when unset rather than undefined so AI clients render
 * a deterministic value.
 */
/**
 * Confirmation envelope returned by the Sprint 11 PR 11.2 mutate
 * tools. Carries the post-mutation state of the mutated fields so
 * the AI client can verify the change without a follow-up
 * `getComponents` round-trip. Field set is intentionally minimal —
 * full state lives in `getComponents`.
 */
/**
 * Sprint 11 PR 11.3: a 2D keepout region on the active PCB. Polygon
 * outline + which-thing-is-prohibited + which-layers-it-applies-to.
 *
 * Layer scope follows the same `top|bottom|inner` union as
 * PlacedComponent, plus `"all"` for cross-layer keepouts (e.g.,
 * mech-only no-component zones).
 *
 * `kind` collapses platform-specific enums to the four cases AI
 * clients reason about: `placement` (no components here), `routing`
 * (no traces), `via` (no vias), `all` (everything prohibited).
 * Altium's full `eKeepoutKind_*` set survives in `raw` for tools
 * that need finer-grained variants (e.g., differential-pair-only).
 *
 * Vertices in mm, board-local origin, NOT auto-closed — the last
 * vertex is the last vertex; AI clients reasoning about polygon
 * area should close the loop themselves. Empty array means a
 * zero-vertex region (malformed; surface as supported:true with
 * an empty `vertices` field rather than dropping the keepout).
 */
export interface Keepout {
  id: string;
  kind: "placement" | "routing" | "via" | "all";
  layer: "top" | "bottom" | "inner" | "all";
  vertices: Array<{ x: number; y: number }>;
  raw: unknown;
}

/**
 * Sprint 12 PR 12.1: per-net routing summary on the active PCB.
 * One entry per net; pagination is over nets so dense boards
 * (1000+ nets) don't blow the relay budget.
 *
 * `layers` keys are the cross-platform layer union names ("top",
 * "bottom", "inner", "unknown") with mm of trace per layer.
 * `viaCount` and `unroutedSegments` are aggregates: vias on
 * any layer transition belonging to this net; unrouted ratlines
 * still pending on this net.
 *
 * Sufficient for AI reasoning about routing completeness ("is
 * this net done? how long is the longest? which still have gaps?")
 * without dumping per-segment geometry. A future
 * `get_unrouted_segments` PR can expose the segment-level detail
 * for specific repair workflows.
 */
/**
 * Sprint 12 PR 12.2: a design rule on the active PCB.
 *
 * `kind` collapses platform-specific rule categories to four cases
 * the cross-platform tools normalize: `clearance`, `width`, `via`,
 * and `other` (everything else, preserved in `raw`). v1 only writes
 * the first three; reads surface every rule the platform exposes.
 *
 * `scope` follows the standard scope-DSL of EDA rules: a rule
 * applies to "all" objects, a single net, or a net class. Cross-
 * platform names get extracted; the raw scope expression survives
 * in `raw` for tools that need fine-grained control.
 *
 * Kind-specific value fields (clearanceMm/widthMm/viaMm) are all
 * optional. AI clients dispatch on `kind` and read the matching
 * field. Unknown rule shapes leave all kind-specific fields
 * undefined and rely on `raw`.
 */
export interface DesignRule {
  name: string;
  kind: "clearance" | "width" | "via" | "other";
  scope: {
    type: "all" | "net" | "net-class";
    /** Net name or net-class name; absent when type === "all". */
    target?: string;
  };
  /** For kind: "clearance" — minimum gap between scoped objects. */
  clearanceMm?: number;
  /** For kind: "width" — preferred trace width with min/max bounds. */
  widthMm?: { min: number; preferred: number; max: number };
  /** For kind: "via" — drilled hole + outer pad diameter. */
  viaMm?: { holeDiameter: number; padDiameter: number };
  raw: unknown;
}

/**
 * Sprint 12 PR 12.2: discriminated-union input for `setRouteRule`.
 * The `kind` field selects which value-shape applies; only the
 * matching field is used. v1 supports the three core kinds; other
 * rule categories are read-only until a future PR.
 */
export type SetRouteRuleParams = {
  /** Rule name. Updates an existing rule, or creates one if missing. */
  name: string;
  /** Defaults to {type: "all"} when caller omits scope. */
  scope?: {
    type: "all" | "net" | "net-class";
    target?: string;
  };
} & (
  | { kind: "clearance"; clearanceMm: number }
  | { kind: "width"; widthMm: { min: number; preferred: number; max: number } }
  | { kind: "via"; viaMm: { holeDiameter: number; padDiameter: number } }
);

/**
 * Sprint 12 PR 12.3: result of `unrouteNet`. Carries the
 * counts the AI client needs to verify the operation:
 *   - deletedTraces: traces successfully removed
 *   - deletedVias: vias successfully removed
 *   - skippedLocked: locked traces/vias preserved (user-intentional)
 *
 * Net-not-found and "net has no traces" both return successfully
 * with zero counts and a message explaining which case it was;
 * AI clients can call get_net_routing first to disambiguate
 * before unrouting if the distinction matters.
 */
/**
 * Sprint 12 PR 12.4: result of `routeDiffPair`. Two-axis status:
 *
 *   `supported` (PlatformResponse-level): tool ran or didn't.
 *   `routed` (this field): the router itself succeeded or didn't.
 *
 * `routed: false` is NOT a tool failure — the call worked, the
 * platform's diff-pair router ran but couldn't lay traces (no
 * clear path, blocked by obstacles, spacing rule too tight, etc.).
 * AI clients should retry with adjusted parameters before treating
 * this as a hard error. `supported: false` (the outer envelope)
 * IS a hard error: tool unavailable, relay disconnected, etc.
 *
 * `totalLengthMm` is the sum of new trace length on both nets —
 * a rough proxy for how much got routed. Zero means the router
 * laid no new traces.
 */
export interface RouteDiffPairResult {
  positiveNet: string;
  negativeNet: string;
  routed: boolean;
  totalLengthMm: number;
  message: string;
}

export interface UnrouteResult {
  net: string;
  deletedTraces: number;
  deletedVias: number;
  skippedLocked: number;
  message: string;
}

export interface NetRouting {
  netName: string;
  totalLengthMm: number;
  layers: Record<string, number>;
  viaCount: number;
  unroutedSegments: number;
  raw: unknown;
}

export interface MutateResult {
  designator: string;
  /** A short human-readable confirmation, e.g. "Moved R1 to (10.5, 20.0)". */
  message: string;
}

export interface PlacedComponent {
  primitiveId: string;
  designator: string;
  mpn: string;
  footprint: string;
  /** X/Y in millimeters. Origin and orientation are platform-native
   *  (board-local). */
  x: number;
  y: number;
  /** Normalized layer name. `unknown` for inner / mech / unrecognized. */
  layer: "top" | "bottom" | "inner" | "unknown";
  /** Rotation in degrees, 0-360 normalized. */
  rotation: number;
  locked: boolean;
  /**
   * Sprint 11 PR 11.4: bounding-box width in mm. Optional —
   * `0` means the relay/extension couldn't extract a bounding
   * box for this entry. `validatePlacement` uses these to compute
   * edge-to-edge clearance; missing values trigger heuristic
   * fallback (1mm placeholder + tagged "approximate" in the
   * violation message). Axis-aligned in v1 — rotation-aware
   * bbox is a future PR.
   */
  width: number;
  /** Bounding-box height in mm. See `width`. */
  height: number;
  raw: unknown;
}

/**
 * Sprint 11 PR 11.4: a single placement violation found by
 * `validatePlacement`. Two kinds, distinguished by `type`:
 *
 *   - `overlap`: bounding boxes overlap (negative gap).
 *     `overlapMm` = positive depth of penetration.
 *   - `spacing`: bounding boxes are within `spacingMm` of each
 *     other but not overlapping. `distanceMm` = gap, in mm.
 *
 * `componentA` and `componentB` are designators (the cross-platform
 * stable identity per amendment #50). Order is deterministic —
 * sorted lexicographically — so a pair (R1, R2) renders the same
 * way regardless of iteration order.
 *
 * `message` is human-readable, suitable for direct emission to AI
 * clients. It includes lock status and approximate-bbox flags so
 * the AI can reason about which violations are actionable.
 */
export interface PlacementViolation {
  type: "overlap" | "spacing";
  componentA: string;
  componentB: string;
  /** Edge-to-edge gap in mm (always > 0 on spacing violations). */
  distanceMm?: number;
  /** Penetration depth in mm (always > 0 on overlap violations). */
  overlapMm?: number;
  message: string;
}

/**
 * Sprint 11 PR 11.5: input shape for `place_by_group`. The
 * filter is an AND-joined `key=value` expression with glob
 * support; the strategy is a discriminated union of three
 * layout planners.
 *
 * Filter fields supported in v1: `designator`, `footprint`,
 * `mpn`, `layer`. Net-based filtering returns when per-pin net
 * data lands (post-Sprint 12).
 */
export type PlaceByGroupParams = {
  /** Filter expression. Example: "footprint=0402 AND designator=R*". */
  filter: string;
  /** Avoid placing within this many mm of locked components.
   *  Default 0.5mm. */
  obstacleClearanceMm?: number;
} & (
  | {
      strategy: "grid";
      grid: {
        originX: number;
        originY: number;
        spacingMm?: number;
        columns?: number;
      };
    }
  | {
      strategy: "around-component";
      around: {
        target: string;
        radiusMm?: number;
      };
    }
  | {
      strategy: "on-edge";
      edge: {
        side: "top" | "bottom" | "left" | "right";
        offsetMm?: number;
      };
    }
);

export interface PlaceByGroupResult {
  /** Designators that matched the filter. */
  matched: string[];
  /** Designators successfully moved to a planned position. */
  moved: string[];
  /** Designators the strategy couldn't place — locked components,
   *  no valid position, or move-call failure. Each entry has a
   *  human-readable reason. */
  skipped: Array<{ designator: string; reason: string }>;
  /** Echoed for the AI to confirm what ran. */
  strategy: string;
  /** One-sentence summary suitable for direct AI emission. */
  message: string;
}

export interface ValidatePlacementResult {
  violations: PlacementViolation[];
  /** Number of components that participated in the check. */
  totalChecked: number;
  /** Number of unique pairs examined. Equals C(totalChecked, 2)
   *  unless the same-layer filter dropped some pairs. */
  pairsExamined: number;
  /** Number of components for which a bounding box was missing
   *  (zero width/height). Indicates how much of the result depends
   *  on the heuristic 1mm-placeholder fallback. */
  approximateBboxCount: number;
}

/**
 * One entry from the workspace's component library — the universal
 * basic-catalog shape across both platforms. This isn't a part placed
 * on a board; it's a part sitting in the user's library, available to
 * place. Altium: an entry from `desLibrary.nodes` (Nexar workspace
 * library); EasyEDA: an entry from `eda.lib_Device.search()`.
 *
 * `lcscId` and `mpn` are optional — Altium 365 libraries don't always
 * carry LCSC tags, and EasyEDA's per-entry MPN can be empty for
 * generic primitives. When `lcscId` IS present and Nexar is
 * configured, the EasyEDA platform optionally fetches Octopart
 * per-distributor stock and merges it into `octopart` (per Sprint 10
 * PR 10.4's enrichment goal).
 */
export interface LibraryComponent {
  id: string;
  name: string;
  description?: string;
  footprint?: string;
  manufacturer?: string;
  mpn?: string;
  lcscId?: string;
  lifecycle?: string;
  /**
   * Octopart per-distributor stock + pricing, populated when
   * enrichment ran successfully. Undefined when enrichment was
   * skipped (Nexar not configured, lcscId/mpn missing, or
   * `enrichWithLcsc: false`) or when the lookup found no match.
   */
  octopart?: {
    mpn: string;
    manufacturer: string;
    description?: string;
    offers: Array<{
      supplier: string;
      stock: number;
      moq: number;
      sku: string;
    }>;
  };
  /** Platform-specific raw payload, kept for tools that need more fields. */
  raw: unknown;
}

export interface ListLibraryComponentsParams {
  offset?: number;
  limit?: number;
  /** When true (default), the EasyEDA platform tries to look up each
   *  result by MPN/LCSC via Nexar and merges per-distributor stock
   *  into `LibraryComponent.octopart`. Skipped automatically when
   *  Nexar isn't configured for the workspace. */
  enrichWithLcsc?: boolean;
}

/**
 * Standard pagination wrapper for collection-returning tools.
 * Per the roadmap's "pagination by default" architectural
 * commitment: every list tool takes offset+limit and returns a
 * nextOffset so the AI client can ask for the next page without
 * juggling state. Boards routinely have thousands of components;
 * blowing the AltiumRelay HTTP budget on a single mega-response
 * would silently truncate.
 *
 * `nextOffset` is null when this page exhausts the collection.
 */
export interface Page<T> {
  items: T[];
  nextOffset: number | null;
  /** Total count of items across all pages. May be undefined when
   * the platform's API doesn't surface a cheap total. */
  total?: number;
}

export interface PaginationParams {
  offset?: number;
  limit?: number;
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
   * List components on the active schematic, paginated.
   * EasyEDA: `eda.sch_PrimitiveComponent.getAllPrimitiveId()` +
   * sliced `get(idsForPage)`.
   * Altium: stubbed today (PR 10.3a) — the AD relay command for
   * schematic introspection isn't wired yet; surfaces as
   * supported:false until a follow-up PR extends AltiumRelay.js.
   */
  listSchematicComponents(
    params: PaginationParams
  ): Promise<PlatformResponse<Page<SchematicComponent>>>;

  /**
   * List components placed on the active PCB, paginated. Returns the
   * basic-BOM shape (designator + footprint); Sprint 11 PR 11.1
   * (`get_components`) extends with x/y/layer/rotation/locked.
   * EasyEDA: `eda.pcb_PrimitiveComponent.getAllPrimitiveId()` +
   * sliced `get(idsForPage)`.
   * Altium: stubbed today (PR 10.3b) — the AD relay command for
   * BoardIterator/eComponentObject walks isn't wired yet; surfaces
   * as supported:false until a follow-up PR extends AltiumRelay.js.
   */
  listPcbComponents(
    params: PaginationParams
  ): Promise<PlatformResponse<Page<PcbComponent>>>;

  /**
   * Sprint 11 PR 11.1: paginated read of placed components with
   * full layout fields. Distinct from `listPcbComponents` (basic
   * BOM) — `getComponents` is the foundation Sprint 11's write
   * tools call before mutating placement.
   *
   * Altium: walks `BoardIterator` over `eComponentObject` via a
   * new AD relay command (`get_components`); converts native
   * 10,000ths-of-a-mil → mm at the relay boundary so the contract
   * is unit-uniform.
   * EasyEDA: `eda.pcb_PrimitiveComponent.get(ids)` already returns
   * position/rotation/layer/locked per the spike.
   */
  getComponents(
    params: PaginationParams
  ): Promise<PlatformResponse<Page<PlacedComponent>>>;

  /**
   * Sprint 11 PR 11.2: place-by-designator primitive write tools.
   *
   * All three address components by **designator** (the cross-platform
   * stable identity per amendment #50): unique within a project,
   * human-readable, what AI clients naturally produce ("move R1 to
   * (10, 20)"). Components without a designator can't be addressed —
   * acceptable since unlabeled components are usually mech-only.
   *
   * Multiple-match handling: a project with two components sharing
   * a designator is malformed; both platforms reject explicitly with
   * supported:false rather than silently mutating the first hit.
   *
   * Locked-guard: move/rotate refuse to mutate a locked component —
   * the AI must call `lockComponent({locked: false})` first. Forces
   * explicit intent rather than relying on platform-specific
   * silent-fail-or-unlock behavior.
   */
  moveComponent(params: {
    designator: string;
    /** Target X in millimeters, board-local origin. */
    x: number;
    /** Target Y in millimeters. */
    y: number;
  }): Promise<PlatformResponse<MutateResult>>;

  rotateComponent(params: {
    designator: string;
    /** Rotation in degrees, 0–360 normalized. */
    rotation: number;
  }): Promise<PlatformResponse<MutateResult>>;

  lockComponent(params: {
    designator: string;
    locked: boolean;
  }): Promise<PlatformResponse<MutateResult>>;

  /**
   * Sprint 11 PR 11.3: read every keepout on the active PCB.
   * Cross-platform. Not paginated — keepouts are typically <50
   * per board, and they're consumed as a complete set by validation
   * tools (PR 11.4's validate_placement) where pagination would just
   * complicate the math.
   *
   * Altium: BoardIterator over eRegionObject filtered to keepout
   * layer; per-region kind/layer/vertices extraction with mm
   * conversion at the relay boundary.
   * EasyEDA: pcb_PrimitiveRegion is the suspected carrier per the
   * Sprint 9 spike (`[NEEDS HANDS-ON]` flagged); the impl runs
   * defensive extraction and surfaces supported:false with the
   * spike-question reason if the API is unavailable.
   *
   * The `set_keepout` write path lands in PR 11.3b once the
   * EasyEDA-side API is confirmed hands-on.
   */
  getKeepouts(): Promise<PlatformResponse<Keepout[]>>;

  /**
   * Sprint 12 PR 12.1: paginated per-net routing summary. First
   * read tool of Sprint 12's routing deep dive — sets up rule
   * mutation (12.2), unrouting (12.3), and the rest.
   *
   * Altium: BoardIterator over eTrackObject + eViaObject +
   * eRatNestObject, aggregated by net. Coordinates in mm at
   * the relay boundary; layers normalized to the cross-platform
   * union via normalizeLayer.
   * EasyEDA: pcb_Net.getAll() + per-net pcb_PrimitiveLine.getAll
   * + pcb_PrimitiveVia.getAll + pcb_Net.getNetLength. Defensive
   * fallback if any accessor is missing.
   */
  getNetRouting(
    params: PaginationParams
  ): Promise<PlatformResponse<Page<NetRouting>>>;

  /**
   * Sprint 12 PR 12.2: read all design rules on the active PCB.
   * Not paginated — design rules are typically <100 per board and
   * AI clients usually want the whole set for "what rules apply
   * here?" reasoning.
   *
   * Altium: walks Board.DesignRules across all categories. EasyEDA:
   * `pcb_Drc.getCurrentRuleConfiguration()`. Both surface every
   * rule kind; cross-platform `kind` normalization collapses the
   * three core kinds (clearance, width, via); rest end up as
   * "other" with raw payload preserved.
   */
  getDesignRules(): Promise<PlatformResponse<DesignRule[]>>;

  /**
   * Sprint 12 PR 12.2: update or create a design rule. Discriminated
   * by `kind` — only the matching value field is used; others
   * silently ignored.
   *
   * Altium: `Board.DesignRules.RuleByName(name)` followed by field
   * setters; creates the rule if name is new. EasyEDA: read-modify-
   * write on the full rule config (single-rule update isn't
   * directly exposed; we read getCurrentRuleConfiguration, mutate
   * one entry, write via overwriteCurrentRuleConfiguration).
   */
  setRouteRule(
    params: SetRouteRuleParams
  ): Promise<PlatformResponse<MutateResult>>;

  /**
   * Sprint 12 PR 12.3: delete all traces + vias on a given net.
   * Locked traces/vias are skipped (user-intentional) and counted
   * separately so AI clients know whether to unlock + retry.
   *
   * Net-not-found and "net has no traces" both return successfully
   * with zero deletion counts. If the distinction matters, call
   * `getNetRouting(net)` first to confirm the net exists.
   *
   * No undo: the relay doesn't expose the editor's undo stack.
   * Pair with `screenshot` for visual confirmation.
   */
  unrouteNet(params: {
    net: string;
  }): Promise<PlatformResponse<UnrouteResult>>;

  /**
   * Sprint 12 PR 12.4: trigger the platform's native differential-
   * pair router on the (positiveNet, negativeNet) pair. Requires
   * the diff pair to already be declared in the project — v1
   * doesn't create pairs. Errors out cleanly with supported:false
   * naming the diff-pair editor when the pair isn't recognized.
   *
   * Returns `routed: true/false` distinct from `supported: true`:
   * tool ran successfully = supported true; router laid traces =
   * routed true. AI clients reading `routed: false` can retry
   * with different layer/spacing rather than abort.
   *
   * Altium: invokes the AD process for diff-pair routing
   * (Server:DispatchDocument) with Board.RouteNets fallback.
   * EasyEDA: pcb_Document.autoRouting(props) — currently BETA
   * per the SDK; defensive shape extraction for version drift.
   */
  routeDiffPair(params: {
    positiveNet: string;
    negativeNet: string;
  }): Promise<PlatformResponse<RouteDiffPairResult>>;

  /**
   * Sprint 11 PR 11.4: check the active PCB for component overlap
   * and spacing-rule violations. Computed locally from
   * `getComponents` per the spike — both platforms run the same
   * shared algorithm in `placement-validation.ts` so results are
   * identical across Altium and EasyEDA.
   *
   * The `spacingMm` argument is the minimum edge-to-edge clearance
   * between component bodies. Default of 0.2mm matches typical
   * IPC-7351 hand-placed boards. Pairs where both components are
   * locked are skipped (user-intentional placement).
   *
   * Components without a bounding box (width or height = 0) get a
   * 1mm × 1mm heuristic placeholder; the violation tags
   * "(approximate)" so AI clients know the result depends on
   * incomplete sizing data.
   */
  validatePlacement(params: {
    /** Minimum edge-to-edge clearance in mm. Default 0.2. */
    spacingMm?: number;
  }): Promise<PlatformResponse<ValidatePlacementResult>>;

  /**
   * Sprint 11 PR 11.5: filter components by an AND-joined
   * key=value expression and apply a layout strategy. Pure
   * orchestration — uses getComponents to read state, plans
   * placements respecting locked components as obstacles, then
   * iterates moveComponent for each target.
   *
   * Closes the LLM-friendly placement workflow per the roadmap:
   * one tool that takes a natural filter + strategy and lands
   * coherent placements without the AI having to enumerate
   * components manually.
   */
  placeByGroup(
    params: PlaceByGroupParams
  ): Promise<PlatformResponse<PlaceByGroupResult>>;

  /**
   * List entries from the workspace's component library, paginated.
   * Cross-platform replacement for the legacy Altium-only
   * `list_library_components` (which was a `tools/components.ts`
   * Nexar wrapper) — per amendment #50, every read tool the platform
   * exposes registers through this interface, so the legacy
   * registration is removed in PR 10.4.
   *
   * Altium: wraps `nexar.listComponents(workspaceUrl)`. The Nexar
   * GraphQL query returns the full library in one shot today;
   * pagination here is in-memory slice. A future PR can push offset/
   * limit into the GraphQL when 10k+ part libraries become a problem.
   *
   * EasyEDA: calls `eda.lib_Device.search()` through the relay,
   * deriving the EasyEDA-style page index from offset/limit. When
   * `enrichWithLcsc` is true (default) AND Nexar is configured for
   * the workspace, results carrying an MPN or LCSC ID get
   * cross-referenced via Nexar's supSearchMpn — per-distributor
   * stock + pricing merge into `LibraryComponent.octopart`.
   */
  listLibraryComponents(
    params: ListLibraryComponentsParams
  ): Promise<PlatformResponse<Page<LibraryComponent>>>;

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
