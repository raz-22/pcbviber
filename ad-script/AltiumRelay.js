// ─────────────────────────────────────────────────────────────────────
// AltiumRelay.js — runs INSIDE Altium Designer 24.
//
// Long-polls the MCP server at http://127.0.0.1:3000/ad-relay/next,
// dispatches commands to AD's scripting API, and POSTs results back.
//
// Load via:  File → Run Script… → "JavaScript Script" → pick this file
//            → the function you want to run is Main().
//
// To stop cleanly: set the global g_stop = true in AD's Script
// Command Line panel, or just close the project / AD.
//
// Logging goes to a file — modal dialogs would block the polling loop.
//   Default log file: %TEMP%\AltiumRelay.log
//   Tail it from PowerShell with:
//     Get-Content $env:TEMP\AltiumRelay.log -Tail 20 -Wait
//
// Notes on the AD scripting environment:
//   - This runs in AD's "DXP" ECMAScript-like engine. It's NOT modern
//     JS. No let/const/arrow funcs — stick to var + function.
//   - COM objects are available via "new ActiveXObject(...)".
//   - XMLHttpRequest is NOT available; we use Msxml2.XMLHTTP.
//   - Sync XHR aborts for long holds → server hold is kept to 8s.
// ─────────────────────────────────────────────────────────────────────

var RELAY_URL = "http://127.0.0.1:3000/ad-relay";
var LOG_FILE  = null; // set lazily via %TEMP%
var g_stop = false;

function Main() {
    g_stop = false;
    InitLog();
    Log("AltiumRelay starting. Server: " + RELAY_URL);
    Log("Log file: " + LOG_FILE);
    Log("To stop: set g_stop=true in the Script Command Line panel, or close AD.");

    // Short-poll loop: each request is ~50ms, we sleep POLL_INTERVAL_MS
    // between polls so AD's UI thread stays responsive.
    var POLL_INTERVAL_MS = 500;
    var consecutiveErrors = 0;

    while (!g_stop) {
        var cmd = null;
        try {
            cmd = PollNext();
            consecutiveErrors = 0;
        } catch (e) {
            consecutiveErrors++;
            if (consecutiveErrors <= 3 || consecutiveErrors % 20 === 0) {
                Log("Poll error (" + consecutiveErrors + "): " + e.message);
            }
            Sleep(Math.min(10000, 1000 * consecutiveErrors));
            continue;
        }

        if (cmd === null) {
            Sleep(POLL_INTERVAL_MS);
            continue;
        }

        Log("Dispatching: " + cmd.method + " (id=" + cmd.id + ")");
        var result;
        try {
            result = Dispatch(cmd);
            PostResult(cmd.id, true, result, null);
            Log("OK: " + cmd.method);
        } catch (err) {
            Log("FAIL " + cmd.method + ": " + err.message);
            PostResult(cmd.id, false, null, {
                message: err.message || String(err),
                detail: (err.detail || ""),
                code: (err.code || "")
            });
        }
    }
    Log("AltiumRelay stopped.");
}

// ─────────────────────────────────────────────────────────────────────
// Transport — HTTP long-poll + result POST
// ─────────────────────────────────────────────────────────────────────

function NewXhr() {
    // WinHttp is more tolerant of longer sync holds than Msxml2.XMLHTTP.
    // Fall back to Msxml2 if WinHttp isn't available.
    try {
        return new ActiveXObject("WinHttp.WinHttpRequest.5.1");
    } catch (_) {
        return new ActiveXObject("Msxml2.XMLHTTP");
    }
}

function PollNext() {
    var xhr = NewXhr();
    xhr.open("GET", RELAY_URL + "/next", false); // synchronous
    // All four timeouts in ms: resolve, connect, send, receive.
    // Server returns immediately (<50ms typical), so 3s is generous.
    try { xhr.SetTimeouts(2000, 2000, 2000, 3000); } catch (_) {}
    xhr.send();
    if (xhr.status === 204) return null;
    if (xhr.status !== 200) throw MakeError("Poll failed: HTTP " + xhr.status);
    return JsonParse(xhr.responseText);
}

function PostResult(id, ok, result, error) {
    var body = JsonStringify({
        id: id,
        ok: ok,
        result: (result === undefined ? null : result),
        error: error
    });
    var xhr = NewXhr();
    xhr.open("POST", RELAY_URL + "/result", false);
    try { xhr.SetTimeouts(2000, 2000, 2000, 3000); } catch (_) {}
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.send(body);
    if (xhr.status !== 200) {
        Log("Warning: result POST returned " + xhr.status + " for id " + id);
    }
}

// ─────────────────────────────────────────────────────────────────────
// Dispatch — method → AD API
// ─────────────────────────────────────────────────────────────────────

function Dispatch(cmd) {
    switch (cmd.method) {
        case "ping":               return CmdPing(cmd.params);
        case "get_active_project": return CmdGetActiveProject(cmd.params);
        case "open_project":       return CmdOpenProject(cmd.params);
        case "new_project":        return CmdNewProject(cmd.params);
        case "save_project":       return CmdSaveProject(cmd.params);
        case "list_documents":     return CmdListDocuments(cmd.params);
        case "get_messages":       return CmdGetMessages(cmd.params);
        case "get_board_info":     return CmdGetBoardInfo(cmd.params);
        case "get_stackup":        return CmdGetStackup(cmd.params);
        case "debug_introspect_messages":
                                   return CmdDebugIntrospectMessages(cmd.params);
        case "compile_project":    return CmdCompileProject(cmd.params);
        case "run_drc":            return CmdRunDrc(cmd.params);
        case "annotate_schematic": return CmdAnnotateSchematic(cmd.params);
        case "generate_outputs":   return CmdGenerateOutputs(cmd.params);
        case "auto_place":         return CmdAutoPlace(cmd.params);
        case "auto_route":         return CmdAutoRoute(cmd.params);
        case "get_components":     return CmdGetComponents(cmd.params);
        case "move_component":     return CmdMoveComponent(cmd.params);
        case "rotate_component":   return CmdRotateComponent(cmd.params);
        case "lock_component":     return CmdLockComponent(cmd.params);
        case "get_keepouts":       return CmdGetKeepouts(cmd.params);
        case "get_net_routing":    return CmdGetNetRouting(cmd.params);
    }
    throw MakeError("unknown method: " + cmd.method);
}

// ─────────────────────────────────────────────────────────────────────
// Command implementations
//
// Each returns a plain JS object that gets JSON-serialized back to the
// server. Throw with MakeError(msg, detail, code) for errors.
//
// Markers:
//   [TESTED]    — verified working in AD 24 during development
//   [DOCUMENTED] — uses documented AD API, but not verified in this repo.
//                  May need tweaks on first run — check AD's Messages panel.
// ─────────────────────────────────────────────────────────────────────

function CmdPing(_params) {
    // [TESTED] Works in any running AD — Client always exists.
    return {
        pong: true,
        adVersion: (typeof Client !== "undefined" && Client.ProductName)
            ? Client.ProductName
            : "Altium Designer",
        timestamp: IsoNow()
    };
}

function CmdGetActiveProject(_params) {
    // [DOCUMENTED] GetWorkspace + DM_FocusedProject
    var ws = GetWorkspace();
    if (!ws) throw MakeError("No workspace available.");
    var proj = ws.DM_FocusedProject();
    if (!proj) return { hasProject: false };

    var docs = [];
    for (var i = 0; i < proj.DM_LogicalDocumentCount(); i++) {
        var d = proj.DM_LogicalDocuments(i);
        docs.push({ path: d.DM_FullPath(), kind: d.DM_DocumentKind() });
    }

    return {
        hasProject: true,
        name: proj.DM_ProjectFileName(),
        path: proj.DM_ProjectFullPath(),
        documents: docs
    };
}

