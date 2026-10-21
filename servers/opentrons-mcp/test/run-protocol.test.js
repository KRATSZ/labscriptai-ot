import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

import { TOOL_HANDLERS } from "../index.js";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function createFakeSimulationRunner(tempDir, { simulatePass = true } = {}) {
  const runnerPath = path.join(tempDir, "fake-simulation-runner.py");
  const script = [
    "#!/usr/bin/env python3",
    "import json",
    "import sys",
    "",
    "command = sys.argv[2] if len(sys.argv) > 2 else ''",
    "protocol = sys.argv[-1] if command == 'simulate' and len(sys.argv) > 3 else None",
    "",
    "if command == 'doctor':",
    "    print(json.dumps({",
    "        'ok': True,",
    "        'python': sys.argv[0],",
    "        'workspace_root': None,",
    "        'api_root': None,",
    "        'shared_data_root': None,",
    "        'source_layout_ready': False,",
    "        'opentrons_simulate': {'ok': True, 'module': 'opentrons.simulate'}",
    "    }))",
    simulatePass
      ? [
          "elif command == 'simulate':",
          "    print(json.dumps({",
          "        'ok': True,",
          "        'python': sys.argv[0],",
          "        'module': 'opentrons.simulate',",
          "        'protocol': protocol,",
          "        'workspace_root': None,",
          "        'api_root': None,",
          "        'shared_data_root': None,",
          "        'source_layout_ready': False,",
          "        'exit_code': 0,",
          "        'stdout': '',",
          "        'stderr': '',",
          "        'error': None",
          "    }))",
        ].join("\n")
      : [
          "elif command == 'simulate':",
          "    print(json.dumps({",
          "        'ok': False,",
          "        'python': sys.argv[0],",
          "        'module': 'opentrons.simulate',",
          "        'protocol': protocol,",
          "        'workspace_root': None,",
          "        'api_root': None,",
          "        'shared_data_root': None,",
          "        'source_layout_ready': False,",
          "        'exit_code': 1,",
          "        'stdout': '',",
          "        'stderr': 'SyntaxError: invalid syntax\\n',",
          "        'error': {'error_type': 'SyntaxError', 'error': 'invalid syntax'}",
          "    }))",
        ].join("\n"),
    "elif command == 'analyze':",
    "    out = None",
    "    if '--json-output' in sys.argv:",
    "        out = sys.argv[sys.argv.index('--json-output') + 1]",
    "    protocol = sys.argv[-1]",
    `    passed = ${simulatePass ? "True" : "False"}`,
    "    if out:",
    "        with open(out, 'w', encoding='utf-8') as handle:",
    "            json.dump({'robotType': 'OT-3 Standard', 'errors': [] if passed else [{'detail': 'SyntaxError'}]}, handle)",
    "    print(json.dumps({",
    "        'ok': passed,",
    "        'protocol': protocol,",
    "        'exit_code': 0 if passed else 1,",
    "        'stdout': '',",
    "        'stderr': '' if passed else 'SyntaxError: invalid syntax\\n',",
    "        'analysis_path': out,",
    "        'robot_type': 'OT-3 Standard',",
    "        'error_count': 0 if passed else 1,",
    "        'error': None",
    "    }))",
    "else:",
    "    raise SystemExit(f'unsupported command: {command}')",
    "",
  ].join("\n");

  fs.writeFileSync(runnerPath, script);
  fs.chmodSync(runnerPath, 0o755);
  return runnerPath;
}

