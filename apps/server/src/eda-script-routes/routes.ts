/**
 * Sprint 9 PR 9.5a — serves the packaged PCBviber EasyEDA Pro
 * extension as a `.eext` archive at:
 *
 *   GET /eda-script/pcbviber-easyeda.eext
 *
 * The route reads the source files from the repo's `eda-script/`
 * directory at first request, packs them into a store-only zip
 * via `./zip.ts`, and caches the resulting Buffer in memory. The
 * file set is small (3 files, ~10 KB total) and changes only
 * across releases, so a process-lifetime cache is fine — the next
 * deploy gets a fresh process and a fresh build.
 *
 * Public route — no auth. The .eext itself contains no secrets:
 * the API key is entered by the user at first run inside EasyEDA,
 * not bundled. Anonymous users downloading the package isn't a
 * problem; the server doesn't honor calls from it without a key.
 *
 * Path resolution: at runtime the server is at
 * `<repo>/apps/server/build/eda-script-routes/routes.js`, so the
 * eda-script source lives four directories up
 * (eda-script-routes → build → server → apps → repo root). In
 * Docker the Dockerfile copies eda-script/ to `/app/eda-script/`
 * with the same nesting (`/app/apps/server/build/...`) so the
 * same `../../../../eda-script` relative path resolves correctly.
 * If the source is missing at request time the route 503s with a
 * stable error code rather than crashing the server.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { buildZip } from "./zip.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Files included in the .eext, with the path they appear under
 * inside the archive. Order matters only for human-friendly
 * `unzip -l` output; the archive is otherwise unordered.
 */
const EDA_SCRIPT_FILES = [
  { archivePath: "extension.json", srcPath: "extension.json" },
  { archivePath: "src/index.js", srcPath: "src/index.js" },
  { archivePath: "README.md", srcPath: "README.md" },
] as const;

/**
 * Process-lifetime cache. The .eext changes only across releases;
 * on the next deploy a fresh Node process rebuilds it. No
 * invalidation needed in-process.
 */
let cached: Buffer | null = null;

/**
 * Resolve the repo's `eda-script/` directory. The source layout
 * lives at `<repo>/eda-script/`; the server's compiled output is
 * at `<repo>/apps/server/build/eda-script-routes/`. Four `..`
 * segments (eda-script-routes → build → server → apps → repo
 * root) get us back to the repo root in both dev and Docker.
 */
function resolveEdaScriptDir(): string {
  return join(__dirname, "..", "..", "..", "..", "eda-script");
}

async function loadAndPack(): Promise<Buffer> {
  if (cached) return cached;
  const baseDir = resolveEdaScriptDir();
  const entries = await Promise.all(
    EDA_SCRIPT_FILES.map(async (file) => ({
      name: file.archivePath,
      content: new Uint8Array(await readFile(join(baseDir, file.srcPath))),
    }))
  );
  cached = buildZip(entries);
  return cached;
}

/** Test helper: invalidates the in-memory cache. */
export function __resetEdaScriptCacheForTests(): void {
  cached = null;
}

export function registerEdaScriptRoutes(app: FastifyInstance): void {
  app.get("/eda-script/pcbviber-easyeda.eext", async (_req, reply) => {
    let buf: Buffer;
    try {
      buf = await loadAndPack();
    } catch (err) {
      app.log.error({ err }, "failed to build eda-script .eext");
      reply.code(503).send({
        error: "eda_script_unavailable",
        detail:
          "Could not build the EasyEDA extension archive. The server's eda-script directory is missing or unreadable.",
      });
      return reply;
    }
    reply
      .code(200)
      .header("content-type", "application/zip")
      .header(
        "content-disposition",
        'attachment; filename="pcbviber-easyeda.eext"'
      )
      .header("content-length", String(buf.length))
      // Cache for an hour at the CDN — the file is content-addressable
      // by build, so stale caching is fine within a deploy. Nothing
      // private; the Vary header doesn't matter.
      .header("cache-control", "public, max-age=3600")
      .send(buf);
    return reply;
  });
}
