# Contributing to PCBviber

Thanks for helping. The project is in alpha and the most valuable input is
evidence from real Altium projects.

## Reporting what works and what does not

Open an issue with:

- the tool you called and its arguments
- Altium Designer version and Windows version
- what you expected and what happened (the tool result text, and the last
  lines of `%TEMP%\AltiumRelay.log` if the command reached Altium)

Do not attach proprietary design files. A description, or a minimal project
you are free to share, is enough.

## Code changes

```bash
pnpm install
pnpm -F pcbviber test
```

`pnpm -F pcbviber test` bundles the local server and runs an end-to-end smoke
test with a simulated Altium, so it works on any OS without Altium installed.

- Altium-side behaviour lives in `ad-script/AltiumRelay.js`. Altium's script
  engine is an old ECMAScript dialect: `var` and `function` only.
- Tool definitions live in `apps/server/src/tools`, handlers in
  `apps/server/src/handlers` and `apps/server/src/platforms`.
- Keep pull requests small and say how you verified the change. If you tested
  against real Altium, say which version.

## Security

The relay listener is loopback-only and unauthenticated by design. Report
anything that would let a remote party reach it, or any other vulnerability,
privately through GitHub's "Report a vulnerability" on the repository's
Security tab instead of a public issue.
