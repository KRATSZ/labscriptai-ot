import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
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
