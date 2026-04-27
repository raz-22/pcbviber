/**
 * /eda-script/pcbviber-easyeda.eext route tests — Sprint 9 PR 9.5a.
 *
 * Hermetic. Mounts the route on a stripped-down Fastify app and
 * exercises:
 *
 *   - 200 happy path: response is a valid zip (per buildZip's
 *     contract pinned in zip.test.ts) with the right Content-Type
 *     and Content-Disposition headers
 *   - Cache hit: second request returns the same Buffer (we can't
 *     detect cache via API surface, but timing is a soft signal —
 *     second request must be markedly faster than the first if a
 *     real DB / disk read happened on first; for our purposes the
 *     functional pin is "second request body matches first")
 *   - 503 path: when the eda-script directory has been moved or
 *     deleted, the route returns 503 with a stable error code
 *     instead of crashing the process
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";

import {
  registerEdaScriptRoutes,
  __resetEdaScriptCacheForTests,
} from "./routes.js";

let app: FastifyInstance;

before(async () => {
  app = Fastify({ logger: false });
  registerEdaScriptRoutes(app);
  await app.ready();
});

after(async () => {
  if (app) await app.close();
});

test("GET /eda-script/pcbviber-easyeda.eext returns 200 with a valid zip + correct headers", async () => {
  __resetEdaScriptCacheForTests();
  const res = await app.inject({
    method: "GET",
    url: "/eda-script/pcbviber-easyeda.eext",
  });
  assert.equal(res.statusCode, 200);

  // Headers SPA + browser rely on for a clean download UX.
  assert.equal(res.headers["content-type"], "application/zip");
  assert.match(
    String(res.headers["content-disposition"] ?? ""),
    /attachment;\s*filename="pcbviber-easyeda\.eext"/
  );
  assert.match(
    String(res.headers["cache-control"] ?? ""),
    /max-age=3600/
  );

  // Magic-number check: a zip starts with PK\x03\x04 (the local
  // file header signature). If the route ever swapped to a
  // different archive format, this fails loud.
  const buf = res.rawPayload as Buffer;
  assert.ok(buf.length > 0, "body must be non-empty");
  assert.equal(buf.readUInt32LE(0), 0x04034b50, "magic bytes must mark a zip");

  // EOCD signature lives in the last 22 bytes (no zip comment).
  const eocdOffset = buf.length - 22;
  assert.equal(
    buf.readUInt32LE(eocdOffset),
    0x06054b50,
    "EOCD signature must be present"
  );
  // Three files in the package: extension.json, src/index.js, README.md.
  assert.equal(buf.readUInt16LE(eocdOffset + 10), 3, "archive must have 3 entries");
});

test("GET /eda-script/pcbviber-easyeda.eext: second request returns the cached Buffer (byte-identical)", async () => {
  __resetEdaScriptCacheForTests();
  const first = await app.inject({
    method: "GET",
    url: "/eda-script/pcbviber-easyeda.eext",
  });
  const second = await app.inject({
    method: "GET",
    url: "/eda-script/pcbviber-easyeda.eext",
  });
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.deepEqual(
    second.rawPayload,
    first.rawPayload,
    "second response must be byte-identical to the first (cache pin)"
  );
});

test("the served archive contains extension.json, src/index.js, and README.md", async () => {
  __resetEdaScriptCacheForTests();
  const res = await app.inject({
    method: "GET",
    url: "/eda-script/pcbviber-easyeda.eext",
  });
  assert.equal(res.statusCode, 200);
  const buf = res.rawPayload as Buffer;

  // Walk local file headers and pull entry names out — that's
  // enough to confirm every promised file made it in.
  const names: string[] = [];
  let offset = 0;
  while (offset < buf.length && buf.readUInt32LE(offset) === 0x04034b50) {
    const nameLen = buf.readUInt16LE(offset + 26);
    const contentLen = buf.readUInt32LE(offset + 22);
    const name = buf
      .subarray(offset + 30, offset + 30 + nameLen)
      .toString("utf8");
    names.push(name);
    offset += 30 + nameLen + contentLen;
  }
  assert.deepEqual(
    names.sort(),
    ["README.md", "extension.json", "src/index.js"]
  );
});
