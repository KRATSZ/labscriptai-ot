import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "deck-vision-flow-"));
process.env.PLUGIN_DATA = temp;
process.env.OPENTRONS_RESULT_LOG_DIR = path.join(temp, "logs");
process.env.OPENTRONS_CONNECTION_FILE = path.join(temp, "connection.json");
process.env.OPENTRONS_DECK_LAYOUT_POLICY = path.join(temp, "policy.json");
process.env.OPENTRONS_DECK_CALIBRATION = path.join(temp, "calibration.json");
const { TOOL_HANDLERS } = await import("../index.js");
const { buildDeckVisionLayout } = await import("../lib/deck-vision-layout.js");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const python = process.env.OPENTRONS_PYTHON || path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const robot = "192.0.2.44";
const policy = { fixed_slots: { A3: { role: "trash_bin" } }, detection_slots: ["A2", "B2", "B3", "C2"], detection_classes: ["tiprack_1000", "plate", "reservoir"] };
fs.writeFileSync(process.env.OPENTRONS_DECK_LAYOUT_POLICY, JSON.stringify(policy));
const calibration = { robot, optional_deck_corners_norm: [[0, 0], [1, 0], [1, 1], [0, 1]] };
const protocol = path.join(temp, "layout.py");
fs.writeFileSync(protocol, [
  'requirements = {"robotType": "Flex", "apiLevel": "2.22"}',
  "def run(p):",
  '    p.load_trash_bin("A3")',
  '    locations = ["A2"]',
  '    for slot in locations:',
  '        p.load_labware("opentrons_flex_96_tiprack_1000ul", location=slot)',
  '    p.load_labware("corning_96_wellplate_360ul_flat", "B2")',
  '    p.load_labware("nest_12_reservoir_15ml", "C2")',
].join("\n"));
after(() => fs.rmSync(temp, { recursive: true, force: true }));

test("starting layout follows commands, not final locations, and excludes later additions", () => {
  const analysis = {
    robotType: "OT-3 Standard", labware: [{ loadName: "plate", location: { slotName: "B3" } }],
    commands: [
      { commandType: "home" },
      { commandType: "loadLabware", params: { location: { slotName: "B2" }, loadName: "corning_96_wellplate_360ul_flat" } },
      { commandType: "moveLabware", params: { newLocation: { slotName: "B3" } } },
      { commandType: "loadLabware", params: { location: { slotName: "C2" }, loadName: "nest_12_reservoir_15ml" } },
    ],
  };
  const starting = buildDeckVisionLayout({ analysis, policy });
  assert.deepEqual(starting.expected_layout, { A2: "empty", B2: "plate", B3: "empty" });
  assert.deepEqual(starting.not_checked, ["later_load_starting_placement_unknown:C2"]);
  assert.deepEqual(buildDeckVisionLayout({ analysis, policy, runTimeParameters: { values: { count: 2 } } }).not_checked, ["runtime_parameter_layout_not_resolved"]);
  assert.deepEqual(buildDeckVisionLayout({ analysis: { robotType: "OT-2 Standard", commands: [] }, policy }).not_checked, ["ot2_vision_not_supported"]);
  const unknown = buildDeckVisionLayout({ analysis: { commands: [{ commandType: "loadLabware", params: { location: { slotName: "C2" }, loadName: "custom_tuberack" } }] }, policy });
  assert.equal(Object.hasOwn(unknown.expected_layout, "C2"), false);
  assert.ok(unknown.not_checked[0].includes("unsupported_labware:C2"));
});

function json(payload) {
  return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
}

