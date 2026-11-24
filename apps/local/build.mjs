// Bundles the local entry point into one dependency-free file so
// `npx pcbviber` starts without installing the monorepo.
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
const out = join(here, "dist", "pcbviber.mjs");

mkdirSync(join(here, "dist"), { recursive: true });

await build({
  entryPoints: [join(here, "src", "index.ts")],
  outfile: out,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  alias: {
    "@altium-mcp/metering": join(here, "src", "metering-shim.ts"),
    "@altium-mcp/shared": join(here, "..", "..", "packages", "shared", "src", "index.ts"),
  },
  define: { __PCBVIBER_VERSION__: JSON.stringify(pkg.version) },
  // CJS dependencies inside the bundle still call require().
  banner: {
    js: "import { createRequire as __pcbviberCreateRequire } from 'node:module';\nconst require = __pcbviberCreateRequire(import.meta.url);",
  },
  logLevel: "info",
});

copyFileSync(join(here, "..", "..", "ad-script", "AltiumRelay.js"), join(here, "dist", "AltiumRelay.js"));
copyFileSync(join(here, "..", "..", "LICENSE"), join(here, "LICENSE"));
chmodSync(out, 0o755);