function CmdOpenProject(params) {
    // [DOCUMENTED] Client.OpenDocument opens any document type by path.
    RequireString(params, "path");
    Client.OpenDocument("Project", params.path);
    return { opened: params.path };
}

function CmdNewProject(params) {
    // [EXPERIMENTAL] Create a new PCB project by writing a minimal .PrjPcb
    // text file to disk, then opening it. This avoids the WorkspaceManager
    // NewProject process — that process pops a modal "select template"
    // dialog which blocks AD's UI thread (and thus our polling loop) until
    // the user dismisses it.
    //
    // .PrjPcb is a plain INI-style text file, so we can hand-author a
    // minimal empty-shell project that AD will open cleanly. The schematic
    // option is currently a no-op because .SchDoc is binary OLE and can't
    // be authored without AD's APIs — and every AD "new schematic" command
    // we've tried either needs UI or doesn't persist silently.
    RequireString(params, "projectPath");
    var projectPath = params.projectPath;
    var addSchematic = (params.addSchematic !== false); // default true
    var notes = [];

    EnsureDirectoryFor(projectPath);

    // 1. Write a minimal .PrjPcb shell to disk.
    WriteMinimalPrjPcb(projectPath);

    // 2. Open it in AD. OpenDocument is non-interactive for an existing
    //    on-disk file, so this does not trigger any dialog.
    try {
        Client.OpenDocument("PcbProject", projectPath);
    } catch (e1) {
        // Some AD builds use "Project" as the kind instead of "PcbProject".
        try {
            Client.OpenDocument("Project", projectPath);
        } catch (e2) {
            throw MakeError("OpenDocument failed for both 'PcbProject' and 'Project': "
                + (e1.message || e1) + " / " + (e2.message || e2));
        }
    }

    // 3. Schematic creation: unsupported in this path. Flag it clearly so
    //    callers know they got an empty project. Compile on an empty
    //    project will typically emit a "project has no documents" warning,
    //    which is still useful for exercising the Messages enumeration.
    var schematicPath = null;
    if (addSchematic) {
        notes.push("addSchematic=true is not yet supported in the file-write path. "
            + "Project was created without a schematic document. "
            + "Add one manually in AD or extend CmdNewProject with a non-interactive "
            + "schematic creation path.");
    }

    return {
        projectPath: projectPath,
        schematicPath: schematicPath,
        savedProject: true,
        note: notes.length ? notes.join("; ") : undefined
    };
}

function WriteMinimalPrjPcb(path) {
    // Minimal empty-shell PCB project. AD 24 reads .PrjPcb as INI; these
    // three sections are sufficient for it to open the project cleanly.
    var content =
        "[Design]\r\n" +
        "Version=1.0\r\n" +
        "HierarchyMode=0\r\n" +
        "IsWorkspace=0\r\n" +
        "\r\n" +
        "[Documents]\r\n" +
        "DocumentCount=0\r\n" +
        "\r\n" +
        "[Configurations]\r\n" +
        "ConfigurationCount=0\r\n";
    var fso = new ActiveXObject("Scripting.FileSystemObject");
    var stream = fso.OpenTextFile(path, 2 /* ForWriting */, true /* create */);
    stream.Write(content);
    stream.Close();
}

function CmdSaveProject(params) {
    // [DOCUMENTED] Save via the DM method on the focused project, falling
    // back to Client.SendMessage("Project:Save", ...).
    var ws = GetWorkspace();
    if (!ws) throw MakeError("No workspace available.");

    var proj = null;
    if (params && params.projectPath) {
        proj = FindProjectByPath(ws, params.projectPath);
        if (!proj) throw MakeError("Project not open in workspace: " + params.projectPath);
    } else {
        proj = ws.DM_FocusedProject();
        if (!proj) throw MakeError("No focused project to save.");
    }

    try {
        proj.DM_DoSave();
        return {
            saved: true,
            path: SafeStr(function () { return proj.DM_ProjectFullPath(); })
        };
    } catch (e1) {
        try {
            Client.SendMessage("Project:Save", "", 512, Client.CurrentView);
            return {
                saved: true,
                path: SafeStr(function () { return proj.DM_ProjectFullPath(); }),
                note: "Saved via SendMessage fallback: " + (e1.message || e1)
            };
        } catch (e2) {
            throw MakeError(
                "Project save failed: " + (e1.message || e1) + " / " + (e2.message || e2));
        }
    }
}

function CmdListDocuments(params) {
    // [DOCUMENTED] Walk DM_LogicalDocuments on the focused (or named) project.
    var ws = GetWorkspace();
    if (!ws) throw MakeError("No workspace available.");

    var proj = null;
    if (params && params.projectPath) {
        proj = FindProjectByPath(ws, params.projectPath);
        if (!proj) throw MakeError("Project not open in workspace: " + params.projectPath);
    } else {
        proj = ws.DM_FocusedProject();
        if (!proj) return { hasProject: false, count: 0, documents: [] };
    }

    var docs = [];
    var count = 0;
    try { count = proj.DM_LogicalDocumentCount(); } catch (_) { count = 0; }
    for (var i = 0; i < count; i++) {
        var d;
        try { d = proj.DM_LogicalDocuments(i); } catch (_) { continue; }
        if (!d) continue;
        docs.push({
            path: SafeStr(function () { return d.DM_FullPath(); }),
            kind: SafeStr(function () { return d.DM_DocumentKind(); })
        });
    }
    return {
        hasProject: true,
        projectName: SafeStr(function () { return proj.DM_ProjectFileName(); }),
        projectPath: SafeStr(function () { return proj.DM_ProjectFullPath(); }),
        count: docs.length,
        documents: docs
    };
}

function CmdGetMessages(params) {
    // [DOCUMENTED] Read-only snapshot of the Messages panel, with optional
    // filters. Does NOT clear the panel. Callers driving compile/DRC should
    // use those dedicated commands, which clear the panel first.
    var limit = 200;
    var minLevel = "info";
    var sourceFilter = "";
    if (params) {
        if (params.limit !== undefined && params.limit !== null)
            limit = Number(params.limit) || 200;
        if (params.minLevel) minLevel = String(params.minLevel).toLowerCase();
        if (params.source) sourceFilter = String(params.source);
    }
    var minRank = LevelRank(minLevel);

    var enumerated = EnumerateMessages();
    var filtered = [];
    for (var i = 0; i < enumerated.messages.length; i++) {
        var m = enumerated.messages[i];
        // NOTE: AD's DXP script engine treats `class` as a reserved word,
        // so `m.class` fails to parse. Bracket access sidesteps the check.
        if (ClassRank(m["class"]) < minRank) continue;
        if (sourceFilter && String(m.source).indexOf(sourceFilter) < 0) continue;
        filtered.push(m);
    }
    // Most-recent-first ordering (per the shared schema comment).
    filtered.reverse();
    if (filtered.length > limit) filtered = filtered.slice(0, limit);

    var out = {
        messages: filtered,
        returned: filtered.length,
        total: enumerated.messages.length,
        counts: enumerated.counts
    };
    if (enumerated.note) out.note = enumerated.note;
    return out;
}

