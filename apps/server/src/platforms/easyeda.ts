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
import { normalizeLayer } from "./altium.js";
import {
  notSupported,
  ok,
  type ActiveProject,
  type DrcSummary,
  type LibraryComponent,
  type ListLibraryComponentsParams,
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

  async runDrc(): Promise<PlatformResponse<DrcSummary>> {
    return notSupported(STUB_REASON);
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
