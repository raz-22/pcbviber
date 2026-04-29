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
import type { NexarService } from "../services/nexar.js";
import {
  buildRouteDiffPairResult,
  buildUnrouteResult,
  extractVertices,
  makeMutateResult,
  normalizeDesignRule,
  normalizeKeepoutKind,
  normalizeKeepoutLayer,
  normalizeLayer,
  normalizeNetRouting,
} from "./altium.js";
import { validateComponents, DEFAULT_SPACING_MM } from "./placement-validation.js";
import {
  notSupported,
  ok,
  type ActiveProject,
  type DrcResult,
  type LibraryComponent,
  type ListLibraryComponentsParams,
  type MutateResult,
  type DesignRule,
  type Keepout,
  type NetRouting,
  type RouteDiffPairResult,
  type SetRouteRuleParams,
  type UnrouteResult,
  type ExportResult,
  type ViaStitchResult,
  type XSignalsStatusResult,
  type Page,
  type PaginationParams,
  type PcbComponent,
  type PlacedComponent,
  type Platform,
  type PlatformMessage,
  type PlatformResponse,
  type ProjectListEntry,
  type SchematicComponent,
  type ScreenshotResult,
  type PlaceByGroupParams,
  type PlaceByGroupResult,
  type ValidatePlacementResult,
} from "./types.js";
import { placeByGroupShared } from "./place-by-group.js";
import { viaStitchPlaneShared } from "./via-stitching.js";
import { readEasyedaArtifactFromUpload } from "./exports.js";
import { parseEasyedaDrcArray, summarizeDrc } from "./drc.js";

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
  /**
   * Optional Nexar handle for cross-platform enrichment. When set
   * AND `enrichWithLcsc !== false`, `listLibraryComponents` looks up
   * each EasyEDA library entry's MPN via Nexar's supSearchMpn and
   * merges per-distributor stock into `LibraryComponent.octopart`.
   * When null, enrichment is silently skipped (per
   * `LibraryComponent.octopart`'s "undefined when skipped" contract).
   */
  nexar?: NexarService | null;
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

/**
 * Sprint 12 PR 12.6: deliberate cross-platform-exclusivity reason.
 * EasyEDA Pro doesn't expose xSignals/length-tuning state at all
 * — this isn't a missing accessor, it's an architectural difference.
 * Naming the case in code (rather than inlining the message) makes
 * the contract searchable + protects against accidental
 * stub-replacement in a future PR.
 */
const GENUINE_PLATFORM_EXCLUSIVITY_XSIGNALS =
  "EasyEDA does not expose xSignals/length-tuning state. This is a deliberate cross-platform difference, not a missing API — EasyEDA Pro's design surface doesn't include the xSignals concept (introduced Sprint 12 PR 12.6).";

export class EasyedaPlatform implements Platform {
  readonly name = "easyeda" as const;

  constructor(
    private readonly deps: EasyedaPlatformDeps = {
      relay: null,
      workspaceId: null,
    }
  ) {}

  async getActiveProject(): Promise<PlatformResponse<ActiveProject>> {
    if (!this.deps.relay || !this.deps.workspaceId) {
      return notSupported(NO_BRIDGE_REASON);
    }
    try {
      // The extension's `get_active_project` handler should call
      // `eda.dmt_Project.getCurrentProjectInfo()` and return its
      // payload. Per the PR 9.1 spike: that returns an
      // `IDMT_ProjectItem | undefined` whose exact field set isn't
      // typed at the SDK level — we extract `uuid` + `name`
      // best-effort, mirroring the AltiumPlatform path.
      const raw = await this.deps.relay.execute<{
        uuid?: unknown;
        name?: unknown;
      }>(this.deps.workspaceId, "get_active_project", {});
      // No active project: extension can return null/undefined when
      // the editor has no project loaded. Distinct from "extension
      // failed" — surface as supported:false with a clear reason
      // so the AI client doesn't think the tool is broken.
      if (raw === null || raw === undefined) {
        return notSupported(
          "No active project in EasyEDA Pro. Open a project first."
        );
      }
      const obj = isRecord(raw) ? raw : {};
      const id = typeof obj.uuid === "string" ? obj.uuid : "";
      const name =
        typeof obj.name === "string" ? obj.name : id || "(unknown)";
      return ok({ id: id || name, name, raw });
    } catch (err) {
      return notSupported(err instanceof Error ? err.message : String(err));
    }
  }

