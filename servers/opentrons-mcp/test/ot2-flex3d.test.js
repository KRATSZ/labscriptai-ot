import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const data = fs.mkdtempSync(path.join(os.tmpdir(), "ot2-flex-integration-"));
process.env.OPENTRONS_PLUGIN_ROOT = root;
process.env.PLUGIN_DATA = data;
process.env.OPENTRONS_PYTHON ||= path.join(root, ".venv/bin/python");
process.env.MUJOCO_GL = "disable";
const { TOOL_HANDLERS } = await import("../index.js");
const { analyzeProtocolOnce } = await import("../lib/analyze-once.js");
const fixture = name => path.join(root, "automation/flex3d/tests/ot2_fixtures", name);
test.after(() => fs.rmSync(data, { recursive: true, force: true }));

test("OT-2 official analysis is shared by simulation, ledger and 3D checks while Flex keeps 9.x", async () => {
  const protocol = fixture("protocols/single_p20.py");
  const analyzed = await analyzeProtocolOnce({ protocol_path: protocol });
  assert.equal(analyzed.ok, true, JSON.stringify(analyzed));
  assert.equal(analyzed.robot_type, "OT-2 Standard");
  const cached = await analyzeProtocolOnce({ protocol_path: protocol });
  assert.equal(cached.analysis_cached, true);
  assert.equal(cached.analysis_path, analyzed.analysis_path);
  const { data: checked } = await TOOL_HANDLERS.flex3d_preflight_check({ source: protocol });
  assert.equal(checked.status, "passed", JSON.stringify(checked));
  assert.equal(checked.robot_type, "OT-2 Standard");
  assert.equal(fs.realpathSync(checked.analysis_path), fs.realpathSync(analyzed.analysis_path));
  assert.deepEqual(checked.checks.map(item => item.name), ["geometry", "targets", "clearance", "liquid"]);
  const { data: ledger } = await TOOL_HANDLERS.logicpass_check({ protocol_path: protocol });
  assert.equal(ledger.final_pass_v2, true, JSON.stringify(ledger));
  const flex = path.join(data, "flex.py");
  fs.writeFileSync(flex, 'requirements = {"robotType": "Flex", "apiLevel": "2.24"}\ndef run(p):\n    p.load_trash_bin("A3")\n');
  const flexAnalysis = await analyzeProtocolOnce({ protocol_path: flex });
  assert.equal(flexAnalysis.ok, true, JSON.stringify(flexAnalysis));
  assert.equal(flexAnalysis.robot_type, "OT-3 Standard");
  assert.notEqual(flexAnalysis.python, analyzed.python);
});

test("same viewer switches OT-2/Flex, preserves textures, rejects unknown actions, and recovers after eviction", async t => {
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  t.after(() => TOOL_HANDLERS.flex3d_open_viewer({ action: "close", port }));
  const flex = path.join(data, "flex-move.py");
  fs.writeFileSync(flex, `from opentrons import protocol_api
requirements = {"robotType": "Flex", "apiLevel": "2.24"}
def run(p):
    p.load_trash_bin("A3")
    r = p.load_labware("opentrons_flex_96_tiprack_50ul", "B3")
    a = p.load_labware("nest_96_wellplate_200ul_flat", "C3")
    pip = p.load_instrument("flex_8channel_50", "left", tip_racks=[r])
    pip.pick_up_tip()
    pip.aspirate(5, a["A1"])
    pip.dispense(5, a["A2"])
    pip.drop_tip()
`);
  let pid;
  for (const [file, robot] of [
    [fixture("protocols/single_p20.py"), "OT-2 Standard"],
    [flex, "OT-3 Standard"],
    [fixture("protocols/eight_p300.py"), "OT-2 Standard"],
    [fixture("protocols/thermocycler.py"), "OT-2 Standard"],
    [fixture("protocols/magnetic.py"), "OT-2 Standard"],
    [fixture("protocols/temperature.py"), "OT-2 Standard"],
    [flex, "OT-3 Standard"],
    [fixture("protocols/single_p20.py"), "OT-2 Standard"],
  ]) {
    const { data: opened } = await TOOL_HANDLERS.flex3d_open_viewer({ protocol_path: file, port });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    pid ??= opened.pid;
    assert.equal(opened.pid, pid);
    const key = new URL(opened.url).searchParams.get("key");
    const base = `http://127.0.0.1:${port}/flex3d/${key}`;
    const info = await fetch(`${base}/info`).then(r => r.json());
    assert.equal(info.robot_type, robot);
    const analysis = await fetch(`${base}/analysis.json`).then(r => r.json());
    assert.equal(analysis.robotType, robot);
    for (const step of info.steps) assert.equal(step.commandId, analysis.commands[step.cmd].id);
    const view = await fetch(`${base}/view.json`).then(r => r.json());
    assert.equal(view.schema_version, 1);
    assert.ok(view.geoms.length > 0 && view.frames.length > 1);
    for (const texture of view.textures) {
      const response = await fetch(`${base}/assets/${texture.file}`);
      assert.equal(response.status, 200, texture.file);
      assert.equal(response.headers.get("content-type"), "image/png");
    }
    if (file.endsWith("thermocycler.py")) {
      assert.ok(view.frames.some(frame => frame.dyn.some(pack => pack.length === 14)));
    }
  }
  const health = await fetch(`http://127.0.0.1:${port}/flex3d/health`).then(r => r.json());
  const bad = await fetch(`http://127.0.0.1:${port}/flex3d/load`, {
    method: "POST", headers: { "X-Flex3d-Instance": health.instance }, body: JSON.stringify({ robotType: "unknown", commands: [] }),
  });
  assert.equal(bad.status, 422);
  const { data: recovered } = await TOOL_HANDLERS.flex3d_open_viewer({ protocol_path: flex, port });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.pid, pid);
});