async function withRobot(body) {
  const originalFetch = global.fetch;
  const originalCapture = TOOL_HANDLERS.capture_preview_image;
  const originalVision = TOOL_HANDLERS.vision_check;
  const originalArk = TOOL_HANDLERS.analyze_image_with_ark;
  const state = { events: [], visionArgs: [], mismatch: false, cameraError: false, backendError: false };
  fs.writeFileSync(process.env.OPENTRONS_DECK_CALIBRATION, JSON.stringify(calibration));
  process.env.OPENTRONS_PREFLIGHT_VISION = "auto";
  global.fetch = async (url, options = {}) => {
    const p = new URL(url).pathname;
    const method = options.method || "GET";
    if (method === "POST" && p === "/protocols") { state.events.push("upload"); return json({ data: { id: "protocol-v" } }); }
    if (p === "/labwareOffsets") return json({ data: [] });
    if (method === "POST" && p === "/runs") return json({ data: { id: "run-v", status: "idle" } });
    if (method === "POST" && p === "/runs/run-v/actions") { state.events.push("action"); return json({ data: { actionType: JSON.parse(options.body).data.actionType } }); }
    if (p === "/runs/run-v") return json({ data: { id: "run-v", protocolId: "protocol-v", status: "succeeded", labware: [] } });
    if (p === "/runs/run-v/commands") return json({ data: [] });
    if (p === "/health") return json({ robot_model: "OT-3 Standard", robot_serial: "vision-test" });
    if (p === "/instruments") return json({ data: [] });
    if (p === "/robot/door/status") return json({ data: { status: "closed" } });
    if (p === "/robot/control/estopStatus") return json({ data: { status: "disengaged" } });
    if (p === "/deck_configuration") return json({ data: { cutoutFixtures: [] } });
    if (p === "/modules") return json({ data: [] });
    throw new Error(`Unexpected robot request ${method} ${p}`);
  };
  TOOL_HANDLERS.capture_preview_image = async () => {
    state.events.push("capture");
    if (state.cameraError) throw new Error("camera endpoint unavailable");
    return { data: { saved_to: path.join(temp, "deck.jpg") } };
  };
  TOOL_HANDLERS.vision_check = async args => {
    state.events.push("vision"); state.visionArgs.push(args);
    if (state.backendError) return { data: { error: { type: "ImportError" }, slot_observations: {}, mismatches: [] } };
    return { data: {
      slot_observations: Object.fromEntries(Object.entries(args.expected_layout).map(([slot, label]) => [slot, { state: label === "empty" ? "empty" : "occupied", label }])),
      slot_mapping: { method: "deck_homography" },
      mismatches: state.mismatch ? [{ slot: "B2", reason: "expected_occupied_but_empty" }] : [],
      uncertainties: [], needs_human_review: state.mismatch, summary: state.mismatch ? "B2 plate missing" : "Layout matches",
      annotated_image_path: path.join(temp, "annotated.jpg"),
    } };
  };
  TOOL_HANDLERS.analyze_image_with_ark = async () => { throw new Error("No external VLM access in tests"); };
  try { await body(state); } finally {
    global.fetch = originalFetch;
    TOOL_HANDLERS.capture_preview_image = originalCapture;
    TOOL_HANDLERS.vision_check = originalVision;
    TOOL_HANDLERS.analyze_image_with_ark = originalArk;
  }
}

const runArgs = { robot_ip: robot, file_path: protocol, python_executable: python, skip_logicpass_gate: true, session_id: "vision-test-session", timeout_ms: 100, poll_interval_ms: 1 };

test("run checks the analyzed starting deck BEFORE play and persists the observation", { skip: !fs.existsSync(python) }, async () => withRobot(async state => {
  const result = await TOOL_HANDLERS.run_protocol(runArgs);
  assert.equal(result.data.vision_gate.status, "passed");
  assert.ok(state.events.indexOf("vision") < state.events.indexOf("action"));
  assert.deepEqual(state.visionArgs[0].expected_layout, { A2: "tiprack", B2: "plate", B3: "empty", C2: "reservoir" });
  const report = JSON.parse(fs.readFileSync(result.data.vision_gate.report_path, "utf8"));
  assert.equal(report.run_id, "run-v");
  assert.equal(report.layout.source, "simulation_analysis");
  assert.equal(report.observation_only, true);
  assert.equal(report.consensus.layout_consistent_with_expected, true);
  assert.ok(report.observed_at);
  assert.ok(report.yolo.annotated_image_path.endsWith("annotated.jpg"));
}));

test("visual mismatch stops play and keeps its report even if VLM is unavailable", { skip: !fs.existsSync(python) }, async () => withRobot(async state => {
  state.mismatch = true;
  await assert.rejects(() => TOOL_HANDLERS.run_protocol(runArgs), error => {
    assert.equal(error.toolContext.data.gate_stage, "deck_vision");
    assert.equal(error.toolContext.runId, "run-v");
    const gate = error.toolContext.data.vision_gate;
    assert.equal(gate.status, "auto_fixable");
    assert.equal(gate.allowed_to_play, false);
    assert.ok(fs.existsSync(gate.report_path));
    assert.equal(gate.vlm_error.recoverable, true);
    return true;
  });
  assert.ok(!state.events.includes("action"));
  await assert.rejects(() => TOOL_HANDLERS.control_run({ robot_ip: robot, run_id: "run-v", action: "play" }), /Deck vision stopped play/);
  assert.equal(state.events.filter(e => e === "capture").length, 2, "retrying the created run must take a new observation");
  assert.ok(!state.events.includes("action"));
}));