  async listProjects(): Promise<PlatformResponse<ProjectListEntry[]>> {
    if (!this.deps.relay || !this.deps.workspaceId) {
      return notSupported(NO_BRIDGE_REASON);
    }
    try {
      // The extension handler returns
      //   Array<{uuid: string, name: string, ...}>
      // — that's the shape of `eda.dmt_Project.getProjectInfo(uuid)`
      // collected per-project from `getAllProjectsUuid()`. We
      // tolerate non-string fields gracefully because the
      // pro-api-types shape isn't fully spelled out at the
      // declaration level.
      const raw = await this.deps.relay.execute<unknown>(
        this.deps.workspaceId,
        "list_projects",
        {}
      );
      if (!Array.isArray(raw)) {
        return notSupported(
          "EasyEDA extension returned a non-array list_projects result."
        );
      }
      const entries: ProjectListEntry[] = raw.flatMap((entry) => {
        if (!isRecord(entry)) return [];
        const id = typeof entry.uuid === "string" ? entry.uuid : "";
        const name =
          typeof entry.name === "string" ? entry.name : id || "(unknown)";
        if (!id && name === "(unknown)") return [];
        return [{ id: id || name, name, raw: entry }];
      });
      return ok(entries);
    } catch (err) {
      return notSupported(err instanceof Error ? err.message : String(err));
    }
  }

  async listSchematicComponents(
    params: PaginationParams
  ): Promise<PlatformResponse<Page<SchematicComponent>>> {
    if (!this.deps.relay || !this.deps.workspaceId) {
      return notSupported(NO_BRIDGE_REASON);
    }
    // Defaults: offset=0, limit=200. The 200 cap matches what
    // ad_get_messages uses + keeps a single relay round-trip well
    // under the long-poll's 25s budget on workspaces with thousands
    // of components. Caller asks for the next page by passing
    // offset = previous nextOffset.
    const offset = Math.max(0, Math.floor(params.offset ?? 0));
    const limit = Math.min(500, Math.max(1, Math.floor(params.limit ?? 200)));
    try {
      const raw = await this.deps.relay.execute<unknown>(
        this.deps.workspaceId,
        "list_schematic_components",
        { offset, limit }
      );
      // Extension returns
      //   { items: Array<rawComponent>, total: number }
      // where rawComponent is whatever
      // `eda.sch_PrimitiveComponent.get(ids)` returns. We extract
      // primitiveId + best-effort designator + value, preserve
      // the rest in `raw`.
      const obj = isRecord(raw) ? raw : {};
      const itemsRaw = Array.isArray(obj.items) ? obj.items : null;
      const total = typeof obj.total === "number" ? obj.total : undefined;
      if (!itemsRaw) {
        return notSupported(
          "EasyEDA extension returned a list_schematic_components result without an `items` array."
        );
      }
      const items: SchematicComponent[] = itemsRaw.flatMap((entry) => {
        if (!isRecord(entry)) return [];
        const primitiveId =
          typeof entry.primitiveId === "string" ? entry.primitiveId : "";
        if (!primitiveId) return [];
        // Designator + value live under arbitrary property keys
        // depending on the symbol type. Best-effort:
        //   - prefer entry.designator / entry.value when set
        //   - fall back to entry.properties.designator etc.
        //   - empty strings rather than undefined so the AI
        //     client renders "" instead of dropping the field
        const props = isRecord(entry.properties) ? entry.properties : {};
        const designator =
          typeof entry.designator === "string"
            ? entry.designator
            : typeof props.designator === "string"
              ? (props.designator as string)
              : "";
        const value =
          typeof entry.value === "string"
            ? entry.value
            : typeof props.value === "string"
              ? (props.value as string)
              : "";
        return [{ primitiveId, designator, value, raw: entry }];
      });
      // Pagination logic:
      //   - If `total` is known: nextOffset = next slice when we
      //     haven't reached the end; null when we have.
      //   - If `total` is unknown: full-page result implies more
      //     might follow (caller has to page until they get a
      //     short page). Anything less than `limit` ends.
      let nextOffset: number | null;
      if (total !== undefined) {
        nextOffset =
          offset + items.length < total ? offset + items.length : null;
      } else {
        nextOffset =
          items.length === limit ? offset + items.length : null;
      }
      return ok({ items, nextOffset, total });
    } catch (err) {
      return notSupported(err instanceof Error ? err.message : String(err));
    }
  }