function CmdGetBoardInfo(_params) {
    // [DOCUMENTED] Reads the currently-loaded PCB document via PCBServer.
    // Returns board outline extents, layer count, component + net counts,
    // and unplaced/unrouted counts where those APIs are available.
    //
    // All accesses are defensive — if any DM_ or PCBServer method isn't
    // exposed on this AD build, we record it in `note` and keep going.
    var out = {
        hasPcb: false,
        layerCount: null,
        outlineMm: null,
        componentCount: null,
        netCount: null,
        unplacedCount: null,
        unroutedNetCount: null,
        notes: []
    };

    var server = null;
    try { server = PCBServer; } catch (_) { }
    if (!server) {
        try { server = GetBoardEnv_GetPCBServer(); } catch (_) { }
    }
    if (!server) {
        out.notes.push("PCBServer not available in this script context.");
        return out;
    }

    var board = null;
    try { board = server.GetCurrentPCBBoard(); } catch (e) {
        out.notes.push("GetCurrentPCBBoard threw: " + (e.message || e));
    }
    if (!board) {
        out.notes.push("No PCB document is currently focused.");
        return out;
    }
    out.hasPcb = true;

    // Layer count: walk LayerStack if available.
    try {
        var lstack = board.LayerStack_V7 || board.LayerStack;
        if (lstack) {
            var layers = 0;
            try { layers = lstack.SignalLayerCount(); } catch (_) { }
            if (!layers) { try { layers = lstack.LayerCount(); } catch (_) { } }
            if (layers) out.layerCount = layers;
        }
    } catch (e) {
        out.notes.push("Layer count unavailable: " + (e.message || e));
    }

    // Outline extents (in AD's internal coord units, convert to mm).
    try {
        var rect = board.BoardOutline_V7 ? board.BoardOutline_V7().BoundingRectangle()
                                         : board.BoardOutline.BoundingRectangle();
        if (rect) {
            var mm = 1 / 10000 * 0.254; // AD stores in 10,000ths of a mil; mil → mm = 0.0254
            out.outlineMm = {
                width:  Number((rect.Right - rect.Left) * 0.0000254),
                height: Number((rect.Top - rect.Bottom) * 0.0000254)
            };
        }
    } catch (e) {
        out.notes.push("Outline extents unavailable: " + (e.message || e));
    }

    // Counts via the board iterator.
    try {
        var iter = board.BoardIterator_Create();
        // eComponentObject = 4; eNetObject = 11
        var compSet = SetOf([4]);
        iter.AddFilter_ObjectSet(compSet);
        iter.AddFilter_LayerSet(null);
        iter.AddFilter_Method(null);
        var c = iter.FirstPCBObject();
        var compCount = 0;
        while (c) { compCount++; c = iter.NextPCBObject(); }
        board.BoardIterator_Destroy(iter);
        out.componentCount = compCount;
    } catch (e) {
        out.notes.push("Component count unavailable: " + (e.message || e));
    }

    try {
        var nets = 0;
        try { nets = board.DM_NetCount ? board.DM_NetCount() : board.GetNetCount(); } catch (_) { }
        if (nets) out.netCount = nets;
    } catch (e) {
        out.notes.push("Net count unavailable: " + (e.message || e));
    }

    return out;
}

function SetOf(ids) {
    // AD exposes MkSet(...) in DelphiScript contexts; in JScript it's trickier.
    // Returning the array is often enough for filter methods that accept a set
    // literal; if not, this becomes [DOCUMENTED] nonfunctional and the caller
    // records it in `notes`. Harmless either way.
    try { return MkSet(ids); } catch (_) { return ids; }
}

// Sprint 11 PR 11.1: paginated read of placed components with full
// layout fields. Walks BoardIterator over eComponentObject (=4),
// extracting designator / comment-as-MPN / footprint / position /
// layer / rotation / locked. Coordinates converted to mm at this
// boundary (AD's native is 10,000ths of a mil = 0.0000254 mm/unit)
// so the cross-platform contract stays unit-uniform.
//
// Per-field extraction is defensive: any field accessor that throws
// records "" / 0 / false rather than failing the whole call. The
// raw component object is NOT included in the returned envelope —
// IPCB_Component instances aren't JSON-serializable.
function CmdGetComponents(params) {
    var offset = Math.max(0, Math.floor((params && params.offset) || 0));
    var limit = Math.min(500, Math.max(1, Math.floor((params && params.limit) || 200)));

    var server = null;
    try { server = PCBServer; } catch (_) { }
    if (!server) {
        try { server = GetBoardEnv_GetPCBServer(); } catch (_) { }
    }
    if (!server) {
        throw MakeError("PCBServer not available in this script context.");
    }
    var board = null;
    try { board = server.GetCurrentPCBBoard(); } catch (e) {
        throw MakeError("GetCurrentPCBBoard threw: " + (e.message || e));
    }
    if (!board) {
        throw MakeError("No PCB document is currently focused.");
    }

    var iter = board.BoardIterator_Create();
    iter.AddFilter_ObjectSet(SetOf([4])); // eComponentObject = 4
    iter.AddFilter_LayerSet(null);
    iter.AddFilter_Method(null);

    // First pass: count for pagination total. Two-pass because
    // BoardIterator can't be rewound — we need the total for the
    // server's nextOffset math, AND we need to skip `offset` items
    // before collecting the page.
    var total = 0;
    var c = iter.FirstPCBObject();
    while (c) { total++; c = iter.NextPCBObject(); }
    board.BoardIterator_Destroy(iter);

    // Second pass: collect the requested page.
    var iter2 = board.BoardIterator_Create();
    iter2.AddFilter_ObjectSet(SetOf([4]));
    iter2.AddFilter_LayerSet(null);
    iter2.AddFilter_Method(null);
    var items = [];
    var idx = 0;
    var comp = iter2.FirstPCBObject();
    while (comp && items.length < limit) {
        if (idx >= offset) {
            items.push(ExtractComponent(comp, idx));
        }
        idx++;
        comp = iter2.NextPCBObject();
    }
    board.BoardIterator_Destroy(iter2);

    return { items: items, total: total };
}

// Pull the cross-platform fields off an IPCB_Component. Each accessor
// is wrapped in its own try/catch — an AD build that doesn't expose
// (say) `Locked` shouldn't drop the rest of the component's data.
function ExtractComponent(comp, idx) {
    var MM_PER_COORD = 0.0000254; // 1 internal coord unit = 1/10000 mil; mil → mm = 0.0254
    var out = {
        primitiveId: "comp_" + idx,
        designator: "",
        mpn: "",
        footprint: "",
        x: 0,
        y: 0,
        layer: "unknown",
        rotation: 0,
        locked: false,
        // Sprint 11 PR 11.4: bounding box in mm for validatePlacement.
        // Both stay 0 if BoundingRectangle isn't accessible — the
        // server treats 0 as "missing" and falls back to a 1mm
        // heuristic, tagging the result as approximate.
        width: 0,
        height: 0
    };
    try { out.designator = String(comp.Name || comp.LogicalDesignator || comp.SourceDesignator || ""); } catch (_) { }
    // AD's `Comment` field is the conventional home for MPN — not
    // every project populates it, but when set it's the closest thing
    // to a manufacturer part number on the AD side.
    try { out.mpn = String(comp.Comment || ""); } catch (_) { }
    try { out.footprint = String(comp.Pattern || comp.FootprintName || ""); } catch (_) { }
    try { out.x = Number(comp.XLocation) * MM_PER_COORD; } catch (_) { }
    try { out.y = Number(comp.YLocation) * MM_PER_COORD; } catch (_) { }
    try {
        // comp.Layer returns a layer object on some AD builds, an
        // integer enum on others. Best-effort: read the name property
        // if it's an object, else cast to string and let the server
        // normalize.
        var lyr = comp.Layer;
        if (lyr && typeof lyr === "object" && lyr.Name) {
            out.layer = String(lyr.Name);
        } else if (lyr !== null && lyr !== undefined) {
            out.layer = String(lyr);
        }
    } catch (_) { }
    try {
        var rot = Number(comp.Rotation);
        // Normalize to 0–360. AD reports negative values for
        // counter-rotated parts; cross-platform contract is
        // canonical positive.
        if (rot < 0) rot = ((rot % 360) + 360) % 360;
        if (rot >= 360) rot = rot % 360;
        out.rotation = rot;
    } catch (_) { }
    try { out.locked = Boolean(comp.Locked); } catch (_) { }
    // Sprint 11 PR 11.4: bounding box for placement validation.
    // BoundingRectangleNoNameComment excludes the silkscreen labels
    // (just the body), which is what placement-validation needs.
    // BoundingRectangle is the fallback for AD builds that don't
    // expose the no-name variant.
    try {
        var rect = null;
        try { rect = comp.BoundingRectangleNoNameComment(); } catch (_) { }
        if (!rect) { try { rect = comp.BoundingRectangle(); } catch (_) { } }
        if (rect && rect.Right !== undefined && rect.Left !== undefined) {
            out.width = (Number(rect.Right) - Number(rect.Left)) * MM_PER_COORD;
            out.height = (Number(rect.Top) - Number(rect.Bottom)) * MM_PER_COORD;
        }
    } catch (_) { }
    return out;
}

