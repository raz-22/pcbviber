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
