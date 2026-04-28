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