test("run_protocol uploads, plays, and returns final run snapshot", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "opentrons-run-"));
  const protocolPath = path.join(tempDir, "noop_protocol.py");
  const fakeRunnerPath = createFakeSimulationRunner(tempDir, { simulatePass: true });
  fs.writeFileSync(
    protocolPath,
    [
      "from opentrons import protocol_api",
      "",
      'metadata = {"protocolName": "Noop"}',
      'requirements = {"robotType": "Flex", "apiLevel": "2.22"}',
      "",
      "def run(protocol: protocol_api.ProtocolContext) -> None:",
      '    protocol.comment("noop")',
      "",
    ].join("\n"),
  );

  const originalFetch = global.fetch;
  let runCreateBody = null;
  global.fetch = async (url, options = {}) => {
    const requestUrl = new URL(url);
    const pathname = requestUrl.pathname;
    const method = options.method || "GET";

    if (method === "POST" && pathname === "/protocols") {
      return jsonResponse({ data: { id: "protocol-1", files: [] } });
    }
    if (method === "GET" && pathname === "/labwareOffsets") {
      return jsonResponse({
        data: [
          {
            id: "offset-1",
            createdAt: "2026-06-09T07:40:47.905554Z",
            definitionUri: "opentrons/nest_96_wellplate_200ul_flat/3",
            locationSequence: "anyLocation",
            vector: { x: 0, y: 0, z: 0 },
          },
          {
            id: "offset-2",
            createdAt: "2026-06-09T07:40:47.905554Z",
            definitionUri: "opentrons/nest_96_wellplate_200ul_flat/3",
            locationSequence: [
              { kind: "onModule", moduleModel: "temperatureModuleV2" },
              { kind: "onAddressableArea", addressableAreaName: "temperatureModuleV2C1" },
            ],
            vector: { x: 0, y: 0, z: 5 },
          },
        ],
      });
    }
    if (method === "POST" && pathname === "/runs") {
      runCreateBody = JSON.parse(options.body || "{}");
      return jsonResponse({
        data: {
          id: "run-1",
          status: "idle",
          labwareOffsets: runCreateBody?.data?.labwareOffsets ?? [],
        },
      });
    }
    if (method === "GET" && pathname === "/runs/run-1") {
      return jsonResponse({
        data: { id: "run-1", protocolId: "protocol-1", status: "succeeded", labware: [] },
      });
    }
    if (method === "POST" && pathname === "/runs/run-1/actions") {
      return jsonResponse({ data: { id: "action-1", actionType: "play" } });
    }
    if (method === "GET" && pathname === "/runs/run-1") {
      return jsonResponse({ data: { id: "run-1", protocolId: "protocol-1", status: "succeeded" } });
    }
    if (method === "GET" && pathname === "/runs/run-1/commands") {
      return jsonResponse({
        data: [{ id: "cmd-1", commandType: "comment", status: "succeeded" }],
      });
    }
    if (method === "GET" && pathname === "/health") {
      return jsonResponse({ name: "Flex", robot_model: "OT-3 Standard", robot_serial: "FLX-1" });
    }
    if (method === "GET" && pathname === "/instruments") {
      return jsonResponse({
        data: [{ mount: "left", instrumentName: "p1000_single_flex", ok: true }],
      });
    }
    if (method === "GET" && pathname === "/robot/door/status") {
      return jsonResponse({ data: { status: "closed" } });
    }
    if (method === "GET" && pathname === "/robot/control/estopStatus") {
      return jsonResponse({ data: { status: "disengaged" } });
    }
    if (method === "GET" && pathname === "/deck_configuration") {
      return jsonResponse({ data: { cutoutFixtures: [] } });
    }
    if (method === "GET" && pathname === "/modules") {
      return jsonResponse({ data: [] });
    }

    throw new Error(`Unexpected request: ${method} ${requestUrl.toString()}`);
  };

  try {
    // The fake python runner only implements doctor/simulate/analyze, so the
    // LogicPass bridge cannot run under it; the pure gate behavior is covered
    // in logicpass-fixes.test.js. Here we assert the upload/play flow.
    const result = await TOOL_HANDLERS.run_protocol({
      robot_ip: "10.31.2.149:31950",
      file_path: protocolPath,
      python_executable: fakeRunnerPath,
      skip_logicpass_gate: true,
      timeout_ms: 10,
      poll_interval_ms: 1,
    });

    assert.equal(result.runId, "run-1");
    assert.equal(result.data.final_status, "succeeded");
    assert.equal(result.data.requires_attention, false);
    assert.equal(result.data.simulation_gate.parsed.success, true);
    assert.equal(result.data.preflight_gate?.ok, true);
    assert.equal(result.data.final_run_history.run_id, "run-1");
    assert.equal(runCreateBody?.data?.labwareOffsets?.length, 1);
    assert.equal(runCreateBody.data.labwareOffsets[0].vector.z, 5);
    assert.ok(Array.isArray(runCreateBody.data.labwareOffsets[0].locationSequence));
    assert.equal(result.hardwareSnapshot.run.data.id, "run-1");
    assert.equal(result.hardwareSnapshot.health.robot_serial, "FLX-1");
  } finally {
    global.fetch = originalFetch;
  }
});

