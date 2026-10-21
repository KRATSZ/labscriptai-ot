import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer as createHttpServer } from "node:http";
import os from "node:os";
import { createServer } from "node:net";
import path from "path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "../../..");
const python = process.env.OPENTRONS_PYTHON || path.join(pluginRoot, ".venv/bin/python");
const script = path.join(pluginRoot, "automation/flex3d/scripts/render_protocol_3d.py");

// Isolate ownership metadata and viewer logs from the real plugin data dir.
// This must happen before ../lib/flex3d.js (and its paths.js import) is loaded.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "flex3d-data-"));
process.env.PLUGIN_DATA = dataDir;
process.env.OPENTRONS_PLUGIN_ROOT = pluginRoot;
process.env.OPENTRONS_PYTHON = python;
process.env.MUJOCO_GL = "disable";

let modulePromise;
function flex3d() {
  modulePromise ??= import("../lib/flex3d.js");
  return modulePromise;
}

function run(args) {
  return spawnSync(python, [script, ...args], { encoding: "utf8", cwd: path.dirname(script) });
}

async function freePort() {
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  return port;
}

async function viewerIsDown(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/flex3d/health`, {
      signal: AbortSignal.timeout(1000),
    });
    return false;
  } catch (error) {
    return true;
  }
}

async function ensureStopped(port) {
  try {
    const { stopFlex3dViewer } = await flex3d();
    const result = await stopFlex3dViewer({ port });
    if (!result.ok && result.error === "viewer_stop_failed" && result.pid) {
      try {
        process.kill(result.pid, "SIGKILL");
      } catch (error) {
        // already gone
      }
    }
  } catch (error) {
    // cleanup must not mask the test failure
  }
}

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("render_protocol_3d.py reports a structured JSON for a missing source (no mujoco needed)", () => {
  const done = run([path.join(os.tmpdir(), "definitely-missing-analysis.json")]);
  assert.equal(done.status, 0, done.stderr);
  const parsed = JSON.parse(done.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, "missing_source");
  assert.deepEqual(parsed.checks, []);
  assert.deepEqual(parsed.warnings, []);
  assert.equal(parsed.warnings_count, 0);
});

test("render_protocol_3d.py refuses OT-2 protocols before importing mujoco", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flex3d-"));
  const source = path.join(dir, "ot2.analysis.json");
  fs.writeFileSync(source, JSON.stringify({ robotType: "OT-2 Standard" }));

  const done = run([source]);
  assert.equal(done.status, 0, done.stderr);
  const parsed = JSON.parse(done.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, "ot2_not_supported");
  assert.equal(parsed.robot_type, "OT-2 Standard");
});

test("runFlex3dCheck wrapper returns degraded structured results", async t => {
  const { runFlex3dCheck } = await flex3d();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "flex3d-out-"));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));

  const missing = await runFlex3dCheck({
    sourcePath: path.join(os.tmpdir(), "definitely-missing-analysis.json"),
    outDir,
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "missing_source");
  assert.ok(missing.python);
  assert.equal(missing.out_dir, path.resolve(outDir));

  await assert.rejects(
    () => runFlex3dCheck({ sourcePath: "  " }),
    /requires `source`/,
  );
});

test("preflight warning contract survives wrapper and analysis failures", async t => {
  const { runFlex3dCheck } = await flex3d();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "flex3d-errors-"));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  const invalid = await runFlex3dCheck({ sourcePath: script, outDir, preferredPython: process.execPath });
  assert.equal(invalid.error, "flex3d_invalid_output");
  assert.deepEqual(invalid.warnings, []);
  assert.equal(invalid.warnings_count, 0);

  const broken = path.join(outDir, "broken.py");
  fs.writeFileSync(broken, 'requirements = {"robotType": "Flex", "apiLevel": "2.24"}\ndef run(p):\n    raise RuntimeError("fixture analysis failure")\n');
  const { TOOL_HANDLERS } = await import("../index.js");
  const { data } = await TOOL_HANDLERS.flex3d_preflight_check({ source: broken, python_executable: python });
  assert.equal(data.ok, false);
  assert.equal(data.status, "failed");
  assert.deepEqual(data.warnings, []);
  assert.equal(data.warnings_count, 0);
});

test("viewer starts headless, survives its launching client, and stops cleanly", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flex3d-lifetime-"));
  const port = await freePort();
  t.after(async () => {
    await ensureStopped(port);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const source = path.join(dir, "empty.analysis.json");
  fs.writeFileSync(source, JSON.stringify({ robotType: "OT-3 Standard", commands: [] }));
  const moduleUrl = new URL("../lib/flex3d.js", import.meta.url).href;
  const code = `import {startFlex3dViewer} from ${JSON.stringify(moduleUrl)};
    console.log(JSON.stringify(await startFlex3dViewer(${JSON.stringify({ protocolPath: source, port, preferredPython: python })})));`;
  const done = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    env: {
      ...process.env,
      OPENTRONS_PLUGIN_ROOT: pluginRoot,
      PLUGIN_DATA: dataDir,
      MUJOCO_GL: "disable",
    },
    encoding: "utf8",
    timeout: 60000,
  });
  assert.equal(done.status, 0, done.stderr);
  const info = JSON.parse(done.stdout.trim().split("\n").at(-1));
  assert.equal(info.ok, true, JSON.stringify(info));
  assert.equal(info.reused, false);
  assert.ok(info.pid);
  assert.equal(fs.statSync(info.log_path).mode & 0o777, 0o600);

  // The launcher process is gone, but the detached viewer is still serving.
  const health = await fetch(`http://127.0.0.1:${port}/flex3d/health`).then(r => r.json());
  assert.equal(health.pid, info.pid);
  assert.ok(health.instance);
  assert.equal((await fetch(info.url)).status, 200);
  const meta = await fetch(`http://127.0.0.1:${port}/flex3d/example/info`).then(r => r.json());
  assert.ok(meta.camera.main.distance > 0);
  const scene = await fetch(`http://127.0.0.1:${port}/flex3d/example/view.json`).then(r => r.json());
  assert.ok(scene.geoms.length > 0);

  const { startFlex3dViewer, stopFlex3dViewer } = await flex3d();
  const reused = await startFlex3dViewer({ protocolPath: source, port, preferredPython: python });
  assert.equal(reused.ok, true, JSON.stringify(reused));
  assert.equal(reused.reused, true);
  assert.equal(reused.pid, info.pid);
  assert.equal(reused.url, info.url);

  const stopped = await stopFlex3dViewer({ port });
  assert.equal(stopped.ok, true, JSON.stringify(stopped));
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.pid, info.pid);
  assert.ok(await viewerIsDown(port));

  const already = await stopFlex3dViewer({ port });
  assert.equal(already.ok, true);
  assert.equal(already.already_stopped, true);
});