// Sprint 11 PR 11.2: shared designator → IPCB_Component lookup. Walks
// BoardIterator over eComponentObject and returns:
//   - the matching component when exactly one designator matches
//   - throws "no component" when zero match
//   - throws "multiple components" when 2+ match (malformed project —
//     don't silently mutate the first hit)
//
// Caller is responsible for destroying the iterator they pass in
// (via _iterRef), since an IPCB_Component reference doesn't survive
// the iterator being destroyed mid-walk on some AD builds.
function FindComponentByDesignator(board, designator) {
    var iter = board.BoardIterator_Create();
    iter.AddFilter_ObjectSet(SetOf([4]));
    iter.AddFilter_LayerSet(null);
    iter.AddFilter_Method(null);
    var match = null;
    var matchCount = 0;
    var c = iter.FirstPCBObject();
    while (c) {
        var d = "";
        try { d = String(c.Name || c.LogicalDesignator || c.SourceDesignator || ""); } catch (_) { }
        if (d === designator) {
            match = c;
            matchCount++;
            if (matchCount > 1) break; // Bail early once ambiguity confirmed.
        }
        c = iter.NextPCBObject();
    }
    if (matchCount === 0) {
        board.BoardIterator_Destroy(iter);
        throw MakeError("No component with designator '" + designator + "' on the active PCB.");
    }
    if (matchCount > 1) {
        board.BoardIterator_Destroy(iter);
        throw MakeError(
            "Multiple components with designator '" + designator +
            "'; refusing to mutate ambiguously."
        );
    }
    // NOTE: caller is responsible for keeping the iterator alive while
    // they hold the component ref (we can't destroy here without
    // potentially invalidating the ref). They call DestroyIter() below
    // after the mutation is complete.
    return { comp: match, iter: iter };
}

function DestroyIter(board, ref) {
    try { board.BoardIterator_Destroy(ref.iter); } catch (_) { }
}

// Common pre-mutation setup shared by move / rotate / lock. Returns
// {board, ref} or throws. Centralized so the three commands can't
// drift on the PCB-resolution / find-by-designator boundary.
function ResolveTarget(designator) {
    if (typeof designator !== "string" || designator.length === 0) {
        throw MakeError("designator is required");
    }
    var server = null;
    try { server = PCBServer; } catch (_) { }
    if (!server) {
        try { server = GetBoardEnv_GetPCBServer(); } catch (_) { }
    }
    if (!server) throw MakeError("PCBServer not available in this script context.");
    var board = null;
    try { board = server.GetCurrentPCBBoard(); } catch (e) {
        throw MakeError("GetCurrentPCBBoard threw: " + (e.message || e));
    }
    if (!board) throw MakeError("No PCB document is currently focused.");
    var ref = FindComponentByDesignator(board, designator);
    return { board: board, ref: ref };
}

// Sprint 11 PR 11.2: move a component to (x, y) in mm. Converts
// mm → AD's native 10000ths-of-a-mil (the inverse of CmdGetComponents'
// MM_PER_COORD). Refuses to mutate locked components — explicit
// intent forces the AI to call lock_component(false) first rather
// than relying on AD's silent-fail-or-unlock behavior.
function CmdMoveComponent(params) {
    var t = ResolveTarget(params && params.designator);
    var x = Number(params.x);
    var y = Number(params.y);
    if (!isFinite(x) || !isFinite(y)) {
        DestroyIter(t.board, t.ref);
        throw MakeError("x and y must be finite numbers (mm)");
    }
    var locked = false;
    try { locked = Boolean(t.ref.comp.Locked); } catch (_) { }
    if (locked) {
        DestroyIter(t.board, t.ref);
        throw MakeError(
            "Component '" + params.designator +
            "' is locked; call lock_component({locked: false}) first to unlock."
        );
    }
    var COORD_PER_MM = 1 / 0.0000254; // inverse of MM_PER_COORD
    try {
        t.ref.comp.SetState_XLocation(x * COORD_PER_MM);
        t.ref.comp.SetState_YLocation(y * COORD_PER_MM);
    } catch (e) {
        DestroyIter(t.board, t.ref);
        throw MakeError("SetState position failed: " + (e.message || e));
    }
    DestroyIter(t.board, t.ref);
    return {
        designator: params.designator,
        message: "Moved " + params.designator + " to (" + x.toFixed(2) + ", " + y.toFixed(2) + ") on Altium."
    };
}

// Sprint 11 PR 11.2: rotate a component to `rotation` degrees, 0-360.
// Refuses to mutate locked components, same as move.
function CmdRotateComponent(params) {
    var t = ResolveTarget(params && params.designator);
    var rot = Number(params.rotation);
    if (!isFinite(rot)) {
        DestroyIter(t.board, t.ref);
        throw MakeError("rotation must be a finite number (degrees)");
    }
    // Normalize to 0-360 to match what CmdGetComponents reports out.
    if (rot < 0) rot = ((rot % 360) + 360) % 360;
    if (rot >= 360) rot = rot % 360;
    var locked = false;
    try { locked = Boolean(t.ref.comp.Locked); } catch (_) { }
    if (locked) {
        DestroyIter(t.board, t.ref);
        throw MakeError(
            "Component '" + params.designator +
            "' is locked; call lock_component({locked: false}) first to unlock."
        );
    }
    try { t.ref.comp.SetState_Rotation(rot); }
    catch (e) {
        DestroyIter(t.board, t.ref);
        throw MakeError("SetState_Rotation failed: " + (e.message || e));
    }
    DestroyIter(t.board, t.ref);
    return {
        designator: params.designator,
        message: "Rotated " + params.designator + " to " + rot.toFixed(0) + "° on Altium."
    };
}

// Sprint 11 PR 11.2: lock or unlock. No locked-guard here — this IS
// the way to unlock something, so refusing-when-locked would create
// an unrecoverable state.
function CmdLockComponent(params) {
    var t = ResolveTarget(params && params.designator);
    var locked = Boolean(params && params.locked);
    try { t.ref.comp.SetState_Locked(locked); }
    catch (e) {
        DestroyIter(t.board, t.ref);
        throw MakeError("SetState_Locked failed: " + (e.message || e));
    }
    DestroyIter(t.board, t.ref);
    return {
        designator: params.designator,
        message: (locked ? "Locked " : "Unlocked ") + params.designator + " on Altium."
    };
}

