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
// Command Line panel, or just close the project / AD — the server
// will detect the disconnect on the next timeout.
//
// Notes on the AD scripting environment:
//   - This runs in AD's "DXP" ECMAScript-like engine. It's NOT modern
//     JS. No let/const/arrow funcs — stick to var + function.
//   - COM objects are available via "new ActiveXObject(...)".
//   - XMLHttpRequest is NOT available; we use Msxml2.XMLHTTP.
//   - Blocking calls are fine — AD's script runtime is single-threaded,
//     but the server's long-poll keeps CPU idle while waiting.
// ─────────────────────────────────────────────────────────────────────

var RELAY_URL = "http://127.0.0.1:3000/ad-relay";
var g_stop = false;

function Main() {
    g_stop = false;
    Log("AltiumRelay starting. Server: " + RELAY_URL);
    Log("To stop: set g_stop=true or close Altium Designer.");

    var emptyPolls = 0;
    while (!g_stop) {
        var cmd = null;
        try {
            cmd = PollNext();
        } catch (e) {
            Log("Poll error: " + e.message + " (retrying in 2s)");
            Sleep(2000);
            continue;
        }

        if (cmd === null) {
            // 204 — no command this cycle; re-poll.
            emptyPolls++;
            if (emptyPolls % 10 === 0) Log("Idle (" + emptyPolls + " empty polls)");
            continue;
        }
        emptyPolls = 0;

        var result;
        try {
            result = Dispatch(cmd);
            PostResult(cmd.id, true, result, null);
        } catch (err) {
            Log("Command '" + cmd.method + "' failed: " + err.message);
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

function PollNext() {
    var xhr = new ActiveXObject("Msxml2.XMLHTTP");
    xhr.open("GET", RELAY_URL + "/next", false); // synchronous
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
    var xhr = new ActiveXObject("Msxml2.XMLHTTP");
    xhr.open("POST", RELAY_URL + "/result", false);
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
        timestamp: (new Date()).toISOString()
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

function CmdCompileProject(_params) {
    // [DOCUMENTED] Project:Compile compiles the focused project.
    ResetParametersAD();
    Client.SendMessage("Project:Compile", "", 512, Client.CurrentView);
    // AD compile is synchronous from the script's perspective — when
    // SendMessage returns, compile is done.
    return { compiled: true, note: "Check AD Messages panel for ERC results." };
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

function Log(msg) {
    // Shows up in the DXP Messages panel when called from a script.
    try { ShowInfo("[AltiumRelay] " + msg); } catch (_) { /* ignore */ }
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