  async getComponents(
    params: PaginationParams
  ): Promise<PlatformResponse<Page<PlacedComponent>>> {
    if (!this.deps.relay || !this.deps.workspaceId) {
      return notSupported(NO_BRIDGE_REASON);
    }
    const offset = Math.max(0, Math.floor(params.offset ?? 0));
    const limit = Math.min(500, Math.max(1, Math.floor(params.limit ?? 200)));
    try {
      const raw = await this.deps.relay.execute<unknown>(
        this.deps.workspaceId,
        "get_components",
        { offset, limit }
      );
      // Extension returns the full placement payload — sister to
      // list_pcb_components but extracts the richer per-entry fields.
      // EasyEDA Pro stores X/Y in mm natively, so no unit conversion
      // here (Altium converts at the relay boundary).
      const obj = isRecord(raw) ? raw : {};
      const itemsRaw = Array.isArray(obj.items) ? obj.items : null;
      const total = typeof obj.total === "number" ? obj.total : undefined;
      if (!itemsRaw) {
        return notSupported(
          "EasyEDA extension returned a get_components result without an `items` array."
        );
      }
      const items: PlacedComponent[] = itemsRaw.flatMap((entry) => {
        if (!isRecord(entry)) return [];
        const primitiveId =
          typeof entry.primitiveId === "string" ? entry.primitiveId : "";
        if (!primitiveId) return [];
        const props = isRecord(entry.properties) ? entry.properties : {};
        const designator =
          typeof entry.designator === "string"
            ? entry.designator
            : typeof props.designator === "string"
              ? (props.designator as string)
              : "";
        const mpn =
          typeof entry.mpn === "string"
            ? entry.mpn
            : typeof entry.manufacturerPartNumber === "string"
              ? entry.manufacturerPartNumber
              : typeof props.mpn === "string"
                ? (props.mpn as string)
                : "";
        const footprint =
          typeof entry.footprint === "string"
            ? entry.footprint
            : typeof props.footprint === "string"
              ? (props.footprint as string)
              : "";
        // EasyEDA Pro stores position under several names depending
        // on entry vintage. Common: x/y top-level, or position:{x,y}.
        const pos = isRecord(entry.position) ? entry.position : null;
        const x =
          typeof entry.x === "number"
            ? entry.x
            : pos && typeof pos.x === "number"
              ? pos.x
              : 0;
        const y =
          typeof entry.y === "number"
            ? entry.y
            : pos && typeof pos.y === "number"
              ? pos.y
              : 0;
        const rotation =
          typeof entry.rotation === "number"
            ? entry.rotation
            : 0;
        const locked = entry.locked === true;
        // Sprint 11 PR 11.4: bounding box for validatePlacement.
        // EasyEDA Pro stores size under several names depending on
        // entry vintage. Common: width/height top-level, or
        // boundingBox: {width, height}, or bbox: {w, h}. Defensive
        // fallback chain.
        const bbox = isRecord(entry.boundingBox)
          ? entry.boundingBox
          : isRecord(entry.bbox)
            ? entry.bbox
            : null;
        const width =
          typeof entry.width === "number"
            ? entry.width
            : bbox && typeof bbox.width === "number"
              ? bbox.width
              : bbox && typeof bbox.w === "number"
                ? bbox.w
                : 0;
        const height =
          typeof entry.height === "number"
            ? entry.height
            : bbox && typeof bbox.height === "number"
              ? bbox.height
              : bbox && typeof bbox.h === "number"
                ? bbox.h
                : 0;
        return [
          {
            primitiveId,
            designator,
            mpn,
            footprint,
            x,
            y,
            layer: normalizeLayer(entry.layer),
            rotation,
            locked,
            width,
            height,
            raw: entry,
          },
        ];
      });
      const nextOffset =
        total !== undefined
          ? offset + items.length < total
            ? offset + items.length
            : null
          : items.length === limit
            ? offset + items.length
            : null;
      return ok({ items, nextOffset, total });
    } catch (err) {
      return notSupported(err instanceof Error ? err.message : String(err));
    }
  }

  async moveComponent(params: {
    designator: string;
    x: number;
    y: number;
  }): Promise<PlatformResponse<MutateResult>> {
    if (!this.deps.relay || !this.deps.workspaceId) {
      return notSupported(NO_BRIDGE_REASON);
    }
    try {
      // Extension handles designator → primitiveId resolution +
      // multi-match guard + locked-guard. Server stays out of
      // designator math so we don't pay an extra round-trip
      // looking up the primitiveId before the modify call.
      const raw = await this.deps.relay.execute<{ message?: unknown }>(
        this.deps.workspaceId,
        "move_component",
        params
      );
      return ok(makeMutateResult(params.designator, raw, "Moved"));
    } catch (err) {
      return notSupported(err instanceof Error ? err.message : String(err));
    }
  }

  async rotateComponent(params: {
    designator: string;
    rotation: number;
  }): Promise<PlatformResponse<MutateResult>> {
    if (!this.deps.relay || !this.deps.workspaceId) {
      return notSupported(NO_BRIDGE_REASON);
    }
    try {
      const raw = await this.deps.relay.execute<{ message?: unknown }>(
        this.deps.workspaceId,
        "rotate_component",
        params
      );
      return ok(makeMutateResult(params.designator, raw, "Rotated"));
    } catch (err) {
      return notSupported(err instanceof Error ? err.message : String(err));
    }
  }

