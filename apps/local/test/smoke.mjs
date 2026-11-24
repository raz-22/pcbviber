// End-to-end smoke test for the bundled binary. No Altium required:
// the test acts as the MCP client on stdio AND as the Altium-side
// poller on the loopback relay, and checks a tool call round-trips.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "pcbviber.mjs");
const PORT = 38000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${PORT}/ad-relay`;

// npm exposes the binary through a symlink in node_modules/.bin; make sure
// the entry point still runs when invoked that way.
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
const link = join(mkdtempSync(join(tmpdir(), "pcbviber-")), "pcbviber");
symlinkSync(bin, link);
assert.match(execFileSync(process.execPath, [link, "--version"], { encoding: "utf8" }).trim(), /^\d+\.\d+\.\d+$/);

const child = spawn(process.execPath, [link, `--relay-port=${PORT}`], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, NEXAR_CLIENT_ID: "", NEXAR_CLIENT_SECRET: "" },
});
let stderr = "";
child.stderr.on("data", (d) => (stderr += d));

const pending = new Map();
let buf = "";
child.stdout.on("data", (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  const p = new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => reject(new Error(`timeout waiting for ${method}\n${stderr}`)), 15000);
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return p;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForRelay() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${base}/status`);
      if (r.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error("relay listener never came up\n" + stderr);
}

try {
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  });
  assert.equal(init.result.serverInfo.name, "pcbviber");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const tools = (await rpc("tools/list", {})).result.tools.map((t) => t.name);
  assert.ok(tools.length >= 20, `expected 20+ tools, got ${tools.length}`);
  for (const name of ["ad_ping", "ad_get_active_project", "run_drc"]) {
    assert.ok(tools.includes(name), `missing tool ${name}`);
  }
  const prompts = (await rpc("prompts/list", {})).result.prompts.map((p) => p.name);
  assert.ok(prompts.includes("pcb_design_flow"));

  await waitForRelay();
  assert.equal((await fetch(`${base}/next`)).status, 204, "empty queue should be 204");

  // Fake Altium: poll until the command shows up, then answer it.
  const fakeAltium = (async () => {
    for (let i = 0; i < 100; i++) {
      const r = await fetch(`${base}/next`);
      if (r.status === 200) {
        const cmd = await r.json();
        assert.equal(cmd.method, "get_active_project");
        const post = await fetch(`${base}/result`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: cmd.id,
            ok: true,
            result: { hasProject: true, projectName: "Smoke.PrjPcb", projectPath: "C:\\Smoke\\Smoke.PrjPcb" },
          }),
        });
        assert.equal(post.status, 200);
        return;
      }
      await sleep(50);
    }
    throw new Error("command never reached the relay");
  })();

  const call = await rpc("tools/call", { name: "ad_get_active_project", arguments: {} });
  await fakeAltium;
  const text = call.result.content.map((c) => c.text ?? "").join("\n");
  assert.ok(text.includes("Smoke.PrjPcb"), `tool result did not round-trip: ${text}`);
  assert.ok(!call.result.isError, "tool call reported an error");

  // Malformed result must be rejected, unknown id must be 410.
  assert.equal((await fetch(`${base}/result`, { method: "POST", body: "{" })).status, 400);
  assert.equal(
    (
      await fetch(`${base}/result`, {
        method: "POST",
        body: JSON.stringify({ id: "00000000-0000-4000-8000-000000000000", ok: true, result: null }),
      })
    ).status,
    410
  );

  console.log(`smoke ok: ${tools.length} tools, ${prompts.length} prompts, relay round-trip verified`);

  // Closing stdin (client gone) must end the process and free the port.
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  child.stdin.end();
  const code = await Promise.race([exited, sleep(5000).then(() => "still running")]);
  assert.equal(code, 0, `server did not exit after stdin closed: ${code}`);
} finally {
  child.kill();
}