// Sprint 11 PR 11.3: enumerate keepouts on the active PCB. Walks
// BoardIterator filtered to eRegionObject (=11) — keepouts in AD
// are regions on the keepout layer with `InComponent === false`
// (board-level keepouts; component-internal keepouts come from the
// component itself, not the board, and are out of scope).
//
// Per-region extraction is defensive: kind/layer/vertices accessors
// vary across AD builds. Anything we can't read becomes a default
// rather than dropping the whole keepout. Vertices converted from
// AD's 1/10000-mil to mm at this boundary, matching CmdGetComponents.
function CmdGetKeepouts(_params) {
    var server = null;
    try { server = PCBServer; } catch (_) { }
    if (!server) {
        try { server = GetBoardEnv_GetPCBServer(); } catch (_) { }
    }
    if (!server) throw MakeError("PCBServer not available in this script context.");
    var board = null;
    try { board = server.GetCurrentPCBBoard(); } catch (e) {
        throw MakeError("GetCurrentPCBBoard threw: " + (e.message || e));
    }
    if (!board) throw MakeError("No PCB document is currently focused.");

    var iter = board.BoardIterator_Create();
    iter.AddFilter_ObjectSet(SetOf([11])); // eRegionObject = 11
    iter.AddFilter_LayerSet(null);
    iter.AddFilter_Method(null);
    var items = [];
    var idx = 0;
    var r = iter.FirstPCBObject();
    while (r) {
        // Filter to keepout regions only — IsKeepOut on most builds,
        // fall back to checking the layer name for "keepout".
        var isKeepout = false;
        try { isKeepout = Boolean(r.IsKeepOut); } catch (_) { }
        if (!isKeepout) {
            try {
                var lyr = r.Layer;
                var lyrStr = lyr && typeof lyr === "object" && lyr.Name ? String(lyr.Name) : String(lyr);
                if (lyrStr.toLowerCase().indexOf("keepout") >= 0) isKeepout = true;
            } catch (_) { }
        }
        if (isKeepout) {
            items.push(ExtractKeepout(r, idx));
        }
        idx++;
        r = iter.NextPCBObject();
    }
    board.BoardIterator_Destroy(iter);
    return { items: items };
}

// Pull cross-platform fields off an IPCB_Region instance. Each
// accessor wrapped in its own try/catch so missing one (across AD
// builds) doesn't drop the rest of the keepout. Vertices converted
// to mm.
function ExtractKeepout(region, idx) {
    var MM_PER_COORD = 0.0000254;
    var out = {
        id: "kpo_" + idx,
        kind: "all",
        layer: "all",
        vertices: []
    };
    try {
        var lyr = region.Layer;
        if (lyr && typeof lyr === "object" && lyr.Name) {
            out.layer = String(lyr.Name);
        } else if (lyr !== null && lyr !== undefined) {
            out.layer = String(lyr);
        }
    } catch (_) { }
    // Kind: AD exposes `RegionKind` or `KeepoutKind` depending on
    // build. Both report ePlacementKeepout / eRoutingKeepout / etc.
    // Server normalizes via normalizeKeepoutKind — we just pass
    // the raw string through.
    try {
        var k = region.RegionKind || region.KeepoutKind;
        if (k !== null && k !== undefined) out.kind = String(k);
    } catch (_) { }
    // Vertices: most builds expose PointCount + PointAt(i). Some
    // expose GetState_Vertices() returning an array directly.
    try {
        if (typeof region.GetState_Vertices === "function") {
            var arr = region.GetState_Vertices();
            if (arr && arr.length !== undefined) {
                for (var i = 0; i < arr.length; i++) {
                    var v = arr[i];
                    if (v && v.X !== undefined && v.Y !== undefined) {
                        out.vertices.push({
                            x: Number(v.X) * MM_PER_COORD,
                            y: Number(v.Y) * MM_PER_COORD
                        });
                    }
                }
            }
        } else if (typeof region.PointCount === "function" || region.PointCount !== undefined) {
            var count = typeof region.PointCount === "function"
                ? region.PointCount()
                : Number(region.PointCount);
            for (var j = 0; j < count; j++) {
                try {
                    var p = typeof region.PointAt === "function"
                        ? region.PointAt(j)
                        : region.Point(j);
                    if (p && p.X !== undefined && p.Y !== undefined) {
                        out.vertices.push({
                            x: Number(p.X) * MM_PER_COORD,
                            y: Number(p.Y) * MM_PER_COORD
                        });
                    }
                } catch (_) { }
            }
        }
    } catch (_) { }
    return out;
}

// Sprint 12 PR 12.1: enumerate routing per net. Single BoardIterator
// pass over eTrackObject (=3) + eViaObject (=5) + eRatNestObject
// (=14), aggregating into a net-keyed dictionary. Two-pass for
// pagination (count nets, then slice). Coordinates in mm at the
// boundary, matching CmdGetComponents.
//
// Per-segment extraction is defensive — accessor variations across
// AD builds shouldn't drop a whole net's data.
function CmdGetNetRouting(params) {
    var offset = Math.max(0, Math.floor((params && params.offset) || 0));
    var limit = Math.min(500, Math.max(1, Math.floor((params && params.limit) || 200)));
    var MM_PER_COORD = 0.0000254;

    var server = null;
    try { server = PCBServer; } catch (_) { }
    if (!server) {
        try { server = GetBoardEnv_GetPCBServer(); } catch (_) { }
    }
    if (!server) throw MakeError("PCBServer not available in this script context.");
    var board = null;
    try { board = server.GetCurrentPCBBoard(); } catch (e) {
        throw MakeError("GetCurrentPCBBoard threw: " + (e.message || e));
    }
    if (!board) throw MakeError("No PCB document is currently focused.");

    // Aggregate per net.
    var byNet = {}; // netName → {totalLengthMm, layers, viaCount, unroutedSegments}
    function ensureNet(name) {
        if (!byNet[name]) {
            byNet[name] = {
                totalLengthMm: 0,
                layers: {},
                viaCount: 0,
                unroutedSegments: 0
            };
        }
        return byNet[name];
    }

    // Walk traces (eTrackObject = 3) + vias (eViaObject = 5) + rat
    // lines (eRatNestObject = 14) in a single iterator pass. Each
    // object's Net.Name keys the aggregation.
    var iter = board.BoardIterator_Create();
    iter.AddFilter_ObjectSet(SetOf([3, 5, 14]));
    iter.AddFilter_LayerSet(null);
    iter.AddFilter_Method(null);
    var obj = iter.FirstPCBObject();
    while (obj) {
        var netName = "";
        try {
            var net = obj.Net;
            if (net && net.Name) netName = String(net.Name);
        } catch (_) { }
        // Skip orphan objects (no net) — they'd aggregate under "" and
        // confuse callers.
        if (netName.length > 0) {
            var entry = ensureNet(netName);
            var kind = 0;
            try { kind = Number(obj.ObjectId); } catch (_) { }
            if (kind === 3) {
                // Trace: length = sqrt((x2-x1)^2 + (y2-y1)^2)
                try {
                    var dx = (Number(obj.X2) - Number(obj.X1)) * MM_PER_COORD;
                    var dy = (Number(obj.Y2) - Number(obj.Y1)) * MM_PER_COORD;
                    var len = Math.sqrt(dx * dx + dy * dy);
                    if (isFinite(len)) entry.totalLengthMm += len;
                } catch (_) { }
                try {
                    var lyr = obj.Layer;
                    var lyrStr = lyr && typeof lyr === "object" && lyr.Name
                        ? String(lyr.Name) : String(lyr);
                    var dxl = (Number(obj.X2) - Number(obj.X1)) * MM_PER_COORD;
                    var dyl = (Number(obj.Y2) - Number(obj.Y1)) * MM_PER_COORD;
                    var lenL = Math.sqrt(dxl * dxl + dyl * dyl);
                    if (isFinite(lenL)) {
                        entry.layers[lyrStr] = (entry.layers[lyrStr] || 0) + lenL;
                    }
                } catch (_) { }
            } else if (kind === 5) {
                entry.viaCount++;
            } else if (kind === 14) {
                entry.unroutedSegments++;
            }
        }
        obj = iter.NextPCBObject();
    }
    board.BoardIterator_Destroy(iter);

    // Collect into a sorted list (alphabetical by net name) so
    // pagination is stable across calls.
    var netNames = [];
    for (var n in byNet) {
        if (Object.prototype.hasOwnProperty.call(byNet, n)) netNames.push(n);
    }
    netNames.sort();
    var total = netNames.length;
    var sliceNames = netNames.slice(offset, offset + limit);
    var items = [];
    for (var i = 0; i < sliceNames.length; i++) {
        var name = sliceNames[i];
        var d = byNet[name];
        items.push({
            netName: name,
            totalLengthMm: d.totalLengthMm,
            layers: d.layers,
            viaCount: d.viaCount,
            unroutedSegments: d.unroutedSegments
        });
    }
    return { items: items, total: total };
}

