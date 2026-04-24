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
        case "compile_project":    return CmdCompileProject(cmd.params);
        case "run_drc":            return CmdRunDrc(cmd.params);
        case "annotate_schematic": return CmdAnnotateSchematic(cmd.params);
        case "generate_outputs":   return CmdGenerateOutputs(cmd.params);
        case "auto_place":         return CmdAutoPlace(cmd.params);
        case "auto_route":         return CmdAutoRoute(cmd.params);
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
    // [EXPERIMENTAL] Create a new PCB project via the WorkspaceManager
    // NewProject process, then save-as to the requested path. Optionally
    // create + save an empty .SchDoc as a source document.
    //
    // AD's WorkspaceManager:NewProject API accepts parameters via the
    // global ResetParameters / AddStringParameter mechanism. The exact
    // parameter names vary across AD builds; we pass several known
    // aliases defensively.
    RequireString(params, "projectPath");
    var projectPath = params.projectPath;
    var addSchematic = (params.addSchematic !== false); // default true
    var notes = [];

    EnsureDirectoryFor(projectPath);

    // 1. Create a new PCB project in memory.
    ResetParametersAD();
    TryAddStringParameter("NewProjectType", "PCB");
    TryAddStringParameter("ProjectKind", "PCB");
    TryAddStringParameter("ObjectKind", "PCB_Project");
    Client.SendMessage("WorkspaceManager:NewProject", "", 512, Client.CurrentView);

    var ws = GetWorkspace();
    if (!ws) throw MakeError("No workspace available after NewProject.");
    var proj = ws.DM_FocusedProject();
    if (!proj) throw MakeError("NewProject ran but no focused project was found.");

    // 2. Save-as to the requested path. Try the native DM method first,
    //    fall back to the SendMessage form.
    var savedProject = false;
    try {
        proj.DM_DoSaveAs(projectPath);
        savedProject = true;
    } catch (e1) {
        try {
            Client.SendMessage(
                "WorkspaceManager:SaveProject",
                "ObjectKind=Project|FileName=" + projectPath,
                512, Client.CurrentView);
            savedProject = true;
        } catch (e2) {
            notes.push("Project save fallbacks failed: "
                + (e1.message || e1) + " / " + (e2.message || e2));
        }
    }

    // 3. Optionally create + save a blank schematic as a project source doc.
    var schematicPath = null;
    if (addSchematic) {
        ResetParametersAD();
        TryAddStringParameter("ObjectKind", "Schematic");
        TryAddStringParameter("NewDocumentType", "Schematic");
        Client.SendMessage("WorkspaceManager:NewDocument", "", 512, Client.CurrentView);

        schematicPath = DeriveSchematicPath(projectPath);
        try {
            Client.SendMessage(
                "Sch:DocumentSaveAs",
                "ObjectKind=Schematic|FileName=" + schematicPath,
                512, Client.CurrentView);
        } catch (e) {
            notes.push("Schematic save failed: " + (e.message || e));
            schematicPath = null;
        }

        // Re-save the project so the new doc is recorded in membership.
        try {
            Client.SendMessage("Project:Save", "", 512, Client.CurrentView);
        } catch (_) { /* best-effort */ }
    }

    var out = {
        projectPath: projectPath,
        schematicPath: schematicPath,
        savedProject: savedProject
    };
    if (notes.length) out.note = notes.join("; ");
    return out;
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
        if (ClassRank(m.class) < minRank) continue;
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
    var mm = null;
    try {
        var ws = GetWorkspace();
        if (!ws) { out.note = "No workspace available for message enumeration."; return out; }
        mm = ws.DM_MessagesManager();
    } catch (e) {
        out.note = "DM_MessagesManager unavailable: " + (e.message || e);
        return out;
    }
    if (!mm) { out.note = "DM_MessagesManager returned null."; return out; }

    var count = 0;
    try { count = mm.DM_MessageCount(); }
    catch (e) {
        out.note = "DM_MessageCount unavailable: " + (e.message || e);
        return out;
    }

    for (var i = 0; i < count; i++) {
        var msg;
        try { msg = mm.DM_Messages(i); } catch (_) { continue; }
        if (!msg) continue;

        var entry = {
            class:    SafeStr(function () { return msg.DM_Class(); }),
            document: SafeStr(function () { return msg.DM_Document(); }),
            source:   SafeStr(function () { return msg.DM_Source(); }),
            message:  SafeStr(function () { return msg.DM_Text(); }),
            time:     SafeStr(function () { return msg.DM_Time(); })
        };
        out.messages.push(entry);

        var cls = (entry.class || "").toLowerCase();
        if (cls.indexOf("fatal") >= 0)        out.counts.fatal++;
        else if (cls.indexOf("error") >= 0)   out.counts.error++;
        else if (cls.indexOf("warning") >= 0) out.counts.warning++;
        else if (cls.indexOf("info") >= 0 || cls.indexOf("hint") >= 0 || cls.indexOf("status") >= 0)
            out.counts.info++;
        else                                  out.counts.other++;
    }
    return out;
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