  async lockComponent(params: {
    designator: string;
    locked: boolean;
  }): Promise<PlatformResponse<MutateResult>> {
    if (!this.deps.relay || !this.deps.workspaceId) {
      return notSupported(NO_BRIDGE_REASON);
    }
    try {
      const raw = await this.deps.relay.execute<{ message?: unknown }>(
        this.deps.workspaceId,
        "lock_component",
        params
      );
      return ok(
        makeMutateResult(
          params.designator,
          raw,
          params.locked ? "Locked" : "Unlocked"
        )
      );
    } catch (err) {
      return notSupported(err instanceof Error ? err.message : String(err));
    }
  }

  async validatePlacement(params: {
    spacingMm?: number;
  }): Promise<PlatformResponse<ValidatePlacementResult>> {
    // Mirror of AltiumPlatform.validatePlacement — same shared
    // helper drives identical results across both platforms per
    // the spike's "computed locally from getComponents" intent.
    const all: PlacedComponent[] = [];
    let offset = 0;
    const limit = 500;
    const HARD_CAP = 5000;
    while (all.length < HARD_CAP) {
      const page = await this.getComponents({ offset, limit });
      if (!page.supported) return page;
      all.push(...page.data.items);
      if (page.data.nextOffset === null) break;
      offset = page.data.nextOffset;
    }
    const spacingMm = params.spacingMm ?? DEFAULT_SPACING_MM;
    return ok(validateComponents(all, spacingMm));
  }

  async placeByGroup(
    params: PlaceByGroupParams
  ): Promise<PlatformResponse<PlaceByGroupResult>> {
    return placeByGroupShared(this, params);
  }

  async getDesignRules(): Promise<PlatformResponse<DesignRule[]>> {
    if (!this.deps.relay || !this.deps.workspaceId) {
      return notSupported(NO_BRIDGE_REASON);
    }
    try {
      const raw = await this.deps.relay.execute<unknown>(
        this.deps.workspaceId,
        "get_design_rules",
        {}
      );
      const obj = isRecord(raw) ? raw : {};
      const itemsRaw = Array.isArray(obj.items) ? obj.items : null;
      if (!itemsRaw) {
        return notSupported(
          "EasyEDA extension returned a get_design_rules result without an `items` array."
        );
      }
      const items: DesignRule[] = itemsRaw.flatMap((entry) => {
        if (!isRecord(entry)) return [];
        const name = typeof entry.name === "string" ? entry.name : "";
        if (!name) return [];
        return [normalizeDesignRule(entry, name)];
      });
      return ok(items);
    } catch (err) {
      return notSupported(err instanceof Error ? err.message : String(err));
    }
  }

  async setRouteRule(
    params: SetRouteRuleParams
  ): Promise<PlatformResponse<MutateResult>> {
    if (!this.deps.relay || !this.deps.workspaceId) {
      return notSupported(NO_BRIDGE_REASON);
    }
    try {
      // Extension does the read-modify-write internally — the
      // EasyEDA Pro API exposes only a full-config write
      // (overwriteCurrentRuleConfiguration), so the extension
      // reads the current config, mutates one rule by name, and
      // writes back.
      const raw = await this.deps.relay.execute<{ message?: unknown }>(
        this.deps.workspaceId,
        "set_route_rule",
        params as unknown as Record<string, unknown>
      );
      return ok(makeMutateResult(params.name, raw, "Updated"));
    } catch (err) {
      return notSupported(err instanceof Error ? err.message : String(err));
    }
  }

  async unrouteNet(params: {
    net: string;
  }): Promise<PlatformResponse<UnrouteResult>> {
    if (!this.deps.relay || !this.deps.workspaceId) {
      return notSupported(NO_BRIDGE_REASON);
    }
    try {
      // Extension handles trace + via enumeration via
      // pcb_PrimitiveLine.getAll(net) + pcb_PrimitiveVia.getAll(net),
      // filters locked items, then batches delete(idsArray) per
      // primitive type. Server consumes the count envelope.
      const raw = await this.deps.relay.execute<unknown>(
        this.deps.workspaceId,
        "unroute_net",
        params as unknown as Record<string, unknown>
      );
      return ok(buildUnrouteResult(params.net, raw));
    } catch (err) {
      return notSupported(err instanceof Error ? err.message : String(err));
    }
  }

  async exportGerbers(): Promise<PlatformResponse<ExportResult>> {
    return this.runEasyedaExport("export_gerbers", "gerber-zip", {});
  }

  async exportDrill(): Promise<PlatformResponse<ExportResult>> {
    return this.runEasyedaExport("export_drill", "excellon-drill", {});
  }

  async exportBom(params: {
    withLcsc?: boolean;
  }): Promise<PlatformResponse<ExportResult>> {
    return this.runEasyedaExport("export_bom", "csv-bom", {
      withLcsc: params.withLcsc ?? true,
    });
  }

  async exportPickAndPlace(): Promise<PlatformResponse<ExportResult>> {
    return this.runEasyedaExport(
      "export_pick_and_place",
      "csv-pick-and-place",
      {}
    );
  }