test("unavailable camera is recorded as not_checked and does not stop an ordinary run", { skip: !fs.existsSync(python) }, async () => withRobot(async state => {
  state.cameraError = true;
  const result = await TOOL_HANDLERS.run_protocol(runArgs);
  assert.equal(result.data.vision_gate.status, "not_checked");
  assert.equal(result.data.vision_gate.reason, "camera_capture_unavailable");
  assert.ok(state.events.includes("action"));
}));

test("waived or deferred checks never capture; a deck-only diff waiver still checks vision", { skip: !fs.existsSync(python) }, async () => withRobot(async state => {
  for (const extra of [{ preflight_vision: "off" }, { skip_preflight: true }, { auto_play: false }]) {
    const result = await TOOL_HANDLERS.run_protocol({ ...runArgs, ...extra });
    assert.equal(result.data.vision_gate.status, "skipped");
  }
  assert.ok(!state.events.includes("capture"));
  assert.equal(state.events.filter(e => e === "action").length, 2);
  const delayed = await TOOL_HANDLERS.control_run({ robot_ip: robot, run_id: "run-v", action: "play" });
  assert.equal(delayed.data.vision_gate.status, "passed", "a deferred run checks immediately before its actual play");
  assert.deepEqual(state.visionArgs[0].expected_layout, { A2: "tiprack", B2: "plate", B3: "empty", C2: "reservoir" });
  const checked = await TOOL_HANDLERS.run_protocol({ ...runArgs, skip_preflight_deck_diff: true });
  assert.equal(checked.data.vision_gate.status, "passed");
}));

test("changed-deck resume takes a fresh photo against CURRENT expectations and blocks a mismatch", async () => withRobot(async state => {
  const args = { robot_ip: robot, run_id: "run-v", action: "play", deck_changed: true, expected_layout: { B3: "plate" } };
  const first = await TOOL_HANDLERS.control_run(args);
  assert.equal(first.data.vision_gate.status, "passed");
  assert.deepEqual(state.visionArgs[0].expected_layout, { B3: "plate" });
  state.mismatch = true;
  await assert.rejects(() => TOOL_HANDLERS.control_run({ ...args, action: "resume-from-recovery" }), /Deck vision stopped play/);
  assert.equal(state.events.filter(e => e === "capture").length, 2);
  assert.equal(state.events.filter(e => e === "action").length, 1);
  await TOOL_HANDLERS.control_run({ ...args, action: "stop" });
  assert.equal(state.events.filter(e => e === "capture").length, 2);
}));

test("missing calibration, missing expectations and failed inference never pass", async () => withRobot(async state => {
  const args = { mode: "preflight", robot_ip: robot, expected_layout: { B2: "plate" } };
  fs.unlinkSync(process.env.OPENTRONS_DECK_CALIBRATION);
  const missing = await TOOL_HANDLERS.deck_vision_check(args);
  assert.equal(missing.data.status, "not_checked");
  assert.equal(missing.data.reason, "camera_calibration_unavailable");
  assert.ok(!state.events.includes("capture"));
  fs.writeFileSync(process.env.OPENTRONS_DECK_CALIBRATION, JSON.stringify({ ...calibration, robot: "192.0.2.99" }));
  const wrongRobot = await TOOL_HANDLERS.deck_vision_check(args);
  assert.equal(wrongRobot.data.reason, "camera_calibration_robot_mismatch");
  assert.ok(!state.events.includes("capture"));
  fs.writeFileSync(process.env.OPENTRONS_DECK_CALIBRATION, JSON.stringify(calibration));
  assert.equal((await TOOL_HANDLERS.deck_vision_check({ mode: "preflight", robot_ip: robot })).data.status, "not_checked");
  state.backendError = true;
  assert.equal((await TOOL_HANDLERS.deck_vision_check(args)).data.status, "not_checked");
  process.env.OPENTRONS_PREFLIGHT_VISION = "off";
  assert.equal((await TOOL_HANDLERS.deck_vision_check(args)).data.status, "skipped");
  assert.equal((await TOOL_HANDLERS.deck_vision_check({ ...args, preflight_vision: "on" })).data.status, "not_checked");
  assert.equal(state.events.filter(e => e === "capture").length, 3);
}));
