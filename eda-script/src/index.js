/**
 * PCBviber EasyEDA Pro extension — entry point.
 *
 * Loaded by EasyEDA Pro when the user installs the .eext package
 * via Advanced → Extensions → Import. Runs in the editor's JS
 * sandbox; the global `eda` object exposes the Pro Extension API.
 *
 * What this does:
 *   1. Reads the API key + base URL from extension storage. If
 *      the key isn't set yet, prompts the user once.
 *   2. Starts a long-poll loop against `/api/eda-relay/poll`.
 *   3. When the server returns a command, dispatches to a handler
 *      registry; posts the result (success or `{ok: false}`) back
 *      to `/api/eda-relay/result`.
 *   4. Reflects connection state in the bottom-dock panel.
 *
 * What this does NOT do (yet):
 *   - Implement any actual command handlers. Sprint 10+ adds them
 *     one at a time as each cross-platform tool lands its EasyEDA
 *     half. Today the registry is empty; any incoming command
 *     resolves with `{ok: false, error: {code: "tool_not_implemented"}}`
 *     so the AI client gets a typed signal rather than a hang.
 *
 * Plain JS by choice. The extension is small enough that a
 * TypeScript build chain would cost more than it pays. When the
 * surface grows past ~300 lines, switch to `pro-api-types` + tsc.
 */