test("viewer records the verified server PID when its launcher creates another process", { skip: process.platform === "win32" }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flex3d-redirector-"));
  const port = await freePort();
  t.after(async () => {
    await ensureStopped(port);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const source = path.join(dir, "empty.analysis.json");
  fs.writeFileSync(source, JSON.stringify({ robotType: "OT-3 Standard", commands: [] }));
  const pidFile = path.join(dir, "launcher.pid");
  const launcher = path.join(dir, "python-launcher");
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  fs.writeFileSync(launcher, `#!/bin/sh\nprintf '%s' "$$" > ${quote(pidFile)}\n${quote(python)} "$@" &\nwait\n`, { mode: 0o755 });

  const { startFlex3dViewer, stopFlex3dViewer } = await flex3d();
  const info = await startFlex3dViewer({ protocolPath: source, port, preferredPython: launcher });
  assert.equal(info.ok, true, JSON.stringify(info));
  assert.notEqual(info.pid, Number(fs.readFileSync(pidFile, "utf8")));
  const health = await fetch(`http://127.0.0.1:${port}/flex3d/health`).then(r => r.json());
  assert.equal(info.pid, health.pid);
  const reused = await startFlex3dViewer({ protocolPath: source, port, preferredPython: launcher });
  assert.equal(reused.reused, true);
  assert.equal(reused.pid, info.pid);
  assert.equal((await stopFlex3dViewer({ port })).stopped, true);
  assert.ok(await viewerIsDown(port));
});

test("viewer reuses one process, preserves older models, stops, and reopens", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flex3d-reuse-"));
  const port = await freePort();
  t.after(async () => {
    await ensureStopped(port);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const first = path.join(dir, "first.analysis.json");
  const second = path.join(dir, "second.analysis.json");
  fs.writeFileSync(first, JSON.stringify({ robotType: "OT-3 Standard", commands: [] }));
  fs.writeFileSync(second, JSON.stringify({
    robotType: "OT-3 Standard",
    commands: [],
    metadata: { protocolName: "second protocol" },
  }));

  const { startFlex3dViewer, stopFlex3dViewer } = await flex3d();
  const [concurrentA, concurrentB] = await Promise.all([
    startFlex3dViewer({ protocolPath: first, port, preferredPython: python }),
    startFlex3dViewer({ protocolPath: first, port, preferredPython: python }),
  ]);
  assert.equal(concurrentA.ok, true, JSON.stringify(concurrentA));
  assert.equal(concurrentB.ok, true, JSON.stringify(concurrentB));
  assert.equal(concurrentA.reused, false);
  assert.equal(concurrentB.reused, true);
  assert.equal(concurrentA.pid, concurrentB.pid);
  assert.equal(concurrentA.url, concurrentB.url);
  assert.equal(new URL(concurrentA.url).searchParams.get("key"), "example");

  const repeated = await startFlex3dViewer({ protocolPath: first, port, preferredPython: python });
  assert.equal(repeated.ok, true);
  assert.equal(repeated.reused, true);
  assert.equal(repeated.pid, concurrentA.pid);
  assert.equal(repeated.url, concurrentA.url);

  const changed = await startFlex3dViewer({ protocolPath: second, port, preferredPython: python });
  assert.equal(changed.ok, true, JSON.stringify(changed));
  assert.equal(changed.reused, true);
  assert.equal(changed.pid, concurrentA.pid);
  assert.notEqual(changed.url, concurrentA.url);
  const changedKey = new URL(changed.url).searchParams.get("key");
  assert.match(changedKey, /^[a-f0-9]{16}$/);

  const health = await fetch(`http://127.0.0.1:${port}/flex3d/health`).then(r => r.json());
  assert.deepEqual(new Set(health.models), new Set(["example", changedKey]));
  assert.equal((await fetch(concurrentA.url)).status, 200);
  const oldInfo = await fetch(`http://127.0.0.1:${port}/flex3d/example/info`).then(r => r.json());
  assert.equal(oldInfo.key, "example");
  const changedInfo = await fetch(`http://127.0.0.1:${port}/flex3d/${changedKey}/info`).then(r => r.json());
  assert.equal(changedInfo.key, changedKey);

  // Logs and ownership metadata are private, and stay under PLUGIN_DATA.
  assert.equal(fs.statSync(changed.log_path).mode & 0o777, 0o600);
  assert.ok(changed.log_path.startsWith(path.join(dataDir, "flex3d") + path.sep));
  const ownership = path.join(dataDir, "flex3d", `viewer-${port}.json`);
  assert.equal(fs.statSync(ownership).mode & 0o777, 0o600);

  const stopped = await stopFlex3dViewer({ port });
  assert.equal(stopped.ok, true, JSON.stringify(stopped));
  assert.equal(stopped.pid, concurrentA.pid);
  assert.ok(await viewerIsDown(port));

  const reopened = await startFlex3dViewer({ protocolPath: first, port, preferredPython: python });
  assert.equal(reopened.ok, true, JSON.stringify(reopened));
  assert.equal(reopened.reused, false);
  assert.equal(new URL(reopened.url).searchParams.get("key"), "example");
  const reopenedHealth = await fetch(`http://127.0.0.1:${port}/flex3d/health`).then(r => r.json());
  assert.equal(reopenedHealth.pid, reopened.pid);

  const stoppedAgain = await stopFlex3dViewer({ port });
  assert.equal(stoppedAgain.ok, true);
  assert.equal(stoppedAgain.pid, reopened.pid);
  assert.ok(await viewerIsDown(port));
});

test("a foreign listener on the port is reported and left untouched", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flex3d-foreign-"));
  const port = await freePort();
  const foreignPid = 424242;
  const server = createHttpServer((req, res) => {
    if (req.url === "/flex3d/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        service: "labscriptai-flex3d",
        pid: foreignPid,
        instance: "not-ours",
        models: [],
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const source = path.join(dir, "valid.analysis.json");
  fs.writeFileSync(source, JSON.stringify({ robotType: "OT-3 Standard", commands: [] }));
  const { startFlex3dViewer, stopFlex3dViewer } = await flex3d();

  const started = await startFlex3dViewer({ protocolPath: source, port, preferredPython: python });
  assert.equal(started.ok, false);
  assert.equal(started.error, "port_in_use");
  assert.equal(started.pid, foreignPid);
  assert.ok(started.message.includes(String(port)));
  assert.equal(server.listening, true);

  const stopped = await stopFlex3dViewer({ port });
  assert.equal(stopped.ok, false);
  assert.equal(stopped.error, "port_in_use");
  assert.equal(server.listening, true);
  assert.equal(
    fs.existsSync(path.join(dataDir, "flex3d", `viewer-${port}.json`)),
    false,
  );
});

test("invalid ports and protocol paths return structured errors", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flex3d-invalid-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const valid = path.join(dir, "valid.analysis.json");
  const malformed = path.join(dir, "malformed.json");
  fs.writeFileSync(valid, JSON.stringify({ robotType: "OT-3 Standard", commands: [] }));
  fs.writeFileSync(malformed, "{not json");
  const { startFlex3dViewer, stopFlex3dViewer } = await flex3d();

  const badPort = await startFlex3dViewer({ protocolPath: valid, port: 70000 });
  assert.equal(badPort.ok, false);
  assert.equal(badPort.error, "invalid_port");

  const missing = await startFlex3dViewer({
    protocolPath: path.join(dir, "missing.json"),
    port: 8791,
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "protocol_not_found");
  assert.ok(missing.message.includes("missing.json"));

  const badJson = await startFlex3dViewer({ protocolPath: malformed, port: 8791 });
  assert.equal(badJson.ok, false);
  assert.equal(badJson.error, "invalid_protocol");

  const directory = await startFlex3dViewer({ protocolPath: dir, port: 8791 });
  assert.equal(directory.ok, false);
  assert.equal(directory.error, "protocol_not_file");

  const badStopPort = await stopFlex3dViewer({ port: "not-a-port" });
  assert.equal(badStopPort.ok, false);
  assert.equal(badStopPort.error, "invalid_port");
});

test("close rejects a different instance and never signals recorded PIDs", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flex3d-close-identity-"));
  const port = await freePort();
  t.after(async () => { await ensureStopped(port); fs.rmSync(dir, { recursive: true, force: true }); });
  const source = path.join(dir, "empty.analysis.json");
  fs.writeFileSync(source, JSON.stringify({ robotType: "OT-3 Standard", commands: [] }));
  const { startFlex3dViewer, stopFlex3dViewer } = await flex3d();
  const opened = await startFlex3dViewer({ protocolPath: source, port, preferredPython: python });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const wrong = await fetch(`http://127.0.0.1:${port}/flex3d/close`, {
    method: "POST", headers: { "X-Flex3d-Instance": "a-different-instance" },
  });
  assert.equal(wrong.status, 409);
  assert.equal((await fetch(`http://127.0.0.1:${port}/flex3d/health`)).status, 200);
  const originalKill = process.kill;
  const signals = [];
  process.kill = (pid, signal) => {
    if (signal !== 0) { signals.push({ pid, signal }); return true; }
    return originalKill(pid, signal);
  };
  try {
    const stopped = await stopFlex3dViewer({ port });
    assert.equal(stopped.stopped, true, JSON.stringify(stopped));
    assert.deepEqual(signals, []);
  } finally { process.kill = originalKill; }
});

test("a close acknowledgement and unavailable health do not prove the viewer exited", async t => {
  const port = await freePort();
  const instance = "viewer-that-has-not-exited";
  let healthReads = 0;
  let closeRequests = 0;
  const server = createHttpServer((req, res) => {
    res.setHeader("Connection", "close");
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/flex3d/health" && ++healthReads === 1) {
      res.end(JSON.stringify({ service: "labscriptai-flex3d", pid: process.pid, instance }));
    } else if (req.url === "/flex3d/close") {
      closeRequests += 1;
      res.end(JSON.stringify({ ok: true, closing: true, instance }));
    } else { res.statusCode = 503; res.end('{}'); }
  });
  await new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
  const record = path.join(dataDir, "flex3d", `viewer-${port}.json`);
  fs.mkdirSync(path.dirname(record), { recursive: true });
  fs.writeFileSync(record, JSON.stringify({ port, pid: process.pid, instance }), { mode: 0o600 });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(record, { force: true });
  });
  const originalKill = process.kill;
  const signals = [];
  process.kill = (pid, signal) => {
    if (signal !== 0) { signals.push({ pid, signal }); return true; }
    return originalKill(pid, signal);
  };
  try {
    const { stopFlex3dViewer } = await flex3d();
    const stopped = await stopFlex3dViewer({ port });
    assert.equal(stopped.ok, false);
    assert.equal(stopped.error, "viewer_stop_failed");
    assert.equal(closeRequests, 1);
    assert.equal(fs.existsSync(record), true);
    assert.equal(server.listening, true);
    assert.deepEqual(signals, []);
  } finally { process.kill = originalKill; }
});