test("run_protocol blocks real execution when simulation fails", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "opentrons-run-fail-"));
  const protocolPath = path.join(tempDir, "broken_protocol.py");
  const fakeRunnerPath = createFakeSimulationRunner(tempDir, { simulatePass: false });
  fs.writeFileSync(
    protocolPath,
    [
      "from opentrons import protocol_api",
      "",
      'metadata = {"protocolName": "Broken"}',
      'requirements = {"robotType": "Flex", "apiLevel": "2.22"}',
      "",
      "def run(protocol: protocol_api.ProtocolContext) -> None:",
      "    pipette.pick_up_tip(",
      "",
    ].join("\n"),
  );

  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = async () => {
    fetchCalled = true;
    throw new Error("fetch should not be called when simulation gate fails");
  };

  try {
    await assert.rejects(
      () =>
        TOOL_HANDLERS.run_protocol({
          robot_ip: "10.31.2.149:31950",
          file_path: protocolPath,
          python_executable: fakeRunnerPath,
          timeout_ms: 10,
          poll_interval_ms: 1,
        }),
      /Simulation gate blocked real execution/,
    );
    assert.equal(fetchCalled, false);
  } finally {
    global.fetch = originalFetch;
  }
});

function realPythonPath() {
  return process.env.OPENTRONS_PYTHON || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.venv/bin/python");
}

function mockRobotFetch() {
  return async (url, options = {}) => {
    const requestUrl = new URL(url);
    const method = options.method || "GET";
    const json = (payload) => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    if (method === "POST" && requestUrl.pathname === "/protocols") {
      return json({ data: { id: "protocol-1", files: [] } });
    }
    if (method === "GET" && requestUrl.pathname === "/labwareOffsets") {
      return json({ data: [] });
    }
    if (method === "POST" && requestUrl.pathname === "/runs") {
      return json({ data: { id: "run-1", status: "idle" } });
    }
    if (method === "POST" && requestUrl.pathname === "/runs/run-1/actions") {
      return json({ data: { id: "action-1", actionType: "play" } });
    }
    if (method === "GET" && requestUrl.pathname === "/runs/run-1") {
      return json({ data: { id: "run-1", protocolId: "protocol-1", status: "succeeded" } });
    }
    if (method === "GET" && requestUrl.pathname === "/runs/run-1/commands") {
      return json({ data: [{ id: "cmd-1", commandType: "comment", status: "succeeded" }] });
    }
    if (method === "GET" && requestUrl.pathname === "/health") {
      return json({ name: "Flex", robot_model: "OT-3 Standard", robot_serial: "FLX-1" });
    }
    if (method === "GET" && requestUrl.pathname === "/instruments") {
      return json({ data: [{ mount: "left", instrumentName: "p1000_single_flex", ok: true }] });
    }
    if (method === "GET" && requestUrl.pathname === "/robot/door/status") {
      return json({ data: { status: "closed" } });
    }
    if (method === "GET" && requestUrl.pathname === "/robot/control/estopStatus") {
      return json({ data: { status: "disengaged" } });
    }
    if (method === "GET" && requestUrl.pathname === "/deck_configuration") {
      return json({ data: { cutoutFixtures: [] } });
    }
    if (method === "GET" && requestUrl.pathname === "/modules") {
      return json({ data: [] });
    }
    throw new Error(`Unexpected request: ${method} ${requestUrl.toString()}`);
  };
}