function CmdGetStackup(_params) {
    // [DOCUMENTED] Reads the LayerStack on the currently-loaded PCB.
    // Reports signal/internal/power layer order with material + thickness.
    var out = {
        hasPcb: false,
        layers: [],
        totalThicknessMm: null,
        notes: []
    };

    var server = null;
    try { server = PCBServer; } catch (_) { }
    if (!server) { out.notes.push("PCBServer not available."); return out; }

    var board = null;
    try { board = server.GetCurrentPCBBoard(); } catch (_) { }
    if (!board) { out.notes.push("No PCB document focused."); return out; }
    out.hasPcb = true;

    var stack = null;
    try { stack = board.LayerStack_V7 || board.LayerStack; } catch (_) { }
    if (!stack) { out.notes.push("LayerStack accessor unavailable."); return out; }

    var totalUm = 0;
    try {
        // Iterate layers via LayerCount + LayerObject_V7(i) if present.
        var n = 0;
        try { n = stack.LayerCount(); } catch (_) { }
        for (var i = 0; i < n; i++) {
            var layer;
            try { layer = stack.LayerObject_V7(i); } catch (_) { continue; }
            if (!layer) continue;
            var entry = {
                index: i,
                name:       SafeStr(function () { return layer.Name; }),
                kind:       SafeStr(function () { return layer.LayerKind; }),
                material:   SafeStr(function () { return layer.Material; }),
                thicknessUm: null
            };
            try {
                var t = layer.CopperThickness;
                if (typeof t === "number" && t > 0) entry.thicknessUm = t;
            } catch (_) { }
            if (!entry.thicknessUm) {
                try {
                    var t2 = layer.DielectricHeight;
                    if (typeof t2 === "number" && t2 > 0) entry.thicknessUm = t2;
                } catch (_) { }
            }
            if (entry.thicknessUm) totalUm += entry.thicknessUm;
            out.layers.push(entry);
        }
    } catch (e) {
        out.notes.push("Layer iteration failed: " + (e.message || e));
    }

    if (totalUm > 0) out.totalThicknessMm = totalUm / 1000;
    return out;
}

function CmdDebugIntrospectMessages(_params) {
    // Probe DM_MessagesManager (and the workspace itself) for accessors
    // related to the Messages panel. The actual API shape varies across AD
    // builds; this reports what's ACTUALLY available on the live object
    // so EnumerateMessages can be patched with the correct names.

    var report = {
        workspace: { available: false, candidates: {} },
        manager:   { available: false, candidates: {}, note: "" },
        sample:    null,
        forInKeys: []
    };

    // Workspace probes — sometimes messages live on the workspace directly.
    var ws = null;
    try {
        ws = GetWorkspace();
        report.workspace.available = !!ws;
    } catch (e) {
        report.workspace.note = "GetWorkspace() threw: " + (e.message || e);
    }
    if (ws) {
        var wsCandidates = [
            "DM_MessagesManager", "DM_MessageManager",
            "DM_Messages", "DM_MessageCount",
            "MessagesManager", "MessageManager"
        ];
        for (var i = 0; i < wsCandidates.length; i++) {
            var k = wsCandidates[i];
            report.workspace.candidates[k] = ProbeMember(ws, k);
        }
    }

    // MessagesManager probes — the real target.
    var mm = null;
    try {
        if (ws) mm = ws.DM_MessagesManager();
        report.manager.available = !!mm;
    } catch (e) {
        report.manager.note = "ws.DM_MessagesManager() threw: " + (e.message || e);
    }
    if (mm) {
        // Everything we might use to get a count or iterate the list.
        var mmCandidates = [
            "DM_MessageCount", "DM_Count", "Count", "MessageCount",
            "DM_Messages", "DM_Message", "Messages", "Message",
            "DM_GetMessage", "GetMessage", "Item",
            "DM_MessageIterator", "MessageIterator",
            "DM_Clear", "Clear"
        ];
        for (var j = 0; j < mmCandidates.length; j++) {
            var key = mmCandidates[j];
            report.manager.candidates[key] = ProbeMember(mm, key);
        }

        // Try each count-like accessor and, if it returns a number > 0,
        // attempt to fetch the first message through each plausible list
        // accessor so we can see the MESSAGE object's shape too.
        var countNames = ["DM_MessageCount", "DM_Count", "Count", "MessageCount"];
        var listNames  = ["DM_Messages", "DM_Message", "Messages", "Item", "DM_GetMessage", "GetMessage"];
        for (var ci = 0; ci < countNames.length && report.sample === null; ci++) {
            var cn = countNames[ci];
            var count = null;
            try { count = mm[cn](); } catch (_) { continue; }
            if (typeof count !== "number" || count <= 0) continue;
            for (var li = 0; li < listNames.length; li++) {
                var ln = listNames[li];
                var first = null;
                try { first = mm[ln](0); } catch (_) { continue; }
                if (!first) continue;
                report.sample = {
                    countAccessor: cn,
                    countValue: count,
                    listAccessor: ln,
                    messageShape: ProbeMessageShape(first)
                };
                break;
            }
        }

        // `for...in` rarely enumerates COM object methods, but it costs
        // nothing to try; some DXP-hosted objects do surface keys.
        try {
            for (var k2 in mm) {
                report.forInKeys.push(String(k2));
                if (report.forInKeys.length > 200) break;
            }
        } catch (_) { /* ignore */ }
    }

    return report;
}

function ProbeMember(obj, name) {
    var t = "missing";
    try { t = typeof obj[name]; } catch (_) { t = "threw"; }
    var callable = false;
    if (t === "function") {
        callable = true;
    } else if (t !== "undefined" && t !== "missing" && t !== "threw") {
        callable = false; // it's a plain property
    }
    var out = { type: t, callable: callable };
    // If it looks like a zero-arg method, try calling it and note the return type.
    if (callable) {
        try {
            var v = obj[name]();
            out.returns = typeof v;
            if (typeof v === "number") out.value = v;
        } catch (e) {
            out.callThrew = (e.message || String(e));
        }
    }
    return out;
}

function ProbeMessageShape(msg) {
    // Try reading the usual per-message accessors to see which exist.
    var accessors = [
        "DM_Class", "DM_Document", "DM_Source", "DM_Text", "DM_Time",
        "DM_Severity", "DM_Level", "DM_Type", "DM_Kind",
        "Class", "Document", "Source", "Text", "Time", "Severity"
    ];
    var shape = {};
    for (var i = 0; i < accessors.length; i++) {
        shape[accessors[i]] = ProbeMember(msg, accessors[i]);
    }
    return shape;
}

