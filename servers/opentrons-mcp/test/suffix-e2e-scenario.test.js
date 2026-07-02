/**
 * End-to-end software scenario for the "three locks":
 *   1) Trust monotonicity — observed volume cannot be overwritten by simulated absolute writes
 *   2) Probe writeback gate — live probe without apply_liquid_probe_results blocks recovery
 *   3) Suffix sufficiency — patched suffix must replay cleanly before final_auto_resume_eligible
 *
 * Pure software; no robot motion. Uses real lib modules; MCP handlers are dynamically imported
 * with contract stubs when parallel workers have not landed them yet.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  setLiquidContainerState,
  setLiquidSourceState,
  setContainerVolume,
  readSessionState,
  writeSessionState,
} from "../lib/state.js";
import { evaluateSuffixSufficiency } from "../lib/suffix-monitor.js";
import {
  buildLiquidSourceSubstitutionPlan,
  setSuffixSufficiencyOnPlan,
} from "../lib/liquid-source-substitution.js";

const SESSION_ID = "suffix-e2e-three-locks";
const A1 = "D3.A1";
const A2 = "D3.A2";
const TARGET = "C3.A1";

function buildBaseSessionState() {
  return {
    session_id: SESSION_ID,
    state_revision: 0,
    deck: { slots: {} },
    pipettes: { left: { tip_attached: true } },
    tip_tracking: { tipracks: {} },
    liquid_tracking: { containers: {}, sources: {} },
    state_history: [],
    cleanup: { pending_actions: [], auto_home_allowed: null },
  };
}

function buildSourceMapEntries() {
  return {
    [A1]: {
      slot_name: "D3",
      well_name: "A1",
      labware_load_name: "corning_96_wellplate_360ul_flat",
      liquid_name: "water",
      sample_id: "water-d3-a1",
      expected_presence: true,
    },
    [A2]: {
      slot_name: "D3",
      well_name: "A2",
      labware_load_name: "corning_96_wellplate_360ul_flat",
      liquid_name: "water",
      sample_id: "water-d3-a2",
      expected_presence: true,
      observed_presence: true,
      observed_source: "live_probe",
    },
  };
}

function declareContainers(state) {
  setLiquidContainerState(state, {
    container_key: A1,
    role: "source",
    volume_ul: 100,
    capacity_ul: 200,
    dead_volume_ul: 0,
    trust_level: "simulated",
    liquid_name: "water",
  });
  setLiquidContainerState(state, {
    container_key: A2,
    role: "source",
    volume_ul: 100,
    capacity_ul: 200,
    dead_volume_ul: 0,
    trust_level: "observed",
    liquid_name: "water",
  });
  setLiquidContainerState(state, {
    container_key: TARGET,
    role: "destination",
    volume_ul: 0,
    capacity_ul: 200,
    dead_volume_ul: 0,
    trust_level: "declared",
  });
  for (const [key, source] of Object.entries(buildSourceMapEntries())) {
    setLiquidSourceState(state, { ...source, why: "suffix_e2e_source_map" });
  }
  return state;
}

function buildProtocolSteps() {
  return [
    {
      id: "declare-a1",
      type: "declare_container",
      container_key: A1,
      role: "source",
      volume_ul: 100,
      capacity_ul: 200,
      dead_volume_ul: 0,
    },
    {
      id: "declare-a2",
      type: "declare_container",
      container_key: A2,
      role: "source",
      volume_ul: 100,
      capacity_ul: 200,
      dead_volume_ul: 0,
    },
    {
      id: "declare-target",
      type: "declare_container",
      container_key: TARGET,
      role: "destination",
      volume_ul: 0,
      capacity_ul: 200,
      dead_volume_ul: 0,
    },
    {
      id: "transfer-50",
      type: "transfer",
      source_key: A1,
      target_key: TARGET,
      volume_ul: 50,
      pipette_id: "left",
    },
    {
      id: "transfer-60",
      type: "transfer",
      source_key: A1,
      target_key: TARGET,
      volume_ul: 60,
      pipette_id: "left",
    },
  ];
}

function sessionStateAtA1Failure({ a2VolumeUl = 100 } = {}) {
  const state = buildBaseSessionState();
  declareContainers(state);
  state.liquid_tracking.containers[A1].volume_ul = 0;
  state.liquid_tracking.containers[A1].trust_level = "simulated";
  state.liquid_tracking.containers[A2].volume_ul = a2VolumeUl;
  state.liquid_tracking.containers[A2].trust_level = "observed";
  state.liquid_tracking.containers[TARGET].volume_ul = 50;
  return state;
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installStatusFetch() {
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const requestUrl = new URL(url);
    const pathname = requestUrl.pathname;
    const method = options.method || "GET";

    if (method === "GET" && pathname === "/health") {
      return jsonResponse({
        name: "Silabrobot001",
        robot_model: "OT-3 Standard",
        robot_serial: "FLX-1",
        api_version: "9.0.0",
      });
    }
    if (method === "GET" && pathname === "/instruments") {
      return jsonResponse({
        data: [{ mount: "left", instrumentName: "p1000_single_flex", ok: true, state: { tipDetected: false } }],
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
  return originalFetch;
}

function withTempPluginData(t) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "suffix-e2e-plugin-"));
  const originalPluginData = process.env.PLUGIN_DATA;
  const originalSessionDir = process.env.OPENTRONS_SESSION_STATE_DIR;
  const originalResultLogDir = process.env.OPENTRONS_RESULT_LOG_DIR;
  process.env.PLUGIN_DATA = tempRoot;
  process.env.OPENTRONS_SESSION_STATE_DIR = path.join(tempRoot, "session-state");
  process.env.OPENTRONS_RESULT_LOG_DIR = path.join(tempRoot, "result-logs");
  t.after(() => {
    if (originalPluginData === undefined) {
      delete process.env.PLUGIN_DATA;
    } else {
      process.env.PLUGIN_DATA = originalPluginData;
    }
    if (originalSessionDir === undefined) {
      delete process.env.OPENTRONS_SESSION_STATE_DIR;
    } else {
      process.env.OPENTRONS_SESSION_STATE_DIR = originalSessionDir;
    }
    if (originalResultLogDir === undefined) {
      delete process.env.OPENTRONS_RESULT_LOG_DIR;
    } else {
      process.env.OPENTRONS_RESULT_LOG_DIR = originalResultLogDir;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  return tempRoot;
}

function writePendingProbeRun(sessionId, entry, pluginDataRoot) {
  const pendingDir = path.join(pluginDataRoot, "pending-probe-runs");
  fs.mkdirSync(pendingDir, { recursive: true });
  fs.writeFileSync(
    path.join(pendingDir, `${sessionId}.json`),
    `${JSON.stringify({ runs: [entry] }, null, 2)}\n`,
  );
}

function readPendingProbeRunsFile(pluginDataRoot, sessionId) {
  const pendingPath = path.join(pluginDataRoot, "pending-probe-runs", `${sessionId}.json`);
  if (!fs.existsSync(pendingPath)) {
    return { runs: [] };
  }
  return JSON.parse(fs.readFileSync(pendingPath, "utf8"));
}

function markPendingProbeWriteback(sessionState, { slot_name = "D3", well_name = "A2", run_id = "probe-run-1" } = {}) {
  sessionState.pending_probe_writeback = {
    slot_name,
    well_name,
    container_key: `${slot_name}.${well_name}`,
    run_id,
    probed_at: new Date().toISOString(),
  };
  return sessionState;
}

function evaluateProbeWritebackGate(sessionState) {
  if (sessionState?.pending_probe_writeback) {
    return {
      ok_for_live_liquid_rerun: false,
      status: "blocked",
      blocked_by: "pending_probe_writeback",
      pending: sessionState.pending_probe_writeback,
    };
  }
  return {
    ok_for_live_liquid_rerun: true,
    status: "pass",
    blocked_by: null,
    pending: null,
  };
}

function stubApplyLiquidProbeResults(sessionState, args = {}) {
  const slot = String(args.slot_name || "D3").toUpperCase();
  const well = String(args.well_name || "A2").toUpperCase();
  const containerKey = `${slot}.${well}`;
  const volumeUl = args.actual_volume_ul ?? 100;
  setLiquidContainerState(sessionState, {
    container_key: containerKey,
    role: "source",
    volume_ul: volumeUl,
    capacity_ul: 200,
    dead_volume_ul: 0,
    trust_level: "observed",
    observed_presence: args.observed_presence ?? true,
    observed_source: "apply_liquid_probe_results",
    why: "suffix_e2e_probe_writeback",
  });
  setLiquidSourceState(sessionState, {
    slot_name: slot,
    well_name: well,
    liquid_name: "water",
    expected_presence: true,
    observed_presence: args.observed_presence ?? true,
    observed_source: "apply_liquid_probe_results",
  });
  delete sessionState.pending_probe_writeback;
  return {
    data: {
      trust_level: "observed",
      volume_ul: volumeUl,
      method: args.height_mm != null ? "height_to_volume" : "direct",
      observed_presence_mismatch: false,
      container_key: containerKey,
    },
  };
}

function simulateProbeWellsResponse({ execute_on_robot = true } = {}) {
  return {
    data: {
      execute_on_robot,
      pending_state_writeback: execute_on_robot,
      required_next_tool: "apply_liquid_probe_results",
      probe_results: [{ well: "A2", mode: "measure_height", success: true, value: 12.5 }],
    },
  };
}

async function loadMcpHandlers() {
  try {
    const mcp = await import("../index.js");
    return {
      handlers: mcp.TOOL_HANDLERS || {},
      loadError: null,
    };
  } catch (error) {
    return {
      handlers: {},
      loadError: error instanceof Error ? error.message : String(error),
    };
  }
}

test("lock 1: simulated absolute write cannot downgrade observed trust on A2", () => {
  const state = buildBaseSessionState();
  declareContainers(state);

  assert.equal(state.liquid_tracking.containers[A1].trust_level, "simulated");
  assert.equal(state.liquid_tracking.containers[A1].volume_ul, 100);
  assert.equal(state.liquid_tracking.containers[A2].trust_level, "observed");
  assert.equal(state.liquid_tracking.containers[A2].volume_ul, 100);

  const violations = [];
  setContainerVolume(state, A2, 80, { id: "sim-override" }, "e2e:simulated_absolute", "simulated", "absolute", violations);

  assert.equal(violations.length, 1);
  assert.equal(violations[0].code, "trust_downgrade_blocked");
  assert.equal(state.liquid_tracking.containers[A2].volume_ul, 100);
  assert.equal(state.liquid_tracking.containers[A2].trust_level, "observed");
});

test("lock 2: probe without apply_liquid_probe_results blocks gate; apply clears blocker", async t => {
  const tempRoot = withTempPluginData(t);
  const originalFetch = installStatusFetch();
  t.after(() => {
    global.fetch = originalFetch;
  });

  const { handlers, loadError } = await loadMcpHandlers();
  const applyHandler = handlers.apply_liquid_probe_results;
  const gateHandler = handlers.live_liquid_recovery_gate;
  assert.equal(typeof applyHandler, "function", loadError || "apply_liquid_probe_results must be registered");
  assert.equal(typeof gateHandler, "function", loadError || "live_liquid_recovery_gate must be registered");

  const state = sessionStateAtA1Failure();
  writeSessionState(state);

  writePendingProbeRun(
    SESSION_ID,
    {
      run_id: "probe-run-1",
      mode: "measure_height",
      wells: [{ slot_name: "D3", well_name: "A2", applied: false }],
    },
    tempRoot,
  );

  const probeResponse = simulateProbeWellsResponse({ execute_on_robot: true });
  assert.equal(probeResponse.data.pending_state_writeback, true);
  assert.equal(probeResponse.data.required_next_tool, "apply_liquid_probe_results");

  const blocked = await gateHandler({
    robot_ip: "10.31.2.149:31950",
    session_id: SESSION_ID,
  });
  assert.equal(blocked.data.blocked_by, "pending_probe_writeback");
  assert.equal(blocked.data.ok_for_live_liquid_rerun, false);
  assert.deepEqual(blocked.data.pending_probe_wells, [
    {
      slot_name: "D3",
      well_name: "A2",
      run_id: "probe-run-1",
      mode: "measure_height",
    },
  ]);

  const applyResult = await applyHandler({
    session_id: SESSION_ID,
    slot_name: "D3",
    well_name: "A2",
    actual_volume_ul: 100,
    observed_presence: true,
    run_id: "probe-run-1",
  });
  assert.equal(applyResult.data.trust_level, "observed");
  assert.equal(applyResult.data.container_key, A2);
  assert.equal(applyResult.data.volume_ul, 100);

  const pendingAfterApply = readPendingProbeRunsFile(tempRoot, SESSION_ID);
  assert.deepEqual(pendingAfterApply.runs, []);

  const sessionAfterApply = readSessionState(SESSION_ID);
  assert.equal(sessionAfterApply.liquid_tracking.containers[A2].trust_level, "observed");

  const cleared = await gateHandler({
    robot_ip: "10.31.2.149:31950",
    session_id: SESSION_ID,
  });
  assert.notEqual(cleared.data.blocked_by, "pending_probe_writeback");
  assert.deepEqual(cleared.data.pending_probe_wells, []);
});

test("lock 3a: A1→A2 substitution suffix sufficient → final_auto_resume_eligible", () => {
  const steps = buildProtocolSteps();
  const sessionState = sessionStateAtA1Failure({ a2VolumeUl: 100 });
  const errorStepIndex = 4;

  const suffixResult = evaluateSuffixSufficiency({
    sessionState,
    steps,
    errorStepIndex,
    patch: { type: "replace_source", from_key: A1, to_key: A2 },
  });

  assert.equal(suffixResult.suffix_sufficient, true);
  assert.deepEqual(suffixResult.violations, []);
  assert.equal(suffixResult.patchedSuffix[0].source_key, A2);

  const plan = buildLiquidSourceSubstitutionPlan({
    sessionState: {
      ...sessionState,
      liquid_tracking: {
        ...sessionState.liquid_tracking,
        sources: buildSourceMapEntries(),
      },
    },
    failedSourceKey: A1,
    preferredSourceKey: A2,
  });

  assert.equal(plan.auto_resume_eligible, true);
  assert.equal(plan.selected_source_key, A2);

  const gated = setSuffixSufficiencyOnPlan({ ...plan }, suffixResult);
  assert.equal(gated.suffix_sufficient, true);
  assert.equal(gated.final_auto_resume_eligible, true);
  assert.notEqual(gated.blocked_reason, "suffix_plan_not_sufficient");
});

test("lock 3b: insufficient A2 volume → suffix_plan_not_sufficient blocks final auto-resume", () => {
  const steps = buildProtocolSteps();
  const sessionState = sessionStateAtA1Failure({ a2VolumeUl: 40 });
  const errorStepIndex = 4;

  const suffixResult = evaluateSuffixSufficiency({
    sessionState,
    steps,
    errorStepIndex,
    patch: { type: "replace_source", from_key: A1, to_key: A2 },
  });

  assert.equal(suffixResult.suffix_sufficient, false);
  assert.ok(suffixResult.violations.some(v => v.code === "aspirate_exceeds_available_volume"));

  const plan = buildLiquidSourceSubstitutionPlan({
    sessionState: {
      ...sessionState,
      liquid_tracking: {
        ...sessionState.liquid_tracking,
        sources: buildSourceMapEntries(),
      },
    },
    failedSourceKey: A1,
    preferredSourceKey: A2,
  });

  assert.equal(plan.auto_resume_eligible, true);
  assert.equal(plan.final_auto_resume_eligible, false);
  assert.equal(plan.blocked_reason, "suffix_plan_not_sufficient");

  const gated = setSuffixSufficiencyOnPlan({ ...plan }, suffixResult);
  assert.equal(gated.suffix_sufficient, false);
  assert.equal(gated.final_auto_resume_eligible, false);
  assert.equal(gated.blocked_reason, "suffix_plan_not_sufficient");
});

test("e2e orchestration: substitution after A1 failure respects all three locks", async () => {
  const state = sessionStateAtA1Failure({ a2VolumeUl: 100 });

  const substitutionPlan = buildLiquidSourceSubstitutionPlan({
    sessionState: {
      ...state,
      liquid_tracking: { ...state.liquid_tracking, sources: buildSourceMapEntries() },
    },
    failedSourceKey: A1,
    preferredSourceKey: A2,
  });
  assert.equal(substitutionPlan.selected_source_key, A2);

  markPendingProbeWriteback(state);
  assert.equal(evaluateProbeWritebackGate(state).blocked_by, "pending_probe_writeback");

  stubApplyLiquidProbeResults(state, { slot_name: "D3", well_name: "A2", actual_volume_ul: 100 });
  assert.equal(evaluateProbeWritebackGate(state).blocked_by, null);

  const suffixResult = evaluateSuffixSufficiency({
    sessionState: state,
    steps: buildProtocolSteps(),
    errorStepIndex: 4,
    patch: {
      type: "replace_source",
      from_key: substitutionPlan.patch.failed_source_key,
      to_key: substitutionPlan.patch.replacement_source_key,
    },
  });
  const finalPlan = setSuffixSufficiencyOnPlan(substitutionPlan, suffixResult);
  assert.equal(finalPlan.final_auto_resume_eligible, true);

  const trustViolations = [];
  setContainerVolume(state, A2, 50, { id: "late-sim" }, "e2e:late_override", "simulated", "absolute", trustViolations);
  assert.equal(trustViolations[0]?.code, "trust_downgrade_blocked");
  assert.equal(state.liquid_tracking.containers[A2].trust_level, "observed");
});
