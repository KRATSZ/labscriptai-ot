import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "figure-中文-"));
process.env.PLUGIN_DATA = dir;
process.env.OPENTRONS_PLUGIN_ROOT = root;
process.env.MUJOCO_GL = "disable";
// The fixture path intentionally contains Chinese characters, including on Windows.
process.env.PYTHONUTF8 = "1";
process.env.PYTHONIOENCODING = "utf-8";
const { TOOL_HANDLERS } = await import("../index.js");
const { successResponse } = await import("../lib/envelope.js");
const { generateExperimentFigure } = await import("../lib/experiment-figure.js");
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("real simulate entry returns an inline setup PNG, and viewer serves that same data plus downloads", async t => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const openViewer = TOOL_HANDLERS.flex3d_open_viewer;
  const previewInputs = [];
  TOOL_HANDLERS.flex3d_open_viewer = args => {
    previewInputs.push(args.protocol_path);
    return openViewer({ ...args, port });
  };
  t.after(async () => {
    TOOL_HANDLERS.flex3d_open_viewer = openViewer;
    await openViewer({ action: "close", port });
  });
  const protocol = path.join(root, "examples/01-flex-serial-dilution/protocol.py");
  const sim = await TOOL_HANDLERS.simulate_protocol({ protocol_path: protocol });
  assert.equal(sim.data.ok, true, JSON.stringify(sim.data));
  const viewer = sim.data.preview_3d;
  assert.equal(viewer.status, "ready", JSON.stringify(viewer));
  assert.equal(viewer.ok, true);
  assert.deepEqual(previewInputs, [sim.data.analysis_path]);
  const animation = await fetch(viewer.url);
  assert.equal(animation.status, 200);
  const repeated = await TOOL_HANDLERS.simulate_protocol({ protocol_path: protocol });
  assert.equal(repeated.data.analysis_cached, true);
  assert.equal(repeated.data.preview_3d.url, viewer.url);
  assert.equal(repeated.data.preview_3d.pid, viewer.pid);
  assert.equal(repeated.data.preview_3d.reused, true);
  const artifact = (await TOOL_HANDLERS.protocol_artifacts({ analysis_path: sim.data.analysis_path })).data;
  assert.equal(artifact.artifact_api, 1);
  assert.equal(artifact.plugin_version, JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  assert.equal(artifact.documents.animation.status, "ready", JSON.stringify(artifact));
  assert.equal(artifact.documents.setup.status, "ready", JSON.stringify(artifact));
  const portable = fs.readFileSync(artifact.documents.setup.path, "utf8");
  assert.match(portable, /data:image\/png;base64,/);
  assert.ok(artifact.attachments.some(file => file.name === "wells.csv" && file.mime === "text/csv"));
  assert.doesNotMatch(portable, /<a /);
  assert.match(portable, /Content-Security-Policy/);
  assert.doesNotMatch(portable, /<script>|src="setup/);
  const figure = sim.data.experiment_figure;
  assert.equal(figure.ok, true, JSON.stringify(figure));
  assert.equal(figure.source_well_count, 2);
  const response = successResponse(sim);
  assert.equal(response.content[1].mimeType, "image/png");
  const model = JSON.parse(fs.readFileSync(figure.data_path, "utf8"));
  const plate = model.labware.find(v => v.slot === "C3");
  assert.equal(Object.values(plate.initial.A1)[0], 100);
  assert.equal(plate.initial.A2, undefined); // dispensing does not invent an initial fill
  const page = await fetch(figure.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /下载 PNG/);
  const png = await fetch(new URL("setup.png", figure.url));
  assert.equal(png.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await png.arrayBuffer()), fs.readFileSync(figure.png_path));
  const csv = await fetch(new URL("wells.csv", figure.url));
  assert.equal(csv.status, 200);
  const modelUrl = new URL(viewer.url).searchParams.get("key");
  const missing = await fetch(`http://127.0.0.1:${port}/flex3d/${modelUrl}/setup-999.png`);
  assert.equal(missing.status, 404);
});