  /**
   * Shared per-export pipeline. The extension does the heavy
   * lifting: calls the appropriate sch/pcb_ManufactureData
   * accessor, gets a browser File, uploads it to /api/artifacts
   * via sys_ClientUrl.request. The relay's response is the
   * upload-route's JSON envelope; readEasyedaArtifactFromUpload
   * unpacks it into the cross-platform ExportResult.
   */
  private async runEasyedaExport(
    method:
      | "export_gerbers"
      | "export_drill"
      | "export_bom"
      | "export_pick_and_place",
    format:
      | "gerber-zip"
      | "excellon-drill"
      | "csv-bom"
      | "csv-pick-and-place",
    params: Record<string, unknown>
  ): Promise<PlatformResponse<ExportResult>> {
    if (!this.deps.relay || !this.deps.workspaceId) {
      return notSupported(NO_BRIDGE_REASON);
    }
    try {
      const raw = await this.deps.relay.execute<unknown>(
        this.deps.workspaceId,
        method,
        params
      );
      return readEasyedaArtifactFromUpload(format, raw);
    } catch (err) {
      return notSupported(err instanceof Error ? err.message : String(err));
    }
  }

  async getXSignalsStatus(): Promise<PlatformResponse<XSignalsStatusResult>> {
    // Deliberate platform exclusivity — no length-tuning state to
    // read because EasyEDA Pro doesn't have the concept. AI clients
    // degrade gracefully via the standard supported:false contract.
    return notSupported(GENUINE_PLATFORM_EXCLUSIVITY_XSIGNALS);
  }

  async viaStitchPlane(params: {
    net: string;
    densityMm?: number;
    edgeClearanceMm?: number;
  }): Promise<PlatformResponse<ViaStitchResult>> {
    if (!this.deps.relay || !this.deps.workspaceId) {
      return notSupported(NO_BRIDGE_REASON);
    }
    return viaStitchPlaneShared(this, params, "easyeda", (positions) =>
      this.deps.relay!.execute<unknown>(
        this.deps.workspaceId!,
        "create_vias",
        { net: params.net, positions }
      )
    );
  }

  async routeDiffPair(params: {
    positiveNet: string;
    negativeNet: string;
  }): Promise<PlatformResponse<RouteDiffPairResult>> {
    if (!this.deps.relay || !this.deps.workspaceId) {
      return notSupported(NO_BRIDGE_REASON);
    }
    try {
      // Extension calls pcb_Document.autoRouting(props) which is
      // BETA per the SDK. Defensive shape extraction in
      // buildRouteDiffPairResult — version drift in the result
      // envelope just produces a {routed: false} fallback rather
      // than crashing the call.
      const raw = await this.deps.relay.execute<unknown>(
        this.deps.workspaceId,
        "route_diff_pair",
        params as unknown as Record<string, unknown>
      );
      return ok(
        buildRouteDiffPairResult(params.positiveNet, params.negativeNet, raw)
      );
    } catch (err) {
      return notSupported(err instanceof Error ? err.message : String(err));
    }
  }

  async getNetRouting(
    params: PaginationParams
  ): Promise<PlatformResponse<Page<NetRouting>>> {
    if (!this.deps.relay || !this.deps.workspaceId) {
      return notSupported(NO_BRIDGE_REASON);
    }
    const offset = Math.max(0, Math.floor(params.offset ?? 0));
    const limit = Math.min(500, Math.max(1, Math.floor(params.limit ?? 200)));
    try {
      const raw = await this.deps.relay.execute<unknown>(
        this.deps.workspaceId,
        "get_net_routing",
        { offset, limit }
      );
      const obj = isRecord(raw) ? raw : {};
      // Same {unsupported: true} convention as keepouts: extension
      // signals "API not exposed on this Pro version" cleanly.
      if (obj.unsupported === true) {
        return notSupported(
          "EasyEDA Pro net-routing API is not exposed in this extension version. The pcb_Net.getAll accessor is needed to enumerate nets; tracking as a follow-up spike question."
        );
      }
      const itemsRaw = Array.isArray(obj.items) ? obj.items : null;
      const total = typeof obj.total === "number" ? obj.total : undefined;
      if (!itemsRaw) {
        return notSupported(
          "EasyEDA extension returned a get_net_routing result without an `items` array."
        );
      }
      const items: NetRouting[] = itemsRaw.flatMap((entry) => {
        if (!isRecord(entry)) return [];
        const netName =
          typeof entry.netName === "string"
            ? entry.netName
            : typeof entry.name === "string"
              ? entry.name
              : "";
        if (!netName) return [];
        return [normalizeNetRouting(entry, netName)];
      });
      const nextOffset =
        total !== undefined
          ? offset + items.length < total
            ? offset + items.length
            : null
          : items.length === limit
            ? offset + items.length
            : null;
      return ok({ items, nextOffset, total });
    } catch (err) {
      return notSupported(err instanceof Error ? err.message : String(err));
    }
  }

