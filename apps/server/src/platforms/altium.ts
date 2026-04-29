/**
 * `AltiumPlatform` — `Platform` implementation for Altium workspaces.
 *
 * Wraps the existing AD relay handlers (`apps/server/src/handlers/altium.ts`)
 * and Nexar service. Each method maps to a real call on the relay
 * when it's connected, and returns `{supported: false, reason}` when
 * the relay isn't reachable — the AI client / caller gets a typed
 * signal rather than an exception. Sprint 9 PR 9.4 adds the EasyEDA
 * counterpart; Sprints 10+ add new methods to both side-by-side.
 *
 * What this PR does NOT do: refactor existing `ad_*` tool registrations
 * (in `apps/server/src/tools/altium.ts`). Those legacy tools keep
 * calling the handlers directly. New cross-platform tools landing in
 * Sprint 10+ go through `Platform`; the legacy tools coexist until
 * each one is replaced.
 */

import * as adHandlers from "../handlers/altium.js";
import type { AdRelay } from "../ad-relay/relay.js";
import type { NexarService } from "../services/nexar.js";
import {
  notSupported,
  ok,
  type ActiveProject,
  type DrcSummary,
  type LibraryComponent,
  type ListLibraryComponentsParams,
  type MutateResult,
  type DesignRule,
  type Keepout,
  type NetRouting,
  type RouteDiffPairResult,
  type SetRouteRuleParams,
  type UnrouteResult,
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
import { validateComponents, DEFAULT_SPACING_MM } from "./placement-validation.js";
import { placeByGroupShared } from "./place-by-group.js";

export interface AltiumPlatformDeps {
  /** Local Altium Designer relay (HTTP long-poll bridge). Optional —
   *  when absent / disconnected, methods that need it return
   *  `{supported: false, reason: "ad relay not connected"}`. */
  relay: AdRelay | null;
  /** Per-workspace Nexar/Octopart client for cloud-side reads. */
  nexar: NexarService | null;
  /**
   * The workspace's stored Altium 365 URL. Required for
   * cloud-only reads like `listProjects` (Nexar's
   * `desProjects(workspaceUrl)`). Null on the stdio path when
   * the env doesn't set ALTIUM_WORKSPACE_URL, or on workspaces
   * that haven't configured one. Methods that need it return
   * `{supported: false}` with a clear reason rather than throw.
   */
  altiumWorkspaceUrl: string | null;
}

const RELAY_DISCONNECTED =
  "Altium Designer relay is not connected. Open AD with AltiumRelay.js loaded and try again.";

const NO_WORKSPACE_URL =
  "Workspace has no Altium 365 URL configured. Add one in Settings → Workspaces; this tool reads from Altium 365's cloud API.";

const NO_NEXAR =
  "Workspace has no Nexar credentials configured. Add them in Settings → Workspaces.";

export class AltiumPlatform implements Platform {
  readonly name = "altium" as const;

  constructor(private readonly deps: AltiumPlatformDeps) {}

  async getActiveProject(): Promise<PlatformResponse<ActiveProject>> {
    if (!this.deps.relay || !this.deps.relay.status().connected) {
      return notSupported(RELAY_DISCONNECTED);
    }
    try {
      const raw = await adHandlers.adGetActiveProject(this.deps.relay);
      // Best-effort: pull a name + id out of whatever the relay
      // returned. Stays loose because the AD-side payload shape
      // hasn't been stabilized at the type system level yet —
      // Sprint 10 PR 10.2 will tighten this.
      const obj = isRecord(raw) ? raw : {};
      const name =
        typeof obj.name === "string"
          ? obj.name
          : typeof obj.path === "string"
            ? String(obj.path)
            : "(unknown)";
      const id =
        typeof obj.id === "string"
          ? obj.id
          : typeof obj.path === "string"
            ? String(obj.path)
            : name;
      return ok({ id, name, raw });
    } catch (err) {
      return notSupported(errorReason(err));
    }
  }

  async listProjects(): Promise<PlatformResponse<ProjectListEntry[]>> {
    // Cloud read — uses Nexar's desProjects(workspaceUrl), no AD
    // relay needed. The workspace url is stored per-workspace by
    // Sprint 2 PR 2.2; on stdio it comes from ALTIUM_WORKSPACE_URL.
    if (!this.deps.nexar) return notSupported(NO_NEXAR);
    if (!this.deps.altiumWorkspaceUrl) return notSupported(NO_WORKSPACE_URL);
    try {
      const projects = await this.deps.nexar.listProjects(
        this.deps.altiumWorkspaceUrl
      );
      return ok(
        projects.map((p) => ({ id: p.id, name: p.name, raw: p }))
      );
    } catch (err) {
      return notSupported(errorReason(err));
    }
  }

  async listSchematicComponents(
    _params: PaginationParams
  ): Promise<PlatformResponse<Page<SchematicComponent>>> {
    // Altium-side schematic introspection needs a new AD relay
    // command (and a corresponding handler in AltiumRelay.js) that
    // walks DM_Project / SchDoc objects. That cross-stack work
    // didn't fit in PR 10.3a — surfaces as a stable, actionable
    // reason the AI client can render. Sprint 11+ adds it.
    return notSupported(
      "Schematic component listing isn't yet wired up on the Altium side. The AD relay needs a new command for DM_Project / SchDoc introspection; tracking as a Sprint 11 follow-up. The same tool already works on EasyEDA workspaces."
    );
  }

  async listLibraryComponents(
    params: ListLibraryComponentsParams
  ): Promise<PlatformResponse<Page<LibraryComponent>>> {
    if (!this.deps.nexar) return notSupported(NO_NEXAR);
    if (!this.deps.altiumWorkspaceUrl) return notSupported(NO_WORKSPACE_URL);
    const offset = Math.max(0, Math.floor(params.offset ?? 0));
    const limit = Math.min(500, Math.max(1, Math.floor(params.limit ?? 200)));
    try {
      // Nexar's desLibrary returns the full library in one shot. We
      // slice in-memory for pagination — fine for libraries up to a
      // few thousand parts; pushing offset/limit into the GraphQL is
      // a future optimization for 10k+-part workspaces.
      const all = await this.deps.nexar.listComponents(
        this.deps.altiumWorkspaceUrl
      );
      const total = all.length;
      const slice = all.slice(offset, offset + limit);
      const items: LibraryComponent[] = slice.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        // Altium 365's desLibrary doesn't carry a flat footprint /
        // mpn / lcscId at this level — those live under designItemId
        // / parameters. Surface what we have via raw; the EasyEDA
        // side fills in the richer fields.
        lifecycle: c.lifecycle?.state,
        raw: c,
      }));
      const nextOffset = offset + items.length < total ? offset + items.length : null;
      return ok({ items, nextOffset, total });
    } catch (err) {
      return notSupported(errorReason(err));
    }
  }

  async getComponents(
    params: PaginationParams
  ): Promise<PlatformResponse<Page<PlacedComponent>>> {
    if (!this.deps.relay || !this.deps.relay.status().connected) {
      return notSupported(RELAY_DISCONNECTED);
    }
    const offset = Math.max(0, Math.floor(params.offset ?? 0));
    const limit = Math.min(500, Math.max(1, Math.floor(params.limit ?? 200)));
    try {
      // The AD relay's get_components command walks BoardIterator over
      // eComponentObject and returns coordinates already converted to
      // mm — see ad-script/AltiumRelay.js: CmdGetComponents. Layer
      // values come back as raw AD layer names; normalize to the
      // cross-platform union here.
      const raw = await this.deps.relay.execute<unknown>(
        "get_components",
        { offset, limit }
      );
      const obj = isRecord(raw) ? raw : {};
      const itemsRaw = Array.isArray(obj.items) ? obj.items : null;
      const total = typeof obj.total === "number" ? obj.total : undefined;
      if (!itemsRaw) {
        return notSupported(
          "AD relay returned a get_components result without an `items` array. Update AltiumRelay.js to the version shipped with Sprint 11 PR 11.1."
        );
      }
      const items: PlacedComponent[] = itemsRaw.flatMap((entry) => {
        if (!isRecord(entry)) return [];
        const primitiveId =
          typeof entry.primitiveId === "string" ? entry.primitiveId : "";
        if (!primitiveId) return [];
        return [
          {
            primitiveId,
            designator:
              typeof entry.designator === "string" ? entry.designator : "",
            mpn: typeof entry.mpn === "string" ? entry.mpn : "",
            footprint:
              typeof entry.footprint === "string" ? entry.footprint : "",
            x: typeof entry.x === "number" ? entry.x : 0,
            y: typeof entry.y === "number" ? entry.y : 0,
            layer: normalizeLayer(entry.layer),
            rotation:
              typeof entry.rotation === "number" ? entry.rotation : 0,
            locked: entry.locked === true,
            // Sprint 11 PR 11.4: bounding box for validatePlacement.
            // 0 means the AD relay couldn't extract — the validator
            // falls back to a 1mm heuristic and flags the result as
            // approximate.
            width: typeof entry.width === "number" ? entry.width : 0,
            height: typeof entry.height === "number" ? entry.height : 0,
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
      return notSupported(errorReason(err));
    }
  }

  async moveComponent(params: {
    designator: string;
    x: number;
    y: number;
  }): Promise<PlatformResponse<MutateResult>> {
    if (!this.deps.relay || !this.deps.relay.status().connected) {
      return notSupported(RELAY_DISCONNECTED);
    }
    try {
      // AltiumRelay.js's move_component does the BoardIterator walk +
      // designator match + multi-match guard + locked-guard. Server
      // just relays the params and consumes the confirmation message.
      const raw = await this.deps.relay.execute<{ message?: unknown }>(
        "move_component",
        params
      );
      return ok(makeMutateResult(params.designator, raw, "Moved"));
    } catch (err) {
      return notSupported(errorReason(err));
    }
  }

  async rotateComponent(params: {
    designator: string;
    rotation: number;
  }): Promise<PlatformResponse<MutateResult>> {
    if (!this.deps.relay || !this.deps.relay.status().connected) {
      return notSupported(RELAY_DISCONNECTED);
    }
    try {
      const raw = await this.deps.relay.execute<{ message?: unknown }>(
        "rotate_component",
        params
      );
      return ok(makeMutateResult(params.designator, raw, "Rotated"));
    } catch (err) {
      return notSupported(errorReason(err));
    }
  }

  async lockComponent(params: {
    designator: string;
    locked: boolean;
  }): Promise<PlatformResponse<MutateResult>> {
    if (!this.deps.relay || !this.deps.relay.status().connected) {
      return notSupported(RELAY_DISCONNECTED);
    }
    try {
      const raw = await this.deps.relay.execute<{ message?: unknown }>(
        "lock_component",
        params
      );
      return ok(makeMutateResult(params.designator, raw, params.locked ? "Locked" : "Unlocked"));
    } catch (err) {
      return notSupported(errorReason(err));
    }
  }

  async validatePlacement(params: {
    spacingMm?: number;
  }): Promise<PlatformResponse<ValidatePlacementResult>> {
    // Read state via getComponents — validation is purely server-side
    // from there, so any platform that implements getComponents
    // automatically supports validatePlacement. Surfaces the
    // upstream supported:false reason verbatim when getComponents
    // can't run.
    const components = await this.getAllComponentsForValidation();
    if (!components.supported) return components;
    const spacingMm = params.spacingMm ?? DEFAULT_SPACING_MM;
    return ok(validateComponents(components.data, spacingMm));
  }

  /**
   * Helper: page through getComponents until exhausted, returning
   * the full set. Validation needs every component on the board,
   * not just one page. Caps at 5000 components to avoid pathological
   * cases — at that point validation latency dwarfs paging cost,
   * and an O(n²) check on 5000 parts is 12.5M pairs.
   */
  private async getAllComponentsForValidation(): Promise<
    PlatformResponse<PlacedComponent[]>
  > {
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
    return ok(all);
  }

  async placeByGroup(
    params: PlaceByGroupParams
  ): Promise<PlatformResponse<PlaceByGroupResult>> {
    return placeByGroupShared(this, params);
  }

  async getDesignRules(): Promise<PlatformResponse<DesignRule[]>> {
    if (!this.deps.relay || !this.deps.relay.status().connected) {
      return notSupported(RELAY_DISCONNECTED);
    }
    try {
      const raw = await this.deps.relay.execute<unknown>("get_design_rules", {});
      const obj = isRecord(raw) ? raw : {};
      const itemsRaw = Array.isArray(obj.items) ? obj.items : null;
      if (!itemsRaw) {
        return notSupported(
          "AD relay returned a get_design_rules result without an `items` array. Update AltiumRelay.js to the version shipped with Sprint 12 PR 12.2."
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
      return notSupported(errorReason(err));
    }
  }

  async setRouteRule(
    params: SetRouteRuleParams
  ): Promise<PlatformResponse<MutateResult>> {
    if (!this.deps.relay || !this.deps.relay.status().connected) {
      return notSupported(RELAY_DISCONNECTED);
    }
    try {
      // Server passes the full discriminated-union envelope through;
      // AltiumRelay.js dispatches on `kind` to call the right
      // DesignRules setter.
      const raw = await this.deps.relay.execute<{ message?: unknown }>(
        "set_route_rule",
        params as unknown as Record<string, unknown>
      );
      return ok(makeMutateResult(params.name, raw, "Updated"));
    } catch (err) {
      return notSupported(errorReason(err));
    }
  }

  async unrouteNet(params: {
    net: string;
  }): Promise<PlatformResponse<UnrouteResult>> {
    if (!this.deps.relay || !this.deps.relay.status().connected) {
      return notSupported(RELAY_DISCONNECTED);
    }
    try {
      // AltiumRelay.js's unroute_net does the BoardIterator walk +
      // locked-guard + per-object delete. Server stays out of
      // routing/AD-object math; just consumes the count envelope.
      const raw = await this.deps.relay.execute<unknown>(
        "unroute_net",
        params as unknown as Record<string, unknown>
      );
      return ok(buildUnrouteResult(params.net, raw));
    } catch (err) {
      return notSupported(errorReason(err));
    }
  }

  async routeDiffPair(params: {
    positiveNet: string;
    negativeNet: string;
  }): Promise<PlatformResponse<RouteDiffPairResult>> {
    if (!this.deps.relay || !this.deps.relay.status().connected) {
      return notSupported(RELAY_DISCONNECTED);
    }
    try {
      // AltiumRelay.js's route_diff_pair invokes the AD process
      // for diff-pair routing. Server consumes the {routed,
      // totalLengthMm, message} envelope. Diff pair MUST be
      // declared first — relay errors out with the diff-pair
      // editor reference if not.
      const raw = await this.deps.relay.execute<unknown>(
        "route_diff_pair",
        params as unknown as Record<string, unknown>
      );
      return ok(
        buildRouteDiffPairResult(params.positiveNet, params.negativeNet, raw)
      );
    } catch (err) {
      return notSupported(errorReason(err));
    }
  }

  async getNetRouting(
    params: PaginationParams
  ): Promise<PlatformResponse<Page<NetRouting>>> {
    if (!this.deps.relay || !this.deps.relay.status().connected) {
      return notSupported(RELAY_DISCONNECTED);
    }
    const offset = Math.max(0, Math.floor(params.offset ?? 0));
    const limit = Math.min(500, Math.max(1, Math.floor(params.limit ?? 200)));
    try {
      const raw = await this.deps.relay.execute<unknown>(
        "get_net_routing",
        { offset, limit }
      );
      const obj = isRecord(raw) ? raw : {};
      const itemsRaw = Array.isArray(obj.items) ? obj.items : null;
      const total = typeof obj.total === "number" ? obj.total : undefined;
      if (!itemsRaw) {
        return notSupported(
          "AD relay returned a get_net_routing result without an `items` array. Update AltiumRelay.js to the version shipped with Sprint 12 PR 12.1."
        );
      }
      const items: NetRouting[] = itemsRaw.flatMap((entry) => {
        if (!isRecord(entry)) return [];
        const netName = typeof entry.netName === "string" ? entry.netName : "";
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
      return notSupported(errorReason(err));
    }
  }

  async getKeepouts(): Promise<PlatformResponse<Keepout[]>> {
    if (!this.deps.relay || !this.deps.relay.status().connected) {
      return notSupported(RELAY_DISCONNECTED);
    }
    try {
      const raw = await this.deps.relay.execute<unknown>("get_keepouts", {});
      const obj = isRecord(raw) ? raw : {};
      const itemsRaw = Array.isArray(obj.items) ? obj.items : null;
      if (!itemsRaw) {
        return notSupported(
          "AD relay returned a get_keepouts result without an `items` array. Update AltiumRelay.js to the version shipped with Sprint 11 PR 11.3."
        );
      }
      const items: Keepout[] = itemsRaw.flatMap((entry) => {
        if (!isRecord(entry)) return [];
        const id = typeof entry.id === "string" ? entry.id : "";
        if (!id) return [];
        return [
          {
            id,
            kind: normalizeKeepoutKind(entry.kind),
            layer: normalizeKeepoutLayer(entry.layer),
            vertices: extractVertices(entry.vertices),
            raw: entry,
          },
        ];
      });
      return ok(items);
    } catch (err) {
      return notSupported(errorReason(err));
    }
  }

  async listPcbComponents(
    _params: PaginationParams
  ): Promise<PlatformResponse<Page<PcbComponent>>> {
    // Same shape as listSchematicComponents above: AltiumRelay.js
    // needs a new command that walks BoardIterator / eComponentObject
    // and returns the basic-BOM fields (designator + footprint).
    // Sprint 11 PR 11.1 (`get_components`) extends this with the full
    // placement payload and is when the AD relay extension will land.
    return notSupported(
      "PCB component listing isn't yet wired up on the Altium side. The AD relay needs a new BoardIterator / eComponentObject walk; Sprint 11 PR 11.1 ships it alongside the placement-data tool. The same tool already works on EasyEDA workspaces."
    );
  }

  async screenshot(): Promise<PlatformResponse<ScreenshotResult>> {
    // adScreenshot uses PowerShell + System.Drawing locally — no relay
    // needed. So this works whether the relay is connected or not, as
    // long as Altium Designer's main window is detectable on the host.
    try {
      const result = await adHandlers.adScreenshot({
        target: "window",
        maxWidth: 1600,
      });
      // The handler returns an MCP content array. Pull the image out
      // and return a flat shape — the cross-platform tool wrapper in
      // Sprint 10 PR 10.1 wraps it back into MCP shape itself.
      const image = result.content.find((c) => c.type === "image");
      if (!image || image.type !== "image") {
        return notSupported(
          "Screenshot succeeded but produced no image — likely a PowerShell stderr-only result."
        );
      }
      return ok({
        base64Png: image.data,
        byteLength: Math.floor((image.data.length * 3) / 4),
      });
    } catch (err) {
      return notSupported(errorReason(err));
    }
  }

  async runDrc(): Promise<PlatformResponse<DrcSummary>> {
    if (!this.deps.relay || !this.deps.relay.status().connected) {
      return notSupported(RELAY_DISCONNECTED);
    }
    try {
      const raw = await adHandlers.adRunDrc(this.deps.relay, {
        returnViolations: true,
      });
      // The legacy `ad_run_drc` returns whatever Altium posts back.
      // For Sprint 9 we surface it as `ok: true` if the call didn't
      // throw — Sprint 13 PR 13.2 introduces structured violation
      // enumeration and tightens this.
      return ok({ ok: true, raw });
    } catch (err) {
      return notSupported(errorReason(err));
    }
  }

  async getMessages(): Promise<PlatformResponse<PlatformMessage[]>> {
    if (!this.deps.relay || !this.deps.relay.status().connected) {
      return notSupported(RELAY_DISCONNECTED);
    }
    try {
      const raw = await adHandlers.adGetMessages(this.deps.relay, {
        limit: 200,
        minLevel: "info",
      });
      // adGetMessages returns an unknown shape today; best-effort map
      // to the cross-platform shape. EasyEDA's `pcb_Drc.check(verbose)`
      // returns a different shape — Sprint 13 PR 13.2 will normalize.
      const messages: PlatformMessage[] = isRecord(raw)
        ? extractMessages(raw)
        : [];
      return ok(messages);
    } catch (err) {
      return notSupported(errorReason(err));
    }
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Sprint 12 PR 12.4: build a RouteDiffPairResult from a relay or
 * extension payload. Defensive extraction:
 *   - `routed`: defaults false; only true when the relay/extension
 *     explicitly reports success. Treats missing/non-boolean as
 *     "couldn't tell, assume not routed" so AI clients err on the
 *     side of retry-or-investigate rather than declaring success.
 *   - `totalLengthMm`: defaults 0 when missing/non-numeric.
 *   - `message`: synthesized from the routed flag + length when
 *     the relay/extension didn't supply one (older relay version
 *     compatibility).
 *
 * Exported because both AltiumPlatform and EasyedaPlatform share
 * the result-shape contract — single-source so the two impls
 * can't drift on what AI clients see.
 */
export function buildRouteDiffPairResult(
  positiveNet: string,
  negativeNet: string,
  raw: unknown
): RouteDiffPairResult {
  const obj = isRecord(raw) ? raw : {};
  const routed = obj.routed === true;
  const totalLengthMm =
    typeof obj.totalLengthMm === "number" ? obj.totalLengthMm : 0;
  const message =
    typeof obj.message === "string"
      ? obj.message
      : routed
        ? `Routed diff pair (${positiveNet}, ${negativeNet}): ${totalLengthMm.toFixed(2)}mm total trace.`
        : `Diff pair router ran but produced no traces for (${positiveNet}, ${negativeNet}). Try adjusting layer / spacing rules and retry.`;
  return {
    positiveNet,
    negativeNet,
    routed,
    totalLengthMm,
    message,
  };
}

/**
 * Sprint 12 PR 12.3: build an UnrouteResult from a relay/extension
 * payload. Defensive extraction with sensible defaults — the
 * platforms send count fields directly, but if any are missing or
 * non-numeric we treat them as 0 rather than dropping the whole
 * result. Constructs a fallback message when the relay didn't
 * supply one (older relay version, malformed extension response).
 *
 * Exported because both AltiumPlatform and EasyedaPlatform call it
 * — keeps the count + message format single-sourced so the two
 * platforms can't drift on what AI clients see.
 */
export function buildUnrouteResult(
  net: string,
  raw: unknown
): UnrouteResult {
  const obj = isRecord(raw) ? raw : {};
  const deletedTraces =
    typeof obj.deletedTraces === "number" ? Math.floor(obj.deletedTraces) : 0;
  const deletedVias =
    typeof obj.deletedVias === "number" ? Math.floor(obj.deletedVias) : 0;
  const skippedLocked =
    typeof obj.skippedLocked === "number" ? Math.floor(obj.skippedLocked) : 0;
  const message =
    typeof obj.message === "string"
      ? obj.message
      : deletedTraces + deletedVias === 0 && skippedLocked === 0
        ? `No traces or vias on net '${net}' — already unrouted or doesn't exist.`
        : `Unrouted '${net}': deleted ${deletedTraces} trace(s), ${deletedVias} via(s)${skippedLocked > 0 ? `, ${skippedLocked} locked skipped` : ""}.`;
  return { net, deletedTraces, deletedVias, skippedLocked, message };
}

/**
 * Sprint 12 PR 12.2: collapse Altium's many DesignRules categories
 * (Clearance, Width, RoutingVias, RoutingTracksDirection, etc.) and
 * EasyEDA's drc-config rule types into the four cross-platform
 * cases AI clients reason about: clearance, width, via, other.
 *
 * Anything we don't recognize falls through to "other" with the
 * raw payload preserved — readers that need finer granularity can
 * dig into `raw`. Exported because both platforms call it.
 */
export function normalizeRuleKind(
  raw: unknown
): "clearance" | "width" | "via" | "other" {
  if (typeof raw !== "string") return "other";
  const s = raw.toLowerCase();
  // Order matters: check "via" first since "viawidth"-style names
  // would otherwise match the "width" branch below.
  if (s.includes("via") || s.includes("hole")) return "via";
  if (s.includes("clearance") || s.includes("gap")) return "clearance";
  if (s.includes("width") || s.includes("trackwidth")) return "width";
  return "other";
}

/**
 * Sprint 12 PR 12.2: extract a cross-platform DesignRule from a
 * raw relay/extension entry. Per-field accessors handle the kind-
 * specific value shapes; missing fields stay undefined rather than
 * defaulting to 0 (which would lie about the rule's actual contents).
 *
 * Exported because both platforms call it after their own preliminary
 * extraction — keeps the kind normalization + scope normalization
 * single-sourced.
 */
export function normalizeDesignRule(
  entry: Record<string, unknown>,
  name: string
): DesignRule {
  const kind = normalizeRuleKind(entry.kind ?? entry.type ?? entry.category);
  // Scope can be expressed as a flat string ("All", "Net=VCC",
  // "NetClass=Power", or AD's DSL "InNet('VCC')" / "InNetClass('Power')")
  // or a structured object. Extract defensively for both.
  let scope: DesignRule["scope"] = { type: "all" };
  const scopeRaw = entry.scope;
  if (typeof scopeRaw === "string") {
    const trimmed = scopeRaw.trim();
    // AD DSL: InNet('VCC') / InNetClass('Power'). Quotes optional.
    const adNet = /^InNet\s*\(\s*['"]?([^'")]+)['"]?\s*\)$/i.exec(trimmed);
    const adCls = /^InNetClass\s*\(\s*['"]?([^'")]+)['"]?\s*\)$/i.exec(trimmed);
    // Simple key=value: net=VCC / netclass=Power.
    const kv = /^(net|netclass|net-class)\s*=\s*(.+)$/i.exec(trimmed);
    if (adNet) {
      scope = { type: "net", target: adNet[1].trim() };
    } else if (adCls) {
      scope = { type: "net-class", target: adCls[1].trim() };
    } else if (kv) {
      scope = {
        type: kv[1].toLowerCase() === "net" ? "net" : "net-class",
        target: kv[2].trim(),
      };
    }
  } else if (isRecord(scopeRaw)) {
    const t = String(scopeRaw.type ?? "").toLowerCase();
    if (t === "net" || t === "net-class" || t === "netclass") {
      scope = {
        type: t === "net" ? "net" : "net-class",
        target:
          typeof scopeRaw.target === "string"
            ? scopeRaw.target
            : typeof scopeRaw.name === "string"
              ? (scopeRaw.name as string)
              : undefined,
      };
    }
  }
  const result: DesignRule = { name, kind, scope, raw: entry };
  if (kind === "clearance") {
    if (typeof entry.clearanceMm === "number") {
      result.clearanceMm = entry.clearanceMm;
    }
  } else if (kind === "width") {
    if (isRecord(entry.widthMm)) {
      const w = entry.widthMm;
      if (
        typeof w.min === "number" &&
        typeof w.preferred === "number" &&
        typeof w.max === "number"
      ) {
        result.widthMm = {
          min: w.min,
          preferred: w.preferred,
          max: w.max,
        };
      }
    }
  } else if (kind === "via") {
    if (isRecord(entry.viaMm)) {
      const v = entry.viaMm;
      if (
        typeof v.holeDiameter === "number" &&
        typeof v.padDiameter === "number"
      ) {
        result.viaMm = {
          holeDiameter: v.holeDiameter,
          padDiameter: v.padDiameter,
        };
      }
    }
  }
  return result;
}

/**
 * Sprint 12 PR 12.1: normalize a raw per-net routing entry from
 * the relay/extension into the cross-platform NetRouting shape.
 * Layer keys go through normalizeLayer so AI clients can write
 * portable rules; numeric fields default to 0 when unparseable.
 *
 * Exported because both AltiumPlatform and EasyedaPlatform call
 * it — keeps the cross-platform contract single-sourced.
 */
export function normalizeNetRouting(
  entry: Record<string, unknown>,
  netName: string
): NetRouting {
  const totalLengthMm =
    typeof entry.totalLengthMm === "number" ? entry.totalLengthMm : 0;
  const viaCount =
    typeof entry.viaCount === "number" ? Math.floor(entry.viaCount) : 0;
  const unroutedSegments =
    typeof entry.unroutedSegments === "number"
      ? Math.floor(entry.unroutedSegments)
      : 0;
  // Layers come in as a record keyed by raw layer names. Normalize
  // each key to the cross-platform union, summing collisions
  // (multiple inner layers all collapse to a single "inner" key).
  const layers: Record<string, number> = {};
  if (isRecord(entry.layers)) {
    for (const [rawKey, value] of Object.entries(entry.layers)) {
      if (typeof value !== "number") continue;
      const normalized = normalizeLayer(rawKey);
      layers[normalized] = (layers[normalized] ?? 0) + value;
    }
  }
  return {
    netName,
    totalLengthMm,
    layers,
    viaCount,
    unroutedSegments,
    raw: entry,
  };
}

/**
 * Build a MutateResult from a relay/extension response. The relay's
 * payload may carry a custom message ("Moved R1 to (10.5, 20.0)" —
 * the relay knows the exact coords AD applied after coordinate
 * conversion); when missing, fall back to a generic verb-prefixed
 * confirmation. Either way, designator is preserved verbatim.
 *
 * Exported because EasyedaPlatform's mutate impls use the same
 * fallback shape — keeping one helper so the confirmation-message
 * format can't drift between platforms.
 */
export function makeMutateResult(
  designator: string,
  raw: unknown,
  verb: string
): MutateResult {
  const message =
    typeof raw === "object" && raw !== null && "message" in raw && typeof raw.message === "string"
      ? raw.message
      : `${verb} ${designator}.`;
  return { designator, message };
}

/**
 * Sprint 11 PR 11.3: collapse Altium's `eKeepoutKind_*` enum (and
 * EasyEDA's keepout-type field, once confirmed) to the four cases
 * AI clients reason about. Anything we can't recognize is treated
 * as the most-restrictive `"all"` — defensive default that errs on
 * the side of NOT silently letting placement/routing through a
 * keepout we couldn't classify.
 *
 * Exported because `EasyedaPlatform.getKeepouts` needs the same
 * normalization — keeping one helper so the two impls can't drift.
 */
export function normalizeKeepoutKind(
  raw: unknown
): "placement" | "routing" | "via" | "all" {
  if (typeof raw !== "string") return "all";
  const s = raw.toLowerCase();
  // Order matters: check "via" before the placement/routing
  // substrings since AD's "eViaRoutingKeepout" includes both
  // "via" AND "routing" — the via check needs to win.
  if (s.includes("via")) return "via";
  if (s.includes("placement") || s.includes("component")) return "placement";
  if (s.includes("routing") || s.includes("route") || s.includes("track"))
    return "routing";
  return "all";
}

/**
 * Layer scope for keepouts is similar to PlacedComponent's, but adds
 * `"all"` for cross-layer keepouts that apply to every signal layer
 * (common for mech-only no-component zones). Layer naming is fuzzy
 * across AD builds — we map the obvious cases and fall through to
 * "all" rather than "unknown" because a keepout we can't classify
 * is safer to apply broadly than to skip.
 */
export function normalizeKeepoutLayer(
  raw: unknown
): "top" | "bottom" | "inner" | "all" {
  if (typeof raw !== "string") return "all";
  const s = raw.toLowerCase();
  if (s === "top" || s === "etoplayer" || s === "top_layer") return "top";
  if (s === "bottom" || s === "ebottomlayer" || s === "bottom_layer")
    return "bottom";
  if (s.includes("mid") || s.includes("inner") || s.includes("plane"))
    return "inner";
  // "ekeepoutlayer", "all_layers", "multi_layer", anything else →
  // treat as the broadest scope (defensive default).
  return "all";
}

/**
 * Extract a polygon vertex array from a raw `vertices` field. Each
 * entry must be an object with numeric x/y; malformed entries get
 * dropped rather than crashing the whole keepout. Empty array is
 * a valid result (zero-vertex keepouts are malformed but we
 * surface them instead of dropping the whole keepout).
 */
export function extractVertices(
  raw: unknown
): Array<{ x: number; y: number }> {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((v): Array<{ x: number; y: number }> => {
    if (typeof v !== "object" || v === null) return [];
    const obj = v as { x?: unknown; y?: unknown };
    if (typeof obj.x !== "number" || typeof obj.y !== "number") return [];
    return [{ x: obj.x, y: obj.y }];
  });
}

/**
 * Normalize a raw layer string (Altium: `eTopLayer`, `eBottomLayer`,
 * `eMidLayer1`...; EasyEDA: `top`, `bottom`, etc.) to the cross-
 * platform union. Unrecognized values fall through to "unknown" so
 * AI clients writing rules like `layer === "top"` stay portable.
 *
 * Exported because `EasyedaPlatform.getComponents` needs the same
 * normalization — keeping one function so the two impls can't drift.
 */
export function normalizeLayer(
  raw: unknown
): "top" | "bottom" | "inner" | "unknown" {
  if (typeof raw !== "string") return "unknown";
  const s = raw.toLowerCase();
  if (s === "top" || s === "etoplayer" || s === "top_layer") return "top";
  if (s === "bottom" || s === "ebottomlayer" || s === "bottom_layer") return "bottom";
  if (
    s.includes("mid") ||
    s.includes("inner") ||
    s.includes("plane")
  )
    return "inner";
  return "unknown";
}

function errorReason(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Extract a flat PlatformMessage[] from the raw AD-side messages
 * payload. Tolerant of both the structured-list shape the relay
 * usually returns and any wrapper objects. Conservative — anything
 * we can't parse becomes one "unknown" entry rather than throwing.
 */
function extractMessages(raw: Record<string, unknown>): PlatformMessage[] {
  const list = Array.isArray(raw.messages) ? raw.messages : [];
  return list.flatMap((entry): PlatformMessage[] => {
    if (!isRecord(entry)) return [];
    const sev = String(entry.severity ?? entry.class ?? "unknown").toLowerCase();
    const severity: PlatformMessage["severity"] =
      sev === "info" || sev === "warning" || sev === "error"
        ? sev
        : "unknown";
    return [
      {
        severity,
        source: String(entry.source ?? ""),
        text: String(entry.message ?? entry.text ?? ""),
        document: typeof entry.document === "string" ? entry.document : undefined,
      },
    ];
  });
}