(function () {
  "use strict";

  // ── Configuration via SYS_Storage ─────────────────────────────────
  // Two settings, both per-user. The base URL is overridable so dev
  // and self-hosted deployments don't need their own forks of the
  // extension.

  const STORAGE_KEY_API_KEY = "pcbviber.apiKey";
  const STORAGE_KEY_API_BASE = "pcbviber.apiBaseUrl";

  const DEFAULT_API_BASE_URL = "https://[Replace with your-deployment-host]";

  // ── Connection state ──────────────────────────────────────────────
  // Reflected in the bottom-dock panel + ToastMessage on transitions.

  /** @type {"idle"|"connecting"|"connected"|"unauthorized"|"error"|"disabled"} */
  let connectionState = "idle";
  let lastError = "";
  let pollTimerId = null;
  let pollIntervalId = "pcbviber.poll";

  // ── Command-handler registry ──────────────────────────────────────
  // Sprint 10+ adds entries to this map; one entry per cross-platform
  // tool method declared on `Platform` (server-side). Methods not in
  // this map fall through to tool_not_implemented at the dispatcher
  // below.

  /** @type {Record<string, (params: Record<string, unknown>) => Promise<unknown>>} */
  const handlers = {
    /**
     * Sprint 10 PR 10.1: capture the editor canvas as a PNG and
     * return `{base64Png, byteLength}`.
     *
     * **Stub today.** The PR 9.1 spike confirmed EasyEDA Pro
     * exposes editor canvas surfaces (eext-pad-fanout reads pads
     * visually, eext-circuitjs1-simulator embeds an iframe), but
     * the exact API for capturing a PNG from the active editor
     * needs hands-on experimentation in a real EasyEDA install.
     * Until that lands, this handler throws via the relay's
     * postResult-failure path; the server's
     * EasyedaPlatform.screenshot() turns that into
     * `{supported: false, reason: ...}` so the AI client degrades
     * gracefully rather than seeing an empty PNG.
     *
     * Wiring path (when implemented):
     *   1. Locate the active document's canvas via
     *      eda.dmt_EditorControl + eda.sys_PanelControl.
     *   2. Render the canvas to a Blob/DataURL.
     *   3. Strip the data:image/png;base64, prefix.
     *   4. Return { base64Png, byteLength }.
     */
    screenshot: async function (_params) {
      throw new Error(
        "Canvas capture is not yet wired up in the PCBviber EasyEDA extension. The server-side screenshot tool ships in Sprint 10 PR 10.1; the in-editor capture comes in a follow-up after hands-on EasyEDA Pro experimentation."
      );
    },

    /**
     * Sprint 10 PR 10.2: return the active project's metadata.
     *
     * Wires to `eda.dmt_Project.getCurrentProjectInfo()` (per the
     * PR 9.1 spike). The SDK's TypeScript types declare it as
     * `Promise<IDMT_ProjectItem | undefined>` — fields aren't
     * fully spelled out, but `uuid` + `name` are stable per the
     * docs. We pass the raw return through; the server's
     * EasyedaPlatform.getActiveProject() handles the "no active
     * project" (undefined) branch and the field extraction.
     *
     * Lightweight handler — no error-translation work needed.
     * The dmt_Project.* methods don't throw on "no project
     * open"; they return undefined.
     */
    get_active_project: async function (_params) {
      // eslint-disable-next-line no-undef -- `eda` is the EasyEDA Pro global
      return await eda.dmt_Project.getCurrentProjectInfo();
    },

    /**
     * Sprint 10 PR 10.2b: list every project the EasyEDA Pro
     * editor has access to.
     *
     * Two-call shape per the PR 9.1 spike:
     *   - eda.dmt_Project.getAllProjectsUuid() returns
     *     Promise<Array<string>> of project uuids.
     *   - eda.dmt_Project.getProjectInfo(uuid) returns the
     *     IDMT_BriefProjectItem for one. We fan out per uuid
     *     and return the array. Per-uuid lookups are sequential
     *     to keep memory low on workspaces with hundreds of
     *     projects; if profiling shows latency, switch to
     *     Promise.all batching here.
     */
    list_projects: async function (_params) {
      // eslint-disable-next-line no-undef
      const uuids = await eda.dmt_Project.getAllProjectsUuid();
      const out = [];
      for (const uuid of uuids) {
        // eslint-disable-next-line no-undef
        const info = await eda.dmt_Project.getProjectInfo(uuid);
        if (info) out.push(info);
      }
      return out;
    },

    /**
     * Sprint 10 PR 10.3a: paginated schematic-component list.
     *
     * Two-call shape:
     *   1. eda.sch_PrimitiveComponent.getAllPrimitiveId() returns
     *      Promise<Array<string>> of every component's primitive id.
     *      Cheap call — returns ids only, not full objects.
     *   2. Slice by params.offset / params.limit, then fetch
     *      detail for the page via eda.sch_PrimitiveComponent.get(idsForPage).
     *
     * Returns:
     *   { items: Array<{primitiveId, designator, value, properties, ...raw}>,
     *     total: number }
     *
     * The server normalizes that shape into PageOf<SchematicComponent>
     * — see EasyedaPlatform.listSchematicComponents().
     */
    list_schematic_components: async function (params) {
      const offset = Math.max(0, Math.floor(params?.offset ?? 0));
      const limit = Math.min(500, Math.max(1, Math.floor(params?.limit ?? 200)));
      // eslint-disable-next-line no-undef
      const allIds = await eda.sch_PrimitiveComponent.getAllPrimitiveId();
      const total = allIds.length;
      const pageIds = allIds.slice(offset, offset + limit);
      // eslint-disable-next-line no-undef
      const details = await eda.sch_PrimitiveComponent.get(pageIds);
      // `get(ids)` may return either an array (one detail per id)
      // or an id→detail map depending on EasyEDA Pro version.
      // Normalize to the array form the server expects.
      let items;
      if (Array.isArray(details)) {
        items = details.map(function (d, i) {
          return Object.assign({ primitiveId: pageIds[i] }, d);
        });
      } else if (details && typeof details === "object") {
        items = pageIds.map(function (id) {
          return Object.assign({ primitiveId: id }, details[id] ?? {});
        });
      } else {
        items = [];
      }
      return { items: items, total: total };
    },

    /**
     * Sprint 10 PR 10.3b: paginated PCB-component list.
     *
     * Identical shape to list_schematic_components but routes through
     * eda.pcb_PrimitiveComponent.* instead. The two-call pattern
     * (getAllPrimitiveId → slice → get) is the same — only the
     * namespace differs.
     *
     * Returns:
     *   { items: Array<{primitiveId, designator, footprint, ...raw}>,
     *     total: number }
     *
     * The server normalizes that shape into Page<PcbComponent>
     * — see EasyedaPlatform.listPcbComponents().
     */
    /**
     * Sprint 11 PR 11.1: paginated read of placed components with
     * full layout fields. Sister to list_pcb_components — same
     * BoardIterator-style walk over pcb_PrimitiveComponent ids,
     * but the server expects the placement payload (x/y/layer/
     * rotation/locked) extracted alongside designator/footprint.
     *
     * EasyEDA Pro stores X/Y in mm natively, so no unit conversion
     * here. Layer comes back as "top"/"bottom"/etc. — server
     * normalizes via the shared normalizeLayer helper.
     */
    get_components: async function (params) {
      const offset = Math.max(0, Math.floor(params?.offset ?? 0));
      const limit = Math.min(500, Math.max(1, Math.floor(params?.limit ?? 200)));
      // eslint-disable-next-line no-undef
      const allIds = await eda.pcb_PrimitiveComponent.getAllPrimitiveId();
      const total = allIds.length;
      const pageIds = allIds.slice(offset, offset + limit);
      // eslint-disable-next-line no-undef
      const details = await eda.pcb_PrimitiveComponent.get(pageIds);
      let items;
      if (Array.isArray(details)) {
        items = details.map(function (d, i) {
          return Object.assign({ primitiveId: pageIds[i] }, d);
        });
      } else if (details && typeof details === "object") {
        items = pageIds.map(function (id) {
          return Object.assign({ primitiveId: id }, details[id] ?? {});
        });
      } else {
        items = [];
      }
      return { items: items, total: total };
    },

    /**
     * Sprint 11 PR 11.2: shared designator → primitiveId lookup.
     * Walks getAllPrimitiveId + per-id details, matches on designator
     * (top-level or properties.designator). Returns the primitiveId
     * string. Throws "no component" / "multiple components" with
     * messages that match the AD relay's wording so AI clients can
     * write portable error-reasoning prompts.
     *
     * Internal — not exposed as a relay method, just a helper.
     */
    __findPrimitiveIdByDesignator: async function (designator) {
      // eslint-disable-next-line no-undef
      const allIds = await eda.pcb_PrimitiveComponent.getAllPrimitiveId();
      // eslint-disable-next-line no-undef
      const details = await eda.pcb_PrimitiveComponent.get(allIds);
      const matches = [];
      const detailFor = function (id, idx) {
        if (Array.isArray(details)) return details[idx] || {};
        if (details && typeof details === "object") return details[id] || {};
        return {};
      };
      for (let i = 0; i < allIds.length; i++) {
        const d = detailFor(allIds[i], i);
        const props = d && d.properties && typeof d.properties === "object" ? d.properties : {};
        const dz =
          typeof d.designator === "string"
            ? d.designator
            : typeof props.designator === "string"
              ? props.designator
              : "";
        if (dz === designator) {
          matches.push({ primitiveId: allIds[i], detail: d });
          if (matches.length > 1) break;
        }
      }
      if (matches.length === 0) {
        throw new Error("No component with designator '" + designator + "' on the active PCB.");
      }
      if (matches.length > 1) {
        throw new Error(
          "Multiple components with designator '" + designator +
          "'; refusing to mutate ambiguously."
        );
      }
      return matches[0];
    },

    /**
     * Sprint 11 PR 11.2: move a component to (x, y) in mm. EasyEDA
     * Pro stores X/Y in mm natively so no unit conversion. Refuses
     * to mutate locked components — explicit intent forces the AI
     * to call lock_component(false) first.
     */
    move_component: async function (params) {
      const designator = String(params?.designator || "");
      const x = Number(params?.x);
      const y = Number(params?.y);
      if (!designator) throw new Error("designator is required");
      if (!isFinite(x) || !isFinite(y)) throw new Error("x and y must be finite numbers (mm)");
      const m = await handlers.__findPrimitiveIdByDesignator(designator);
      if (m.detail && m.detail.locked === true) {
        throw new Error(
          "Component '" + designator +
          "' is locked; call lock_component({locked: false}) first to unlock."
        );
      }
      // eslint-disable-next-line no-undef
      await eda.pcb_PrimitiveComponent.modify(m.primitiveId, { x: x, y: y });
      return {
        designator: designator,
        message: "Moved " + designator + " to (" + x.toFixed(2) + ", " + y.toFixed(2) + ") on EasyEDA."
      };
    },

    rotate_component: async function (params) {
      const designator = String(params?.designator || "");
      let rot = Number(params?.rotation);
      if (!designator) throw new Error("designator is required");
      if (!isFinite(rot)) throw new Error("rotation must be a finite number (degrees)");
      if (rot < 0) rot = ((rot % 360) + 360) % 360;
      if (rot >= 360) rot = rot % 360;
      const m = await handlers.__findPrimitiveIdByDesignator(designator);
      if (m.detail && m.detail.locked === true) {
        throw new Error(
          "Component '" + designator +
          "' is locked; call lock_component({locked: false}) first to unlock."
        );
      }
      // eslint-disable-next-line no-undef
      await eda.pcb_PrimitiveComponent.modify(m.primitiveId, { rotation: rot });
      return {
        designator: designator,
        message: "Rotated " + designator + " to " + rot.toFixed(0) + "° on EasyEDA."
      };
    },

    /**
     * Sprint 12 PR 12.4: trigger EasyEDA Pro's diff-pair router on
     * the (positiveNet, negativeNet) pair. Uses pcb_Document.autoRouting
     * which is BETA — defensive shape extraction since the props
     * accepted and result envelope returned may shift.
     *
     * Result envelope: {routed, totalLengthMm, message}. The handler
     * tries to extract whether routing succeeded from common result
     * shapes; defaults to routed:false (safer than claiming success
     * when we can't tell).
     *
     * Length measurement: walks pcb_PrimitiveLine.getAll for both
     * nets after the route call to sum total trace length on the
     * pair. Doesn't distinguish newly-routed from pre-existing.
     */
    route_diff_pair: async function (params) {
      const positiveNet = params && typeof params.positiveNet === "string" ? params.positiveNet : "";
      const negativeNet = params && typeof params.negativeNet === "string" ? params.negativeNet : "";
      if (!positiveNet) throw new Error("positiveNet is required");
      if (!negativeNet) throw new Error("negativeNet is required");
      // eslint-disable-next-line no-undef
      if (!eda || !eda.pcb_Document || typeof eda.pcb_Document.autoRouting !== "function") {
        throw new Error("EasyEDA Pro pcb_Document.autoRouting is not exposed in this extension version (BETA API).");
      }

      // Invoke the router. Props shape isn't fully spelled out in
      // the SDK — try the most likely common shape.
      let routerResult = null;
      let routerNote = "";
      try {
        // eslint-disable-next-line no-undef
        routerResult = await eda.pcb_Document.autoRouting({
          nets: [positiveNet, negativeNet],
          mode: "diffPair"
        });
      } catch (e) {
        routerNote = e && e.message ? e.message : String(e);
      }

      // Determine routed status from the result envelope. Pro's
      // autoRouting may return:
      //   - boolean true/false
      //   - {success: true} or {ok: true}
      //   - {routed: true}
      //   - undefined (success-without-return on some versions)
      let routed = false;
      if (routerResult === true) {
        routed = true;
      } else if (routerResult && typeof routerResult === "object") {
        if (routerResult.routed === true || routerResult.success === true || routerResult.ok === true) {
          routed = true;
        }
      } else if (routerResult === undefined && !routerNote) {
        // Function returned undefined without throwing — most likely
        // success on a Pro version that doesn't return a status.
        // Trust the no-error signal.
        routed = true;
      }

      // Best-effort length measurement.
      let totalLengthMm = 0;
      try {
        // eslint-disable-next-line no-undef
        const posLines = await eda.pcb_PrimitiveLine.getAll(positiveNet);
        // eslint-disable-next-line no-undef
        const negLines = await eda.pcb_PrimitiveLine.getAll(negativeNet);
        const sumLengths = function (lines) {
          if (!Array.isArray(lines)) return 0;
          let s = 0;
          for (let i = 0; i < lines.length; i++) {
            const ln = lines[i] || {};
            const dx = Number(ln.x2 || 0) - Number(ln.x1 || 0);
            const dy = Number(ln.y2 || 0) - Number(ln.y1 || 0);
            const len = Math.sqrt(dx * dx + dy * dy);
            if (isFinite(len)) s += len;
          }
          return s;
        };
        totalLengthMm = sumLengths(posLines) + sumLengths(negLines);
      } catch (_) { /* length measurement is best-effort */ }

      let message;
      if (routed && totalLengthMm > 0) {
        message = "Routed diff pair (" + positiveNet + ", " + negativeNet +
                  "): " + totalLengthMm.toFixed(2) + "mm total trace on EasyEDA.";
      } else if (routed) {
        message = "Diff pair router for (" + positiveNet + ", " + negativeNet +
                  ") completed; no new traces detected (already routed?). on EasyEDA.";
      } else {
        message = "Diff pair router could not lay traces for (" + positiveNet +
                  ", " + negativeNet + ")" + (routerNote ? "; " + routerNote : "") + ".";
      }

      return {
        positiveNet: positiveNet,
        negativeNet: negativeNet,
        routed: routed,
        totalLengthMm: totalLengthMm,
        message: message
      };
    },

    /**
     * Sprint 12 PR 12.3: delete all traces + vias on a given net.
     *
     * Two API calls per primitive type — getAll(net) for
     * enumeration, then delete(idsArray) for batch removal.
     * Locked items filtered out before delete and counted as
     * skipped (matches the AD relay's locked-guard semantics).
     *
     * The Pro API doesn't reliably expose a `locked` flag on
     * pcb_PrimitiveLine/Via results across versions, so the
     * locked filter is best-effort: skipped count may be 0 on
     * older Pro versions even when traces are technically locked.
     * Live test post-merge to confirm the locked-flag path on
     * current Pro builds.
     */
    unroute_net: async function (params) {
      const net = params && typeof params.net === "string" ? params.net : "";
      if (!net) throw new Error("net is required");
      // eslint-disable-next-line no-undef
      if (!eda || !eda.pcb_PrimitiveLine || !eda.pcb_PrimitiveVia) {
        throw new Error("EasyEDA Pro pcb_Primitive* APIs are not exposed in this extension version.");
      }

      let traceIds = [];
      let viaIds = [];
      let skippedLocked = 0;

      try {
        // eslint-disable-next-line no-undef
        const lines = await eda.pcb_PrimitiveLine.getAll(net);
        if (Array.isArray(lines)) {
          for (let i = 0; i < lines.length; i++) {
            const ln = lines[i] || {};
            if (ln.locked === true) {
              skippedLocked++;
            } else if (typeof ln.primitiveId === "string") {
              traceIds.push(ln.primitiveId);
            }
          }
        }
      } catch (_) { /* getAll may throw on no-net — fall through with empty list */ }

      try {
        // eslint-disable-next-line no-undef
        const vias = await eda.pcb_PrimitiveVia.getAll(net);
        if (Array.isArray(vias)) {
          for (let i = 0; i < vias.length; i++) {
            const v = vias[i] || {};
            if (v.locked === true) {
              skippedLocked++;
            } else if (typeof v.primitiveId === "string") {
              viaIds.push(v.primitiveId);
            }
          }
        }
      } catch (_) { /* getAll may throw on no-net — fall through */ }

      let deletedTraces = 0;
      let deletedVias = 0;

      if (traceIds.length > 0) {
        try {
          // eslint-disable-next-line no-undef
          await eda.pcb_PrimitiveLine.delete(traceIds);
          deletedTraces = traceIds.length;
        } catch (_) {
          // Batch delete failed — try one at a time so partial
          // success isn't silent.
          for (let i = 0; i < traceIds.length; i++) {
            try {
              // eslint-disable-next-line no-undef
              await eda.pcb_PrimitiveLine.delete([traceIds[i]]);
              deletedTraces++;
            } catch (_) { /* one failed delete shouldn't abort the loop */ }
          }
        }
      }

      if (viaIds.length > 0) {
        try {
          // eslint-disable-next-line no-undef
          await eda.pcb_PrimitiveVia.delete(viaIds);
          deletedVias = viaIds.length;
        } catch (_) {
          for (let i = 0; i < viaIds.length; i++) {
            try {
              // eslint-disable-next-line no-undef
              await eda.pcb_PrimitiveVia.delete([viaIds[i]]);
              deletedVias++;
            } catch (_) { /* see above */ }
          }
        }
      }

      let message;
      if (deletedTraces + deletedVias === 0 && skippedLocked === 0) {
        message = "No traces or vias on net '" + net + "' — already unrouted or doesn't exist.";
      } else {
        message = "Unrouted '" + net + "': deleted " + deletedTraces +
                  " trace(s), " + deletedVias + " via(s)" +
                  (skippedLocked > 0 ? ", " + skippedLocked + " locked skipped" : "") +
                  " on EasyEDA.";
      }

      return {
        net: net,
        deletedTraces: deletedTraces,
        deletedVias: deletedVias,
        skippedLocked: skippedLocked,
        message: message
      };
    },

    /**
     * Sprint 12 PR 12.2: read all design rules from the current
     * EasyEDA Pro DRC config. The Pro API exposes the full config
     * as a single object via getCurrentRuleConfiguration; we walk
     * its rule entries and surface them in the cross-platform
     * shape. Per-rule fields vary by category — defensive
     * extraction with raw payload preserved.
     */
    get_design_rules: async function () {
      // eslint-disable-next-line no-undef
      if (!eda || !eda.pcb_Drc || typeof eda.pcb_Drc.getCurrentRuleConfiguration !== "function") {
        return { items: [] };
      }
      let config;
      try {
        // eslint-disable-next-line no-undef
        config = await eda.pcb_Drc.getCurrentRuleConfiguration();
      } catch (e) {
        return { items: [] };
      }
      if (!config || typeof config !== "object") return { items: [] };
      // Pro version drift: rules may live under config.rules,
      // config.items, or be the config object itself when it's
      // already an array. Try the common shapes.
      let entries = [];
      if (Array.isArray(config)) {
        entries = config;
      } else if (Array.isArray(config.rules)) {
        entries = config.rules;
      } else if (Array.isArray(config.items)) {
        entries = config.items;
      } else if (typeof config === "object") {
        // Object-keyed-by-name layout: convert to array preserving name.
        for (const key of Object.keys(config)) {
          const v = config[key];
          if (v && typeof v === "object") {
            entries.push(Object.assign({ name: key }, v));
          }
        }
      }
      return { items: entries };
    },

    /**
     * Sprint 12 PR 12.2: update or create a design rule via the
     * read-modify-write pattern. EasyEDA Pro's only writer is
     * overwriteCurrentRuleConfiguration, which takes the FULL
     * config — so we fetch current state, mutate one entry by
     * name, and write back.
     *
     * Race-window note: if two callers race rule writes, the
     * later one wins on the FULL config (potentially clobbering
     * the earlier caller's other rule changes). Acceptable for
     * v1 — AI clients typically don't race rule writes.
     */
    set_route_rule: async function (params) {
      const name = params && typeof params.name === "string" ? params.name : "";
      const kind = params && typeof params.kind === "string" ? params.kind : "";
      if (!name) throw new Error("name is required");
      if (!kind) throw new Error("kind is required");
      // eslint-disable-next-line no-undef
      if (!eda || !eda.pcb_Drc || typeof eda.pcb_Drc.getCurrentRuleConfiguration !== "function") {
        throw new Error("EasyEDA Pro DRC API is not exposed in this extension version.");
      }
      // eslint-disable-next-line no-undef
      const config = await eda.pcb_Drc.getCurrentRuleConfiguration();
      if (!config || typeof config !== "object") {
        throw new Error("getCurrentRuleConfiguration returned no config");
      }
      // Locate the rule by name. Look in both array-shaped and
      // object-keyed-by-name layouts.
      let rule = null;
      let setRule = null;
      if (Array.isArray(config)) {
        for (let i = 0; i < config.length; i++) {
          if (config[i] && config[i].name === name) {
            rule = config[i];
            setRule = function (next) { config[i] = next; };
            break;
          }
        }
      } else if (config[name] && typeof config[name] === "object") {
        rule = Object.assign({ name: name }, config[name]);
        setRule = function (next) {
          // Strip the synthesized name field before writing back.
          const copy = Object.assign({}, next);
          delete copy.name;
          config[name] = copy;
        };
      } else if (Array.isArray(config.rules)) {
        for (let i = 0; i < config.rules.length; i++) {
          if (config.rules[i] && config.rules[i].name === name) {
            rule = config.rules[i];
            setRule = function (next) { config.rules[i] = next; };
            break;
          }
        }
      }
      if (!rule || !setRule) {
        throw new Error(
          "Design rule '" + name + "' not found in the current rule configuration."
        );
      }
      // Apply kind-specific updates. Spread the existing rule so we
      // preserve fields we don't touch.
      const next = Object.assign({}, rule);
      if (kind === "clearance") {
        if (typeof params.clearanceMm === "number") {
          next.clearanceMm = params.clearanceMm;
        }
      } else if (kind === "width") {
        if (params.widthMm && typeof params.widthMm === "object") {
          next.widthMm = {
            min: Number(params.widthMm.min),
            preferred: Number(params.widthMm.preferred),
            max: Number(params.widthMm.max)
          };
        }
      } else if (kind === "via") {
        if (params.viaMm && typeof params.viaMm === "object") {
          next.viaMm = {
            holeDiameter: Number(params.viaMm.holeDiameter),
            padDiameter: Number(params.viaMm.padDiameter)
          };
        }
      } else {
        throw new Error(
          "unknown rule kind: '" + kind + "' (expected clearance, width, or via)"
        );
      }
      next.kind = kind;
      setRule(next);
      // eslint-disable-next-line no-undef
      await eda.pcb_Drc.overwriteCurrentRuleConfiguration(config);
      return {
        name: name,
        message: "Updated rule '" + name + "' (" + kind + ") on EasyEDA."
      };
    },

    /**
     * Sprint 12 PR 12.1: per-net routing summary, paginated by net.
     *
     * Steps:
     *   1. eda.pcb_Net.getAll() → list of nets (or namespace check
     *      → return {unsupported: true} if missing).
     *   2. Slice by offset/limit, alphabetical (sort applies before
     *      slicing for stable pagination).
     *   3. Per net: getNetLength + count primitives via
     *      pcb_PrimitiveLine.getAll(net), pcb_PrimitiveVia.getAll(net),
     *      and (if exposed) the unrouted-segment getter.
     *   4. Aggregate length per layer by walking the trace primitives.
     *
     * Each accessor wrapped in its own try/catch so a missing field
     * on one net doesn't crash the whole call.
     */
    get_net_routing: async function (params) {
      const offset = Math.max(0, Math.floor(params?.offset ?? 0));
      const limit = Math.min(500, Math.max(1, Math.floor(params?.limit ?? 200)));
      // eslint-disable-next-line no-undef
      if (!eda || !eda.pcb_Net || typeof eda.pcb_Net.getAll !== "function") {
        return { unsupported: true };
      }
      let allNets;
      try {
        // eslint-disable-next-line no-undef
        allNets = await eda.pcb_Net.getAll();
      } catch (e) {
        return { unsupported: true };
      }
      if (!Array.isArray(allNets)) {
        return { items: [] };
      }
      // Stable sort by net name so pagination is deterministic.
      const netNames = allNets
        .map(function (n) {
          if (typeof n === "string") return n;
          if (n && typeof n.name === "string") return n.name;
          return "";
        })
        .filter(function (s) { return s.length > 0; })
        .sort();
      const total = netNames.length;
      const slice = netNames.slice(offset, offset + limit);
      const items = [];
      for (let i = 0; i < slice.length; i++) {
        const netName = slice[i];
        const entry = {
          netName: netName,
          totalLengthMm: 0,
          layers: {},
          viaCount: 0,
          unroutedSegments: 0
        };
        try {
          // eslint-disable-next-line no-undef
          const len = await eda.pcb_Net.getNetLength(netName);
          if (typeof len === "number" && isFinite(len)) {
            entry.totalLengthMm = len;
          }
        } catch (_) { }
        try {
          // eslint-disable-next-line no-undef
          const lines = await eda.pcb_PrimitiveLine.getAll(netName);
          if (Array.isArray(lines)) {
            for (let j = 0; j < lines.length; j++) {
              const seg = lines[j] || {};
              const lyr = String(seg.layer || "unknown");
              const x1 = Number(seg.x1 || 0);
              const y1 = Number(seg.y1 || 0);
              const x2 = Number(seg.x2 || 0);
              const y2 = Number(seg.y2 || 0);
              const dx = x2 - x1;
              const dy = y2 - y1;
              const segLen = Math.sqrt(dx * dx + dy * dy);
              if (isFinite(segLen)) {
                entry.layers[lyr] = (entry.layers[lyr] || 0) + segLen;
              }
            }
          }
        } catch (_) { }
        try {
          // eslint-disable-next-line no-undef
          const vias = await eda.pcb_PrimitiveVia.getAll(netName);
          if (Array.isArray(vias)) entry.viaCount = vias.length;
        } catch (_) { }
        items.push(entry);
      }
      return { items: items, total: total };
    },

    /**
     * Sprint 11 PR 11.3: enumerate keepouts on the active PCB.
     *
     * Per Sprint 9 spike question #4, pcb_PrimitiveRegion is the
     * suspected carrier but `[NEEDS HANDS-ON]`. This handler tries
     * the most likely API paths; if the namespace is missing we
     * return `{unsupported: true}` so the server surfaces a clean
     * supported:false with the spike-question reason.
     *
     * Read-only this PR — set_keepout lands in 11.3b once we can
     * confirm the write API hands-on.
     */
    get_keepouts: async function () {
      // eslint-disable-next-line no-undef
      if (!eda || !eda.pcb_PrimitiveRegion) {
        return { unsupported: true };
      }
      let allIds;
      try {
        // eslint-disable-next-line no-undef
        allIds = await eda.pcb_PrimitiveRegion.getAllPrimitiveId();
      } catch (e) {
        // Method exists at the namespace level but throws — likely
        // a Pro version that hasn't wired the accessor yet.
        return { unsupported: true };
      }
      if (!Array.isArray(allIds) || allIds.length === 0) {
        return { items: [] };
      }
      // eslint-disable-next-line no-undef
      const details = await eda.pcb_PrimitiveRegion.get(allIds);
      let entries;
      if (Array.isArray(details)) {
        entries = details.map(function (d, i) {
          return Object.assign({ id: allIds[i] }, d);
        });
      } else if (details && typeof details === "object") {
        entries = allIds.map(function (id) {
          return Object.assign({ id: id }, details[id] ?? {});
        });
      } else {
        entries = [];
      }
      // The spike flagged uncertainty about which fields carry
      // keepout-vs-fill flags. Filter to entries that smell like
      // keepouts: a `keepout`/`isKeepOut`/`type` field that includes
      // "keepout" or matches the keepout enum. Rest get dropped.
      const keepouts = entries.filter(function (e) {
        if (e.keepout === true || e.isKeepOut === true) return true;
        const t = String(e.type || e.kind || "").toLowerCase();
        return t.indexOf("keepout") >= 0 || t === "placement" || t === "routing" || t === "via";
      });
      return { items: keepouts };
    },

    lock_component: async function (params) {
      const designator = String(params?.designator || "");
      const locked = Boolean(params?.locked);
      if (!designator) throw new Error("designator is required");
      const m = await handlers.__findPrimitiveIdByDesignator(designator);
      // eslint-disable-next-line no-undef
      await eda.pcb_PrimitiveComponent.modify(m.primitiveId, { locked: locked });
      return {
        designator: designator,
        message: (locked ? "Locked " : "Unlocked ") + designator + " on EasyEDA."
      };
    },

    list_pcb_components: async function (params) {
      const offset = Math.max(0, Math.floor(params?.offset ?? 0));
      const limit = Math.min(500, Math.max(1, Math.floor(params?.limit ?? 200)));
      // eslint-disable-next-line no-undef
      const allIds = await eda.pcb_PrimitiveComponent.getAllPrimitiveId();
      const total = allIds.length;
      const pageIds = allIds.slice(offset, offset + limit);
      // eslint-disable-next-line no-undef
      const details = await eda.pcb_PrimitiveComponent.get(pageIds);
      // Same array-vs-id-map normalization as the schematic handler;
      // pro-api version drift can change which shape is returned.
      let items;
      if (Array.isArray(details)) {
        items = details.map(function (d, i) {
          return Object.assign({ primitiveId: pageIds[i] }, d);
        });
      } else if (details && typeof details === "object") {
        items = pageIds.map(function (id) {
          return Object.assign({ primitiveId: id }, details[id] ?? {});
        });
      } else {
        items = [];
      }
      return { items: items, total: total };
    },

    /**
     * Sprint 10 PR 10.5: read DRC + ERC outputs from EasyEDA Pro.
     *
     * Altium's `Messages` panel accumulates state across runs;
     * EasyEDA Pro doesn't expose that. So we ACTIVELY run both
     * DRC engines (sch + pcb) on each call, merge results, tag
     * `source` so the AI can tell which side flagged what.
     *
     * Each engine is independent — if no schematic is open,
     * sch_Drc.check throws; we catch and continue with pcb. Same
     * vice versa. The contract is "best-effort: return what we
     * could collect", not "fail on first engine that errors".
     *
     * `includeVerboseError=true` per the spike — without it the
     * return is summary-only. Strict + ui both off (ui=false
     * stops the editor from blocking on a modal).
     */
    get_messages: async function () {
      const merged = [];
      try {
        // eslint-disable-next-line no-undef
        const schResult = await eda.sch_Drc.check(false, false, true);
        const schList = Array.isArray(schResult)
          ? schResult
          : schResult && Array.isArray(schResult.messages)
            ? schResult.messages
            : [];
        for (let i = 0; i < schList.length; i++) {
          const entry = schList[i] || {};
          merged.push(
            Object.assign({ source: "schematic" }, entry)
          );
        }
      } catch (e) {
        // Schematic DRC unavailable — likely no schematic open.
        // Don't surface as a top-level failure; just skip.
      }
      try {
        // eslint-disable-next-line no-undef
        const pcbResult = await eda.pcb_Drc.check(false, false, true);
        const pcbList = Array.isArray(pcbResult)
          ? pcbResult
          : pcbResult && Array.isArray(pcbResult.messages)
            ? pcbResult.messages
            : [];
        for (let i = 0; i < pcbList.length; i++) {
          const entry = pcbList[i] || {};
          merged.push(Object.assign({ source: "pcb" }, entry));
        }
      } catch (e) {
        // PCB DRC unavailable — same handling as above.
      }
      return { messages: merged };
    },

    /**
     * Sprint 10 PR 10.4: paginated workspace-library search.
     *
     * Routes to eda.lib_Device.search(key, libraryUuid, classification,
     * symbolType, itemsOfPage, page).
     *   - `key`: empty string (return everything; no search this PR)
     *   - `libraryUuid`: undefined (search across all libraries the
     *     workspace can see)
     *   - `classification`/`symbolType`: undefined (no filter)
     *   - `itemsOfPage`: limit
     *   - `page`: derived from offset/limit (EasyEDA's API is 1-indexed
     *     page-based; ours is offset-based)
     *
     * Returns:
     *   { items: Array<lib_Device entry with uuid, name, ...>,
     *     total: number }
     *
     * The server normalizes that shape into Page<LibraryComponent>
     * — see EasyedaPlatform.listLibraryComponents().
     */
    list_library_components: async function (params) {
      const offset = Math.max(0, Math.floor(params?.offset ?? 0));
      const limit = Math.min(500, Math.max(1, Math.floor(params?.limit ?? 200)));
      // EasyEDA uses 1-indexed pages of itemsOfPage. Map our offset
      // to the page that contains it. When offset isn't a multiple of
      // limit, we'd skip rows — but list_library_components is
      // expected to be called with offset = previous nextOffset, so
      // alignment is preserved.
      const page = Math.floor(offset / limit) + 1;
      // eslint-disable-next-line no-undef
      const result = await eda.lib_Device.search(
        "",
        undefined,
        undefined,
        undefined,
        limit,
        page
      );
      // The pro-api types declare a paginated result shape; field
      // names vary by Pro version. Try the common ones.
      let items = [];
      let total;
      if (Array.isArray(result)) {
        items = result;
        total = items.length + offset;
      } else if (result && typeof result === "object") {
        items = Array.isArray(result.items)
          ? result.items
          : Array.isArray(result.list)
            ? result.list
            : Array.isArray(result.data)
              ? result.data
              : [];
        total =
          typeof result.total === "number"
            ? result.total
            : typeof result.totalCount === "number"
              ? result.totalCount
              : undefined;
      }
      return { items: items, total: total };
    },
  };

  // ── Boot ──────────────────────────────────────────────────────────

  async function boot() {
    setState("connecting");
    const apiKey = await loadOrPromptApiKey();
    if (!apiKey) {
      setState("disabled", "API key not configured");
      return;
    }
    startPolling();
  }

  async function loadOrPromptApiKey() {
    const existing = await eda.sys_Storage.getExtensionUserConfig(STORAGE_KEY_API_KEY);
    if (existing && typeof existing === "string" && existing.length > 0) {
      return existing;
    }
    const entered = await eda.sys_Dialog.showInputDialog({
      title: "PCBviber API key",
      message:
        "Paste your PCBviber API key (starts with pcb_). " +
        "Get one from Settings → API keys on the PCBviber web app, " +
        "and bind it to this EasyEDA workspace.",
      defaultValue: "",
      placeholder: "pcb_..."
    });
    if (!entered || typeof entered !== "string") return null;
    const trimmed = entered.trim();
    if (!trimmed.startsWith("pcb_")) {
      eda.sys_ToastMessage.showMessage(
        "API key must start with 'pcb_' — please try again from the PCBviber panel.",
        eda.ESYS_ToastMessageType ? eda.ESYS_ToastMessageType.WARNING : "warning"
      );
      return null;
    }
    await eda.sys_Storage.setExtensionUserConfig(STORAGE_KEY_API_KEY, trimmed);
    return trimmed;
  }

  function getApiBaseUrl() {
    return new Promise(function (resolve) {
      eda.sys_Storage.getExtensionUserConfig(STORAGE_KEY_API_BASE).then(function (v) {
        if (typeof v === "string" && v.length > 0) return resolve(v);
        resolve(DEFAULT_API_BASE_URL);
      });
    });
  }

  // ── Long-poll loop ────────────────────────────────────────────────

  function startPolling() {
    // SYS_Timer.setIntervalTimer is the documented timer surface for
    // extensions. We use a 1-second tick that issues a 25s long-poll;
    // when the long-poll resolves (with a command or 204), we issue
    // the next one. The 1s ticker is just the safety net in case the
    // long-poll Promise hangs — we don't queue overlapping polls.
    let inFlight = false;

    eda.sys_Timer.setIntervalTimer(pollIntervalId, 1000, async function () {
      if (inFlight) return;
      inFlight = true;
      try {
        await pollOnce();
      } catch (err) {
        setState("error", reasonOf(err));
      } finally {
        inFlight = false;
      }
    });
  }

  function stopPolling() {
    if (pollIntervalId) {
      eda.sys_Timer.clearIntervalTimer(pollIntervalId);
    }
  }

  async function pollOnce() {
    const apiKey = await eda.sys_Storage.getExtensionUserConfig(STORAGE_KEY_API_KEY);
    const baseUrl = await getApiBaseUrl();
    const url = baseUrl + "/api/eda-relay/poll?pollTimeoutMs=25000";

    const res = await eda.sys_ClientUrl.request(url, "GET", null, {
      headers: { Authorization: "Bearer " + apiKey }
    });

    // 204: queue empty for this workspace; the server held the long-
    // poll for the full 25s. Loop and try again.
    if (res.status === 204) {
      setState("connected");
      return;
    }
    if (res.status === 401) {
      // Key was rejected. Clear it so the user gets re-prompted next
      // boot, and stop the loop so we don't spam 401s.
      await eda.sys_Storage.deleteExtensionUserConfig(STORAGE_KEY_API_KEY);
      stopPolling();
      setState("unauthorized", "API key was rejected. Reload the extension to re-enter it.");
      return;
    }
    if (res.status !== 200) {
      setState("error", "poll returned " + res.status);
      return;
    }

    setState("connected");
    /** @type {{id: string, method: string, params: Record<string, unknown>, timeoutMs: number}} */
    const cmd = await res.json();
    await dispatch(cmd, baseUrl, apiKey);
  }

  async function dispatch(cmd, baseUrl, apiKey) {
    const handler = handlers[cmd.method];
    let body;
    if (!handler) {
      body = {
        id: cmd.id,
        ok: false,
        error: {
          message: "Tool not yet implemented in this extension version.",
          code: "tool_not_implemented",
          detail: "method=" + cmd.method
        }
      };
    } else {
      try {
        const result = await handler(cmd.params || {});
        body = { id: cmd.id, ok: true, result: result };
      } catch (err) {
        body = {
          id: cmd.id,
          ok: false,
          error: {
            message: reasonOf(err),
            code: "handler_error"
          }
        };
      }
    }
    await eda.sys_ClientUrl.request(
      baseUrl + "/api/eda-relay/result",
      "POST",
      body,
      { headers: { Authorization: "Bearer " + apiKey } }
    );
  }

  // ── Status reflection ─────────────────────────────────────────────

  function setState(next, detail) {
    if (next === connectionState && detail === lastError) return;
    connectionState = next;
    lastError = detail || "";
    renderPanel();
  }

  function renderPanel() {
    const labels = {
      idle: "Idle",
      connecting: "Connecting…",
      connected: "Connected",
      unauthorized: "Unauthorized",
      error: "Error",
      disabled: "Disabled"
    };
    const text =
      "PCBviber: " +
      (labels[connectionState] || connectionState) +
      (lastError ? " (" + lastError + ")" : "");
    // Best-effort UI write. The bottom panel HTML is owned by the
    // extension manifest; we just push a status string into it.
    if (eda.sys_PanelControl && eda.sys_PanelControl.openBottomPanel) {
      try {
        eda.sys_PanelControl.openBottomPanel({ id: "pcbviber.status", text: text });
      } catch (e) {
        // Panel API may differ across EasyEDA Pro minor versions —
        // don't crash the extension over a status indicator.
      }
    }
  }

  function reasonOf(err) {
    if (!err) return "unknown error";
    if (typeof err === "string") return err;
    if (err && err.message) return String(err.message);
    return String(err);
  }

  // ── Go ────────────────────────────────────────────────────────────

  boot().catch(function (err) {
    setState("error", reasonOf(err));
  });
})();