test("invalid figure input is nonfatal and failed simulations never start or reuse a stale preview", async t => {
  const openViewer = TOOL_HANDLERS.flex3d_open_viewer;
  let calls = 0;
  TOOL_HANDLERS.flex3d_open_viewer = async () => { calls++; throw new Error("must not open"); };
  t.after(() => { TOOL_HANDLERS.flex3d_open_viewer = openViewer; });
  const source = path.join(dir, "bad.json");
  fs.writeFileSync(source, '{"robotType":"alien","commands":[]}');
  assert.equal((await generateExperimentFigure({ analysisPath: source })).ok, false);
  const broken = path.join(dir, "broken.py");
  fs.writeFileSync(broken, 'requirements={"robotType":"Flex","apiLevel":"2.24"}\ndef run(p):\n    raise RuntimeError("fixture failure")\n');
  const failed = await TOOL_HANDLERS.simulate_protocol({ protocol_path: broken });
  assert.equal(failed.data.ok, false);
  assert.equal(failed.data.experiment_figure.status, "not_available");
  assert.equal(failed.data.preview_3d.status, "not_available");
  assert.equal(failed.data.preview_3d.url, undefined);
  assert.equal(calls, 0);
  assert.deepEqual(failed.images, []);
});

test("an explicit no-preview request preserves simulation and setup image without starting a viewer", async t => {
  const openViewer = TOOL_HANDLERS.flex3d_open_viewer;
  let calls = 0;
  TOOL_HANDLERS.flex3d_open_viewer = async () => { calls++; throw new Error("must not open"); };
  t.after(() => { TOOL_HANDLERS.flex3d_open_viewer = openViewer; });
  const sim = await TOOL_HANDLERS.simulate_protocol({
    protocol_path: path.join(root, "examples/01-flex-serial-dilution/protocol.py"),
    generate_3d_preview: false,
  });
  assert.equal(calls, 0);
  assert.equal(sim.data.ok, true);
  assert.equal(sim.data.preview_3d.status, "skipped");
  assert.equal(sim.data.preview_3d.url, undefined);
  assert.equal(sim.data.experiment_figure.ok, true);
  assert.equal(sim.images[0].mimeType, "image/png");
});

test("unavailable or throwing viewers preserve the simulation verdict and setup image", async t => {
  const openViewer = TOOL_HANDLERS.flex3d_open_viewer;
  t.after(() => { TOOL_HANDLERS.flex3d_open_viewer = openViewer; });
  for (const error of ["mujoco_missing", "port_in_use", "throw"]) {
    TOOL_HANDLERS.flex3d_open_viewer = async () => {
      if (error === "throw") throw new Error("preview fixture failure");
      return { data: { ok: false, error, message: "preview unavailable" } };
    };
    const sim = await TOOL_HANDLERS.simulate_protocol({
      protocol_path: path.join(root, "examples/01-flex-serial-dilution/protocol.py"),
    });
    assert.equal(sim.data.ok, true);
    assert.equal(sim.data.parsed_repair.success, true);
    assert.equal(sim.data.preview_3d.status, "unavailable");
    assert.equal(sim.data.preview_3d.error, error === "throw" ? "viewer_start_failed" : error);
    assert.equal(sim.data.preview_3d.url, undefined);
    assert.equal(sim.data.experiment_figure.ok, true);
    assert.equal(sim.images[0].mimeType, "image/png");
  }
});

test("analysis-only simulation exports portable documents without starting the viewer or generating a companion figure", async t => {
  const openViewer = TOOL_HANDLERS.flex3d_open_viewer;
  let viewerCalls = 0;
  TOOL_HANDLERS.flex3d_open_viewer = async () => { viewerCalls++; throw new Error("unexpected viewer"); };
  t.after(() => { TOOL_HANDLERS.flex3d_open_viewer = openViewer; });
  const sim = await TOOL_HANDLERS.simulate_protocol({
    protocol_path: path.join(root, "examples/01-flex-serial-dilution/protocol.py"),
    analysis_only: true,
  });
  assert.equal(sim.data.ok, true, JSON.stringify(sim.data));
  assert.equal(sim.data.experiment_figure, undefined);
  assert.equal(sim.data.preview_3d, undefined);
  assert.equal(successResponse(sim).content.length, 1);
  assert.equal(viewerCalls, 0);
  const artifact = (await TOOL_HANDLERS.protocol_artifacts({ analysis_path: sim.data.analysis_path })).data;
  assert.equal(artifact.documents.animation.status, "ready", JSON.stringify(artifact));
  assert.equal(artifact.documents.setup.status, "ready", JSON.stringify(artifact));
});