test("run_protocol blocks real execution when LogicPass verdict is fail (LP-L1 dry well)", { timeout: 120000, skip: !fs.existsSync(process.env.OPENTRONS_PYTHON || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.venv/bin/python")) }, async () => {
  const python = realPythonPath();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "opentrons-run-lp-"));
  const protocolPath = path.join(tempDir, "dry_well_protocol.py");
  // Simulation passes this protocol (Opentrons sim does not track liquid),
  // but LogicPass LP-L1 fails it: aspirate from a never-loaded well.
  fs.writeFileSync(
    protocolPath,
    [
      "from opentrons import protocol_api",
      "",
      'metadata = {"protocolName": "LogicPass dry well"}',
      'requirements = {"robotType": "Flex", "apiLevel": "2.24"}',
      "",
      "def run(protocol: protocol_api.ProtocolContext) -> None:",
      '    protocol.load_trash_bin("A3")',
      '    tips = protocol.load_labware("opentrons_flex_96_tiprack_1000ul", "B1")',
      '    pipette = protocol.load_instrument("flex_1channel_1000", "left", tip_racks=[tips])',
      '    plate = protocol.load_labware("nest_96_wellplate_200ul_flat", "C1")',
      '    water = protocol.define_liquid(name="water", description="", display_color="#0000FF")',
      '    plate["A1"].load_liquid(liquid=water, volume=0.0)',
      "    pipette.pick_up_tip()",
      '    pipette.aspirate(50, plate["A1"])',
      "    pipette.drop_tip()",
      "",
    ].join("\n"),
  );
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = async (url, options = {}) => {
    fetchCalled = true;
    return mockRobotFetch()(url, options);
  };
  try {
    await assert.rejects(
      () =>
        TOOL_HANDLERS.run_protocol({
          robot_ip: "10.31.2.149:31950",
          file_path: protocolPath,
          python_executable: python,
          timeout_ms: 10,
          poll_interval_ms: 1,
        }),
      (error) => {
        assert.match(error.message, /LogicPass gate blocked real execution/);
        assert.equal(error.toolContext?.data?.gate_stage, "logicpass_check");
        assert.equal(error.toolContext?.data?.logicpass_gate?.outcome, "fail");
        return true;
      },
    );
    assert.equal(fetchCalled, false, "robot must not be contacted when LogicPass blocks");
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("run_protocol proceeds to upload/play when LogicPass passes (comment-only protocol)", { timeout: 120000, skip: !fs.existsSync(process.env.OPENTRONS_PYTHON || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.venv/bin/python")) }, async () => {
  const python = realPythonPath();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "opentrons-run-lp-ok-"));
  const protocolPath = path.join(tempDir, "noop_protocol.py");
  fs.writeFileSync(
    protocolPath,
    [
      "from opentrons import protocol_api",
      "",
      'metadata = {"protocolName": "Noop"}',
      'requirements = {"robotType": "Flex", "apiLevel": "2.24"}',
      "",
      "def run(protocol: protocol_api.ProtocolContext) -> None:",
      '    protocol.comment("noop")',
      "",
    ].join("\n"),
  );
  const originalFetch = global.fetch;
  global.fetch = mockRobotFetch();
  try {
    const result = await TOOL_HANDLERS.run_protocol({
      robot_ip: "10.31.2.149:31950",
      file_path: protocolPath,
      python_executable: python,
      timeout_ms: 10,
      poll_interval_ms: 1,
    });
    assert.equal(result.runId, "run-1");
    assert.equal(result.data.final_status, "succeeded");
    assert.equal(result.data.simulation_gate.logicpass.final_pass_v2, true);
    assert.equal(result.data.simulation_gate.logicpass.skipped, false);
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("explicit ledger waiver runs without probing when door/estop APIs are unavailable", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opentrons-override-"));
  const file = path.join(dir, "test.py");
  fs.writeFileSync(file, "def run(protocol):\n    protocol.comment('operator test')\n");
  const python = createFakeSimulationRunner(dir);
  const original = { fetch: global.fetch, ledger: TOOL_HANDLERS.logicpass_check, probe: TOOL_HANDLERS.probe_wells, env: process.env.OPENTRONS_ENABLE_PROBE_WELLS };
  const requests = [];
  let ledgerCalls = 0;
  delete process.env.OPENTRONS_ENABLE_PROBE_WELLS;
  TOOL_HANDLERS.logicpass_check = async () => {
    ledgerCalls++;
    return { data: { outcome: "unevaluable", final_pass_v2: false, issues: [{ code: "LP-L5", detail_text: "unsupported command" }] } };
  };
  TOOL_HANDLERS.probe_wells = async () => { throw new Error("The operator declined probing"); };
  global.fetch = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    requests.push([options.method || "GET", pathname]);
    if (pathname === "/robot/door/status") return jsonResponse({ error: "not supported" }, 404);
    if (pathname === "/robot/control/estopStatus") return jsonResponse({ error: "unavailable" }, 503);
    return mockRobotFetch()(url, options);
  };
  const args = { file_path: file, robot_ip: "robot.invalid", python_executable: python, timeout_ms: 10, poll_interval_ms: 1 };
  try {
    await assert.rejects(() => TOOL_HANDLERS.run_protocol(args), error => {
      assert.equal(error.toolContext.data.logicpass_gate.outcome, "unevaluable");
      assert.deepEqual(error.toolContext.data.logicpass_gate.operator_override.arguments, { skip_logicpass_gate: true });
      return true;
    });
    assert.equal(requests.length, 0, "default gate stops before upload");
    const result = await TOOL_HANDLERS.run_protocol({ ...args, skip_logicpass_gate: true });
    assert.equal(ledgerCalls, 1, "explicit waiver does not re-run the unsupported check");
    assert.equal(result.data.final_status, "succeeded");
    assert.deepEqual(result.data.simulation_gate.logicpass, { skipped: true, outcome: "skipped", logic_pass: null, final_pass_v2: null });
    assert.equal(result.data.preflight_gate.allowed_to_play, true);
    assert.deepEqual(result.data.preflight_gate.not_checked, ["door", "estop"]);
    assert.equal(result.data.preflight_gate.warnings_count, 2);
    assert.equal(result.data.preflight_gate.home_safety.auto_home_allowed, false, "unknown state does not authorize separate maintenance homing");
    assert.equal(result.hardwareSnapshot.door_status.unavailable, true);
    assert.equal(requests.filter(([method, route]) => method === "POST" && route.endsWith("/actions")).length, 1);

    const deckWaived = await TOOL_HANDLERS.run_protocol({ ...args, skip_logicpass_gate: true, skip_preflight_deck_diff: true });
    assert.equal(deckWaived.data.final_status, "succeeded");
    assert.deepEqual(deckWaived.data.preflight_gate.skipped_checks, ["deck_diff"]);
    assert.equal(deckWaived.data.preflight_gate.deck_diff.status, "skipped");

    const waived = await TOOL_HANDLERS.run_protocol({ ...args, skip_logicpass_gate: true, skip_preflight: true });
    assert.equal(waived.data.preflight_gate.skipped, true);
    assert.equal(waived.data.preflight_gate.ok, null, "skipped is not passed");
    assert.equal(waived.data.preflight_gate.allowed_to_play, true);
  } finally {
    global.fetch = original.fetch;
    TOOL_HANDLERS.logicpass_check = original.ledger;
    TOOL_HANDLERS.probe_wells = original.probe;
    if (original.env === undefined) delete process.env.OPENTRONS_ENABLE_PROBE_WELLS;
    else process.env.OPENTRONS_ENABLE_PROBE_WELLS = original.env;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a ledger waiver does not waive simulation or a known preflight hardware blocker", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opentrons-override-blocker-"));
  const file = path.join(dir, "test.py");
  fs.writeFileSync(file, "def run(protocol):\n    pass\n");
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    requests.push([options.method || "GET", pathname]);
    if (pathname === "/robot/control/estopStatus") return jsonResponse({ data: { status: "physicallyEngaged" } });
    return mockRobotFetch()(url, options);
  };
  const args = { file_path: file, robot_ip: "robot.invalid", skip_logicpass_gate: true, timeout_ms: 10, poll_interval_ms: 1 };
  try {
    await assert.rejects(() => TOOL_HANDLERS.run_protocol({ ...args, skip_preflight: true, python_executable: createFakeSimulationRunner(dir, { simulatePass: false }) }), /Simulation gate blocked/);
    assert.equal(requests.length, 0);
    fs.appendFileSync(file, "# revised protocol with a passing local analysis\n");
    await assert.rejects(() => TOOL_HANDLERS.run_protocol({ ...args, python_executable: createFakeSimulationRunner(dir) }), error => {
      assert.equal(error.toolContext.data.gate_stage, "preflight_run_setup");
      assert.ok(error.toolContext.data.preflight_run_setup.errors.some(item => item.blockers?.includes("estop_engaged")));
      return true;
    });
    assert.equal(requests.some(([method, route]) => method === "POST" && route.endsWith("/actions")), false);
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