function LevelRank(level) {
    if (level === "fatal")   return 3;
    if (level === "error")   return 2;
    if (level === "warning") return 1;
    return 0; // info / hint / status / anything else
}

function ClassRank(cls) {
    var c = (cls || "").toLowerCase();
    if (c.indexOf("fatal")   >= 0) return 3;
    if (c.indexOf("error")   >= 0) return 2;
    if (c.indexOf("warning") >= 0) return 1;
    return 0;
}

function FindProjectByPath(ws, path) {
    var target = String(path).toLowerCase();
    try {
        var n = ws.DM_ProjectCount();
        for (var i = 0; i < n; i++) {
            var p;
            try { p = ws.DM_Projects(i); } catch (_) { continue; }
            if (!p) continue;
            var pp = SafeStr(function () { return p.DM_ProjectFullPath(); }).toLowerCase();
            if (pp === target) return p;
        }
    } catch (_) { /* fall through to null */ }
    return null;
}

function DeriveSchematicPath(projectPath) {
    // Replace .PrjPcb (case-insensitive) with .SchDoc; if no match, append.
    var re = /\.PrjPcb$/i;
    if (re.test(projectPath)) return projectPath.replace(re, ".SchDoc");
    return projectPath + ".SchDoc";
}

function TryAddStringParameter(key, value) {
    // AddStringParameter is a global from AD's script environment.
    try { AddStringParameter(key, value); } catch (_) { /* older AD / wrong key */ }
}

function EnsureDirectoryFor(filePath) {
    try {
        var fso = new ActiveXObject("Scripting.FileSystemObject");
        var parentDir = fso.GetParentFolderName(filePath);
        EnsureFolderRecursive(fso, parentDir);
    } catch (_) { /* best-effort — AD will error on save if the dir is really missing */ }
}

function EnsureFolderRecursive(fso, dir) {
    if (!dir) return;
    if (fso.FolderExists(dir)) return;
    var parent = fso.GetParentFolderName(dir);
    if (parent && parent !== dir) EnsureFolderRecursive(fso, parent);
    try { fso.CreateFolder(dir); } catch (_) { /* race or perms */ }
}

function CmdCompileProject(_params) {
    // [DOCUMENTED] Project:Compile compiles the focused project.
    // We clear the Messages panel first so we only return ERC output
    // from THIS compile, not leftover entries from earlier runs.
    ResetParametersAD();
    ClearMessages();
    Client.SendMessage("Project:Compile", "", 512, Client.CurrentView);
    // AD compile is synchronous from the script's perspective — when
    // SendMessage returns, compile is done and the Messages panel is populated.
    var enumerated = EnumerateMessages();
    var result = {
        compiled: true,
        messages: enumerated.messages,
        counts: enumerated.counts
    };
    if (enumerated.note) result.note = enumerated.note;
    return result;
}

function CmdRunDrc(params) {
    // [DOCUMENTED] PCB:DesignRulesCheck. Violations are exposed via the
    // PCB board iterator (eViolationObject). This implementation just
    // triggers the DRC; enumerating violations is TODO.
    Client.SendMessage("PCB:DesignRulesCheck", "Action=Run", 512, Client.CurrentView);
    // TODO: iterate PCBServer.GetCurrentPCBBoard() for violations and
    // return them here. For v1 we return a marker.
    return {
        triggered: true,
        violations: [],
        note: "Violation enumeration is a TODO; see AD's Messages / Violations panel."
    };
}

function CmdAnnotateSchematic(params) {
    // [DOCUMENTED] Tools:Annotate with silent parameters.
    // Order mapping — values are the internal AD enum strings.
    var orderMap = {
        "up_then_across":    "UpThenAcross",
        "down_then_across":  "DownThenAcross",
        "across_then_up":    "AcrossThenUp",
        "across_then_down":  "AcrossThenDown"
    };
    var order = orderMap[params.order || "across_then_down"];
    Client.SendMessage(
        "Sch:Annotate",
        "Silent=True|Order=" + order + "|UpdateMatch=True",
        512,
        Client.CurrentView
    );
    return { annotated: true, order: params.order };
}

function CmdGenerateOutputs(params) {
    // [DOCUMENTED] Project:GenerateReport or OutJob "Generate" command.
    // With no outJobName, AD uses the active OutJob.
    var args = "Action=Run";
    if (params.outJobName) args += "|OutJob=" + params.outJobName;
    Client.SendMessage("Project:Generate", args, 512, Client.CurrentView);
    return { generated: true, outJobName: params.outJobName || "(active)" };
}

function CmdAutoPlace(params) {
    // [DOCUMENTED] PCB:Place auto-placement.
    var algo = params.algorithm || "cluster";
    Client.SendMessage(
        "PCB:Place",
        "Action=AutoPlace|Algorithm=" + algo,
        512,
        Client.CurrentView
    );
    return { placed: true, algorithm: algo };
}

function CmdAutoRoute(params) {
    // [DOCUMENTED] PCB:Route via Situs.
    var scope = params.scope || "all";
    var args = "Action=AutoRoute|Scope=" + scope;
    if (scope === "net") {
        if (!params.netName) throw MakeError("netName is required when scope='net'");
        args += "|Net=" + params.netName;
    }
    Client.SendMessage("PCB:Route", args, 512, Client.CurrentView);
    return { routed: true, scope: scope, netName: params.netName || null };
}

// ─────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────

function MakeError(msg, detail, code) {
    var e = new Error(msg);
    if (detail) e.detail = detail;
    if (code) e.code = code;
    return e;
}

function RequireString(obj, key) {
    if (obj[key] === undefined || obj[key] === null || obj[key] === "") {
        throw MakeError("param '" + key + "' is required");
    }
}

function InitLog() {
    if (LOG_FILE !== null) return;
    try {
        var shell = new ActiveXObject("WScript.Shell");
        var temp = shell.ExpandEnvironmentStrings("%TEMP%");
        LOG_FILE = temp + "\\AltiumRelay.log";
    } catch (_) {
        LOG_FILE = "C:\\Temp\\AltiumRelay.log";
    }
}

function Log(msg) {
    // NO modal dialogs — each one would block the polling loop.
    // Append to %TEMP%\AltiumRelay.log instead.
    try {
        if (LOG_FILE === null) InitLog();
        var fso = new ActiveXObject("Scripting.FileSystemObject");
        var ts = fso.OpenTextFile(LOG_FILE, 8 /* ForAppending */, true);
        ts.WriteLine(IsoNow() + "  " + msg);
        ts.Close();
    } catch (_) { /* silently ignore — logging must never throw */ }
}

function IsoNow() {
    // AD's script engine doesn't implement Date.prototype.toISOString.
    // Hand-roll a compatible string: 2026-04-24T00:13:37.705Z
    var d = new Date();
    function pad(n, w) { var s = String(n); while (s.length < w) s = "0" + s; return s; }
    return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1, 2) + "-" + pad(d.getUTCDate(), 2)
        + "T" + pad(d.getUTCHours(), 2) + ":" + pad(d.getUTCMinutes(), 2) + ":" + pad(d.getUTCSeconds(), 2)
        + "." + pad(d.getUTCMilliseconds(), 3) + "Z";
}

function Sleep(ms) {
    // AD scripts have no native sleep; bounce through a WSH spin.
    var shell = new ActiveXObject("WScript.Shell");
    shell.Run("cmd /c ping 127.0.0.1 -n " + Math.max(1, Math.round(ms / 1000) + 1) + " > nul", 0, true);
}

function ResetParametersAD() {
    try { ResetParameters(); } catch (_) { /* older AD only */ }
}

