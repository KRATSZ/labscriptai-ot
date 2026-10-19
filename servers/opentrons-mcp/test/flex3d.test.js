import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { createServer } from "node:net";
import path from "path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "../../..");
const python = path.join(pluginRoot, ".venv/bin/python");
const script = path.join(pluginRoot, "automation/flex3d/scripts/render_protocol_3d.py");

function run(args) {
  return spawnSync(python, [script, ...args], { encoding: "utf8", cwd: path.dirname(script) });
}

test("render_protocol_3d.py reports a structured JSON for a missing source (no mujoco needed)", () => {
  const done = run([path.join(os.tmpdir(), "definitely-missing-analysis.json")]);
  assert.equal(done.status, 0, done.stderr);
  const parsed = JSON.parse(done.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, "missing_source");
  assert.deepEqual(parsed.checks, []);
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

test("runFlex3dCheck wrapper returns degraded structured results", async () => {
  const { runFlex3dCheck } = await import("../lib/flex3d.js");
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "flex3d-out-"));

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

test("viewer works without server OpenGL and survives its launching client", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flex3d-lifetime-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const source = path.join(dir, "empty.analysis.json");
  fs.writeFileSync(source, JSON.stringify({ robotType: "OT-3 Standard", commands: [] }));
  const moduleUrl = new URL("../lib/flex3d.js", import.meta.url).href;
  const code = `import {startFlex3dViewer} from ${JSON.stringify(moduleUrl)};
    console.log(JSON.stringify(await startFlex3dViewer(${JSON.stringify({ protocolPath: source, port, preferredPython: python })})));`;
  const done = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    env: { ...process.env, OPENTRONS_PLUGIN_ROOT: pluginRoot, PLUGIN_DATA: dir, MUJOCO_GL: "disable" },
    encoding: "utf8", timeout: 60000,
  });
  const info = JSON.parse(done.stdout.trim().split("\n").at(-1));
  try {
    assert.equal(done.status, 0, done.stderr);
    assert.equal(info.ok, true, JSON.stringify(info));
    const health = await fetch(`http://127.0.0.1:${port}/flex3d/health`).then(r => r.json());
    assert.equal(health.pid, info.pid);
    assert.equal((await fetch(info.url)).status, 200);
    const meta = await fetch(`http://127.0.0.1:${port}/flex3d/example/info`).then(r => r.json());
    assert.ok(meta.camera.main.distance > 0);
    const scene = await fetch(`http://127.0.0.1:${port}/flex3d/example/view.json`).then(r => r.json());
    assert.ok(scene.geoms.length > 0);
  } finally {
    if (info.pid) process.kill(info.pid);
  }
});
