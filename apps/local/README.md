# pcbviber

MCP server that lets Claude, Cursor, or any MCP client work inside a live
**Altium Designer** session: read the active project, list components and
nets, run DRC, check production readiness, export manufacturing outputs, and
look up parts on Octopart.

**Status: alpha.** Use it on a copy of your project.

## Quick start

Requirements: Node.js 20+, Altium Designer 24 on Windows.

```bash
claude mcp add pcbviber -- npx -y pcbviber
```

or, for Claude Desktop / Cursor:

```json
{
  "mcpServers": {
    "pcbviber": { "command": "npx", "args": ["-y", "pcbviber"] }
  }
}
```

Then load the relay script in Altium (**File → Run Script…**, run `Main()`):

```bash
npx -y pcbviber --relay-script   # prints the path of AltiumRelay.js
```

Ask your client to call `ad_ping` to confirm the connection.

Part search and pricing need `NEXAR_CLIENT_ID` / `NEXAR_CLIENT_SECRET` from
<https://nexar.com/api>; everything else works without them.

Full documentation, tool reference and verification status:
<https://github.com/raz-22/pcbviber>

MIT licensed. Not affiliated with or endorsed by Altium.