// ─────────────────────────────────────────────────────────────────────
// Messages panel integration
//
// AD surfaces ERC / DRC / compile output through GetWorkspace().DM_MessagesManager.
// The interface uses DelphiScript-style DM_ prefixes and is callable from
// the DXP JScript engine as methods (not properties).
//
// This helper is defensive: the DM_ API shape varies slightly across AD
// builds, so we feature-detect each accessor and fall back to an empty
// result with a diagnostic note if enumeration fails. Callers should
// always check `result.note` to see whether enumeration actually worked.
// ─────────────────────────────────────────────────────────────────────

function ClearMessages() {
    // Best-effort — if the command isn't available, we just skip the clear
    // and the caller will get mixed old+new messages back.
    try {
        Client.SendMessage("System:ClearMessages", "", 512, Client.CurrentView);
    } catch (_) {
        try {
            Client.SendMessage("Workspace:ClearMessages", "", 512, Client.CurrentView);
        } catch (__) { /* ignore */ }
    }
}

function EnumerateMessages() {
    var out = { messages: [], counts: { error: 0, warning: 0, info: 0, fatal: 0, other: 0 } };
    var mm = ResolveMessagesManager();
    if (!mm.manager) { out.note = mm.note; return out; }
    var manager = mm.manager;

    var strat = SelectMessageAccessors(manager);
    if (!strat) {
        out.note = "DM_MessagesManager acquired via " + mm.via
            + " but no known count accessor worked. Tried: "
            + "DM_MessageCount()/prop, MessageCount()/prop, Count()/prop, Length. "
            + "Extend SelectMessageAccessors() with the correct names for this AD build.";
        return out;
    }

    var count = 0;
    try { count = strat.count(manager); }
    catch (e) {
        out.note = "Count read failed via '" + strat.name + "': " + (e.message || e);
        return out;
    }

    for (var i = 0; i < count; i++) {
        var msg = null;
        try { msg = strat.item(manager, i); } catch (_) { continue; }
        if (!msg) continue;

        var entry = {
            // Quote reserved words as object keys — AD's DXP script parser
            // rejects `class:` but accepts `"class":`.
            "class":  ReadFieldFlex(msg, ["DM_Class",    "Class"]),
            document: ReadFieldFlex(msg, ["DM_Document", "Document"]),
            source:   ReadFieldFlex(msg, ["DM_Source",   "Source"]),
            message:  ReadFieldFlex(msg, ["DM_Text",     "Text", "Message"]),
            time:     ReadFieldFlex(msg, ["DM_Time",     "Time"])
        };
        out.messages.push(entry);

        var cls = (entry["class"] || "").toLowerCase();
        if (cls.indexOf("fatal") >= 0)        out.counts.fatal++;
        else if (cls.indexOf("error") >= 0)   out.counts.error++;
        else if (cls.indexOf("warning") >= 0) out.counts.warning++;
        else if (cls.indexOf("info") >= 0 || cls.indexOf("hint") >= 0 || cls.indexOf("status") >= 0)
            out.counts.info++;
        else                                  out.counts.other++;
    }
    out.accessor = strat.name;
    return out;
}

function ResolveMessagesManager() {
    // AD's DM_MessagesManager may be exposed as a method call, a property,
    // or via a top-level helper depending on the build. Try each in order
    // and record which path succeeded for diagnostics.
    var ws = null;
    try { ws = GetWorkspace(); }
    catch (e) { return { note: "GetWorkspace threw: " + (e.message || e) }; }
    if (!ws) return { note: "GetWorkspace returned null." };

    try { var m = ws.DM_MessagesManager(); if (m) return { manager: m, via: "ws.DM_MessagesManager()" }; } catch (_) {}
    try { var m2 = ws.DM_MessagesManager;   if (m2) return { manager: m2, via: "ws.DM_MessagesManager (prop)" }; } catch (_) {}
    try { var m3 = GetMessagesManager();    if (m3) return { manager: m3, via: "GetMessagesManager()" }; } catch (_) {}

    return { note: "No DM_MessagesManager accessor found (tried method, property, global helper)." };
}

function SelectMessageAccessors(mm) {
    // Probe common count+item pairings. The first count call that returns
    // a non-negative number wins. We avoid actually fetching an item so an
    // empty-but-valid manager doesn't fail the probe.
    var candidates = [
        { name: "DM_MessageCount() / DM_Messages(i)",
          count: function (m) { return m.DM_MessageCount(); },
          item:  function (m, i) { return m.DM_Messages(i); } },
        { name: "DM_MessageCount (prop) / DM_Messages(i)",
          count: function (m) { return m.DM_MessageCount; },
          item:  function (m, i) { return m.DM_Messages(i); } },
        { name: "MessageCount() / Messages(i)",
          count: function (m) { return m.MessageCount(); },
          item:  function (m, i) { return m.Messages(i); } },
        { name: "MessageCount (prop) / Messages(i)",
          count: function (m) { return m.MessageCount; },
          item:  function (m, i) { return m.Messages(i); } },
        { name: "Count() / Item(i)",
          count: function (m) { return m.Count(); },
          item:  function (m, i) { return m.Item(i); } },
        { name: "Count (prop) / Item(i)",
          count: function (m) { return m.Count; },
          item:  function (m, i) { return m.Item(i); } },
        { name: "Length (prop) / [i]",
          count: function (m) { return m.Length; },
          item:  function (m, i) { return m[i]; } }
    ];
    for (var k = 0; k < candidates.length; k++) {
        try {
            var n = candidates[k].count(mm);
            if (typeof n === "number" && !isNaN(n) && n >= 0) return candidates[k];
        } catch (_) { /* try next */ }
    }
    return null;
}

function ReadFieldFlex(obj, names) {
    // Try each name as method first, then as property. Returns "" if none hit.
    for (var i = 0; i < names.length; i++) {
        var n = names[i];
        try {
            if (typeof obj[n] === "function") {
                var v = obj[n]();
                if (v !== undefined && v !== null) return String(v);
            }
        } catch (_) { /* try next form */ }
        try {
            var p = obj[n];
            if (typeof p !== "function" && p !== undefined && p !== null) return String(p);
        } catch (_) { /* try next name */ }
    }
    return "";
}

function SafeStr(fn) {
    try {
        var v = fn();
        return (v === null || v === undefined) ? "" : String(v);
    } catch (_) { return ""; }
}

// ─────────────────────────────────────────────────────────────────────
// Hand-rolled JSON (AD's script engine has no native JSON object)
// ─────────────────────────────────────────────────────────────────────

function JsonStringify(v) {
    if (v === null || v === undefined) return "null";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") return isFinite(v) ? String(v) : "null";
    if (typeof v === "string") return JsonEscapeString(v);
    if (v instanceof Array) {
        var out = [];
        for (var i = 0; i < v.length; i++) out.push(JsonStringify(v[i]));
        return "[" + out.join(",") + "]";
    }
    // object
    var parts = [];
    for (var k in v) {
        if (v.hasOwnProperty(k)) {
            parts.push(JsonEscapeString(k) + ":" + JsonStringify(v[k]));
        }
    }
    return "{" + parts.join(",") + "}";
}

function JsonEscapeString(s) {
    var out = '"';
    for (var i = 0; i < s.length; i++) {
        var c = s.charAt(i);
        if (c === '\\' || c === '"') out += '\\' + c;
        else if (c === '\n') out += '\\n';
        else if (c === '\r') out += '\\r';
        else if (c === '\t') out += '\\t';
        else if (c < ' ') out += '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4);
        else out += c;
    }
    return out + '"';
}

function JsonParse(s) {
    // eval() is the AD-engine-compatible path; the server controls this payload.
    return eval("(" + s + ")");
}