  async getKeepouts(): Promise<PlatformResponse<Keepout[]>> {
    if (!this.deps.relay || !this.deps.workspaceId) {
      return notSupported(NO_BRIDGE_REASON);
    }
    try {
      // Per Sprint 9 spike question #4: pcb_PrimitiveRegion is the
      // suspected carrier for keepouts but the exact field set is
      // [NEEDS HANDS-ON]. The extension handler tries optimistically
      // and surfaces api-unavailable as supported:false rather than
      // crashing. Defensive extraction handles whatever flavor of
      // payload comes back — kind/layer/vertices keys may live under
      // top-level or properties depending on Pro version.
      const raw = await this.deps.relay.execute<unknown>(
        this.deps.workspaceId,
        "get_keepouts",
        {}
      );
      const obj = isRecord(raw) ? raw : {};
      // Treat both `unsupported: true` (extension flagged the API
      // as missing) and a missing `items` array as supported:false.
      if (obj.unsupported === true) {
        return notSupported(
          "EasyEDA Pro keepout API is not yet exposed in this extension version. Spike question #4 (Sprint 9) is open: pcb_PrimitiveRegion is the suspected carrier but [NEEDS HANDS-ON] confirmation. The Altium half of get_keepouts works today."
        );
      }
      const itemsRaw = Array.isArray(obj.items) ? obj.items : null;
      if (!itemsRaw) {
        return notSupported(
          "EasyEDA extension returned a get_keepouts result without an `items` array."
        );
      }
      const items: Keepout[] = itemsRaw.flatMap((entry) => {
        if (!isRecord(entry)) return [];
        const props = isRecord(entry.properties) ? entry.properties : {};
        const id =
          typeof entry.id === "string"
            ? entry.id
            : typeof entry.uuid === "string"
              ? entry.uuid
              : "";
        if (!id) return [];
        // Kind / layer fields might live under top-level or properties
        // depending on Pro version. Defensive extraction with
        // normalization to the cross-platform union.
        const kindRaw =
          typeof entry.kind === "string"
            ? entry.kind
            : typeof entry.type === "string"
              ? entry.type
              : typeof props.kind === "string"
                ? (props.kind as string)
                : undefined;
        const layerRaw =
          typeof entry.layer === "string"
            ? entry.layer
            : typeof props.layer === "string"
              ? (props.layer as string)
              : undefined;
        const verticesRaw =
          Array.isArray(entry.vertices)
            ? entry.vertices
            : Array.isArray(entry.points)
              ? entry.points
              : Array.isArray(props.vertices)
                ? (props.vertices as unknown[])
                : [];
        return [
          {
            id,
            kind: normalizeKeepoutKind(kindRaw),
            layer: normalizeKeepoutLayer(layerRaw),
            vertices: extractVertices(verticesRaw),
            raw: entry,
          },
        ];
      });
      return ok(items);
    } catch (err) {
      return notSupported(err instanceof Error ? err.message : String(err));
    }
  }

  async listPcbComponents(
    params: PaginationParams
  ): Promise<PlatformResponse<Page<PcbComponent>>> {
    if (!this.deps.relay || !this.deps.workspaceId) {
      return notSupported(NO_BRIDGE_REASON);
    }
    const offset = Math.max(0, Math.floor(params.offset ?? 0));
    const limit = Math.min(500, Math.max(1, Math.floor(params.limit ?? 200)));
    try {
      const raw = await this.deps.relay.execute<unknown>(
        this.deps.workspaceId,
        "list_pcb_components",
        { offset, limit }
      );
      // Extension returns
      //   { items: Array<rawComponent>, total: number }
      // where rawComponent is whatever
      // `eda.pcb_PrimitiveComponent.get(ids)` returns. Footprint is
      // the universal cross-platform PCB-side identifier (Altium
      // calls it Footprint; EasyEDA calls it footprint or
      // libraryReference). Spike question #4 flagged the exact
      // field names need hands-on confirmation, so extraction
      // mirrors schematic — top-level first, then properties
      // fallback, raw preserved.
      const obj = isRecord(raw) ? raw : {};
      const itemsRaw = Array.isArray(obj.items) ? obj.items : null;
      const total = typeof obj.total === "number" ? obj.total : undefined;
      if (!itemsRaw) {
        return notSupported(
          "EasyEDA extension returned a list_pcb_components result without an `items` array."
        );
      }
      const items: PcbComponent[] = itemsRaw.flatMap((entry) => {
        if (!isRecord(entry)) return [];
        const primitiveId =
          typeof entry.primitiveId === "string" ? entry.primitiveId : "";
        if (!primitiveId) return [];
        const props = isRecord(entry.properties) ? entry.properties : {};
        const designator =
          typeof entry.designator === "string"
            ? entry.designator
            : typeof props.designator === "string"
              ? (props.designator as string)
              : "";
        const footprint =
          typeof entry.footprint === "string"
            ? entry.footprint
            : typeof props.footprint === "string"
              ? (props.footprint as string)
              : "";
        return [{ primitiveId, designator, footprint, raw: entry }];
      });
      // Pagination math identical to listSchematicComponents — see
      // PR 10.3a for the rationale on the total-known vs
      // total-unknown branches.
      let nextOffset: number | null;
      if (total !== undefined) {
        nextOffset =
          offset + items.length < total ? offset + items.length : null;
      } else {
        nextOffset =
          items.length === limit ? offset + items.length : null;
      }
      return ok({ items, nextOffset, total });
    } catch (err) {
      return notSupported(err instanceof Error ? err.message : String(err));
    }
  }

