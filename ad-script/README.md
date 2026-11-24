# AltiumRelay — the AD side of the MCP desktop relay

`AltiumRelay.js` runs inside Altium Designer 24. It long-polls the MCP
server (running on `http://127.0.0.1:3000`) for commands, executes them
using AD's scripting API, and posts results back.

Without this script loaded inside AD, every `ad_*` tool on the MCP
server will time out with a "relay not connected" error.

## Install

1. **Start the MCP server.** With the local package this happens when your
   MCP client launches `npx -y pcbviber`; the relay endpoint is then on
   `http://127.0.0.1:3000`. (Hosted server: `pnpm -F "@altium-mcp/server" start:http`.)

2. **Open Altium Designer 24.**

3. **File → Run Script…** (or `Ctrl+Alt+R` in some installs).

4. In the dialog, pick **JavaScript Script (*.js)**, then browse to
   `AltiumRelay.js` (`npx -y pcbviber --relay-script` prints its path; in a
   clone it is `ad-script/AltiumRelay.js`).

5. The script file will open in the Code Editor. In the **PRJ Panel** you
   should see a `ScriptingSystem` project with `AltiumRelay.js`.

6. In the Code Editor, place the caret inside `function Main()` and press
   **F9** (Run). The Messages panel should show:
   ```
   [AltiumRelay] AltiumRelay starting. Server: http://127.0.0.1:3000/ad-relay
   ```

7. Verify from another terminal:
   ```powershell
   curl http://127.0.0.1:3000/ad-relay/status
   ```
   `"connected": true` means AD is polling successfully.

## Smoke test

From Claude Code, Inspector, or the REST BFF:
```
ad_ping → { "pong": true, "adVersion": "Altium Designer", "timestamp": "..." }
```

## Stop

- **Graceful:** open the Code Editor → Script Command Line panel, type
  `g_stop = true` and press Enter. On the next poll return, the loop exits.
- **Forceful:** close Altium Designer. The server's 25-second poll timeout
  will mark the relay disconnected on the next `ad_status` call.

## What's implemented in v1

| Command              | Status      | Notes                                              |
|----------------------|-------------|----------------------------------------------------|
| `ping`               | [TESTED]    | Round-trips AD version string                      |
| `get_active_project` | [DOCUMENTED]| Returns project path, name, loaded documents       |
| `open_project`       | [DOCUMENTED]| Opens .PrjPcb / .PrjSch at the given path          |
| `compile_project`    | [DOCUMENTED]| Triggers Project:Compile (ERC runs as side effect) |
| `run_drc`            | [PARTIAL]   | Triggers DRC; violation enumeration is a TODO      |
| `annotate_schematic` | [DOCUMENTED]| Silent annotation with selectable order            |
| `generate_outputs`   | [DOCUMENTED]| Runs the active OutJob (or a named one)            |
| `auto_place`         | [DOCUMENTED]| AD auto-placement (cluster or statistical)         |
| `auto_route`         | [DOCUMENTED]| Situs auto-router (all / selected / single net)    |

- **[TESTED]** — verified working during development.
- **[DOCUMENTED]** — uses documented AD scripting API calls. May need
  tweaks on first run — if a command misbehaves, check AD's Messages
  panel and adjust the `Client.SendMessage(...)` string for that method.

## Troubleshooting

**`status.connected = false` always:**
- Is the MCP server running? The local `pcbviber` package always opens the relay endpoint; the hosted server only does with `--transport=http`.
- Firewall blocking localhost? Check Windows Defender settings.
- AD can't resolve `127.0.0.1`? Try `http://localhost:3000` in `RELAY_URL`.

**Every command times out:**
- Is `Main()` actually running, or did the Code Editor just "open" the script?
  The Messages panel must show the `AltiumRelay starting.` line.
- Server port mismatch — check `RELAY_URL` at the top of `AltiumRelay.js`.

**ActiveXObject / Msxml2.XMLHTTP errors:**
- Your AD install may have restricted COM. Run AD as Administrator once
  to see if it's a permissions issue.

**The script exits immediately:**
- `Main()` must be the entry point. If you ran a different function by
  mistake (F9 on a cursor-adjacent function), the script will do nothing.

## Security

The relay binds to `127.0.0.1` only. Anyone with local access to your
machine can send commands to AD through the relay — keep the port closed
on any network interface (default), and don't expose the server to the
LAN without adding authentication.