  async listLibraryComponents(
    params: ListLibraryComponentsParams
  ): Promise<PlatformResponse<Page<LibraryComponent>>> {
    if (!this.deps.relay || !this.deps.workspaceId) {
      return notSupported(NO_BRIDGE_REASON);
    }
    const offset = Math.max(0, Math.floor(params.offset ?? 0));
    const limit = Math.min(500, Math.max(1, Math.floor(params.limit ?? 200)));
    const enrichWithLcsc = params.enrichWithLcsc ?? true;
    try {
      const raw = await this.deps.relay.execute<unknown>(
        this.deps.workspaceId,
        "list_library_components",
        { offset, limit }
      );
      // Extension returns
      //   { items: Array<lib_Device entry>, total: number }
      // where each entry's exact field set isn't fully spelled out
      // in pro-api-types. Defensive extraction mirrors 10.3a/b.
      const obj = isRecord(raw) ? raw : {};
      const itemsRaw = Array.isArray(obj.items) ? obj.items : null;
      const total = typeof obj.total === "number" ? obj.total : undefined;
      if (!itemsRaw) {
        return notSupported(
          "EasyEDA extension returned a list_library_components result without an `items` array."
        );
      }
      const baseItems: LibraryComponent[] = itemsRaw.flatMap((entry) => {
        if (!isRecord(entry)) return [];
        const props = isRecord(entry.properties) ? entry.properties : {};
        const id =
          typeof entry.uuid === "string"
            ? entry.uuid
            : typeof entry.id === "string"
              ? entry.id
              : "";
        if (!id) return [];
        const name =
          typeof entry.name === "string" ? entry.name : id || "(unknown)";
        const description =
          typeof entry.description === "string" ? entry.description : undefined;
        const footprint =
          typeof entry.footprint === "string"
            ? entry.footprint
            : typeof props.footprint === "string"
              ? (props.footprint as string)
              : undefined;
        const manufacturer =
          typeof entry.manufacturer === "string"
            ? entry.manufacturer
            : typeof props.manufacturer === "string"
              ? (props.manufacturer as string)
              : undefined;
        const mpn =
          typeof entry.manufacturerPartNumber === "string"
            ? entry.manufacturerPartNumber
            : typeof entry.mpn === "string"
              ? entry.mpn
              : typeof props.mpn === "string"
                ? (props.mpn as string)
                : undefined;
        // EasyEDA exposes LCSC IDs under a few key names depending
        // on entry vintage. Check the common ones; extracted but
        // not parsed further here.
        const lcscId =
          typeof entry.lcscId === "string"
            ? entry.lcscId
            : typeof entry.lcsc_id === "string"
              ? (entry.lcsc_id as string)
              : typeof props.lcscId === "string"
                ? (props.lcscId as string)
                : typeof props.lcsc_id === "string"
                  ? (props.lcsc_id as string)
                  : undefined;
        const lifecycle =
          typeof entry.lifecycle === "string" ? entry.lifecycle : undefined;
        return [
          {
            id,
            name,
            description,
            footprint,
            manufacturer,
            mpn,
            lcscId,
            lifecycle,
            raw: entry,
          },
        ];
      });
      const items =
        enrichWithLcsc && this.deps.nexar
          ? await enrichWithOctopart(this.deps.nexar, baseItems)
          : baseItems;
      let nextOffset: number | null;
      if (total !== undefined) {
        nextOffset =
          offset + items.length < total ? offset + items.length : null;
      } else {
        nextOffset =
          items.length === limit ? offset + items.length : null;
      }
      return ok({ items, nextOffset, total });
    } catch (err) {
      return notSupported(err instanceof Error ? err.message : String(err));
    }
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

  async runDrc(): Promise<PlatformResponse<DrcResult>> {
    if (!this.deps.relay || !this.deps.workspaceId) {
      return notSupported(NO_BRIDGE_REASON);
    }
    try {
      // Sprint 13 PR 13.2: extension calls
      // pcb_Drc.check(strict=true, userInterface=false,
      // includeVerboseError=true) and returns the verbose-error
      // array. Server parses via parseEasyedaDrcArray (shape
      // [NEEDS HANDS-ON] per spike — defensive extraction).
      const raw = await this.deps.relay.execute<unknown>(
        this.deps.workspaceId,
        "run_drc",
        {}
      );
      const violations = parseEasyedaDrcArray(raw);
      return ok(summarizeDrc(violations));
    } catch (err) {
      return notSupported(err instanceof Error ? err.message : String(err));
    }
  }

  async getMessages(): Promise<PlatformResponse<PlatformMessage[]>> {
    if (!this.deps.relay || !this.deps.workspaceId) {
      return notSupported(NO_BRIDGE_REASON);
    }
    try {
      // Semantic note: on Altium, "Messages" is read from the
      // accumulated Messages-panel state — populated by prior DRC /
      // ERC / compile runs. EasyEDA Pro doesn't expose that
      // accumulated state via a single API, so the extension's
      // get_messages handler ACTIVELY runs sch_Drc.check + pcb_Drc.check
      // and returns their combined output. AI clients call it the
      // same way ("what's wrong with this design?") and get the same
      // logical answer; the latency is higher on EasyEDA because the
      // DRC engine runs synchronously per call.
      const raw = await this.deps.relay.execute<unknown>(
        this.deps.workspaceId,
        "get_messages",
        {}
      );
      const obj = isRecord(raw) ? raw : {};
      const list = Array.isArray(obj.messages) ? obj.messages : null;
      if (!list) {
        return notSupported(
          "EasyEDA extension returned a get_messages result without a `messages` array."
        );
      }
      const messages: PlatformMessage[] = list.flatMap(
        (entry): PlatformMessage[] => {
          if (!isRecord(entry)) return [];
          // EasyEDA's DRC engine returns mixed shapes across rule
          // categories. Best-effort: pull severity from a few common
          // keys (severity / level / type), normalize to the
          // PlatformMessage union, fall back to "unknown" rather
          // than dropping the entry.
          const sevRaw = String(
            entry.severity ?? entry.level ?? entry.type ?? "unknown"
          ).toLowerCase();
          const severity: PlatformMessage["severity"] =
            sevRaw === "info" ||
            sevRaw === "warning" ||
            sevRaw === "warn" ||
            sevRaw === "error"
              ? sevRaw === "warn"
                ? "warning"
                : sevRaw
              : "unknown";
          return [
            {
              severity,
              source:
                typeof entry.source === "string" ? entry.source : "",
              text:
                typeof entry.message === "string"
                  ? entry.message
                  : typeof entry.text === "string"
                    ? entry.text
                    : typeof entry.description === "string"
                      ? entry.description
                      : "",
              document:
                typeof entry.document === "string"
                  ? entry.document
                  : undefined,
            },
          ];
        }
      );
      return ok(messages);
    } catch (err) {
      return notSupported(err instanceof Error ? err.message : String(err));
    }
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Cross-reference each LibraryComponent with Octopart via Nexar's
 * supSearchMpn. Looks up by MPN when present, falls back to LCSC ID
 * (which EasyEDA Pro entries usually carry as a searchable token).
 *
 * Failures are silent — a missing/throwing lookup leaves the entry's
 * `octopart` undefined rather than failing the whole page. The whole
 * point of enrichment is "more info if we can get it", not a hard
 * dependency.
 *
 * Concurrency cap: 5 in flight to avoid hammering Nexar on a 200-item
 * page. Sequential would be too slow (~1s/item × 200 = 3+ minutes,
 * past the relay's HTTP budget). Unbounded parallel risks Nexar rate
 * limits + hot-path token refresh.
 */
async function enrichWithOctopart(
  nexar: NexarService,
  items: LibraryComponent[]
): Promise<LibraryComponent[]> {
  const CONCURRENCY = 5;
  const out: LibraryComponent[] = items.slice();
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < out.length) {
      const i = cursor++;
      const entry = out[i];
      const lookupKey = entry.mpn || entry.lcscId;
      if (!lookupKey) continue;
      try {
        const results = await nexar.searchParts(lookupKey, 1);
        if (results.length === 0) continue;
        const r = results[0];
        out[i] = {
          ...entry,
          octopart: {
            mpn: r.mpn,
            manufacturer: r.manufacturer,
            description: r.description,
            offers: r.offers.map((o) => ({
              supplier: o.supplier,
              stock: o.stock,
              moq: o.moq,
              sku: o.sku,
            })),
          },
        };
      } catch {
        // Lookup failed — leave entry as-is. The contract is
        // "octopart undefined" → "we couldn't enrich this one",
        // distinct from "no offers found" which would be
        // octopart: {... offers: []}.
      }
    }
  }
  const workers = Array.from({ length: Math.min(CONCURRENCY, out.length) }, worker);
  await Promise.all(workers);
  return out;
}
