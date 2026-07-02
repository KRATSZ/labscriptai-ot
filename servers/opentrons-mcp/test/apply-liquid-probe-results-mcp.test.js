import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import { TOOL_DEFINITIONS, TOOL_HANDLERS } from "../index.js";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function installStatusFetch({ leftTipDetected = false } = {}) {
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
        data: [
          {
            mount: "left",
            instrumentName: "p1000_single_flex",
            ok: true,
            state: { tipDetected: leftTipDetected },
          },
        ],
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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "apply-probe-mcp-"));
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

async function seedSubstitutionSources(sessionId) {
  await TOOL_HANDLERS.record_liquid_source_map({
    session_id: sessionId,
    sources: [
      {
        slot_name: "D3",
        well_name: "A1",
        liquid_name: "water",
        sample_id: "water-d3-a1",
        expected_presence: true,
        volume_ul: 100,
        capacity_ul: 200,
        dead_volume_ul: 5,
      },
      {
        slot_name: "C3",
        well_name: "A1",
        liquid_name: "water",
        sample_id: "water-c3-a1",
        expected_presence: true,
        observed_presence: true,
        observed_run_id: "probe-c3-a1",
        observed_source: "live_probe",
        volume_ul: 100,
        capacity_ul: 200,
        dead_volume_ul: 5,
      },
      {
        slot_name: "C3",
        well_name: "A2",
        liquid_name: "water",
        sample_id: "water-c3-a2",
        expected_presence: true,
        volume_ul: 10,
        capacity_ul: 20,
        dead_volume_ul: 0,
      },
    ],
  });
}

test("apply_liquid_probe_results is registered", () => {
  const names = new Set(TOOL_DEFINITIONS.map(tool => tool.name));
  assert.equal(names.has("apply_liquid_probe_results"), true);
  assert.equal(typeof TOOL_HANDLERS.apply_liquid_probe_results, "function");
});

test("apply_liquid_probe_results writes observed volume from actual_volume_ul", async t => {
  withTempPluginData(t);
  const sessionId = "apply-probe-explicit-volume";
  await TOOL_HANDLERS.record_liquid_source_map({
    session_id: sessionId,
    sources: [
      {
        slot_name: "D3",
        well_name: "A1",
        liquid_name: "water",
        sample_id: "water-d3-a1",
        expected_presence: true,
      },
    ],
  });

  const result = await TOOL_HANDLERS.apply_liquid_probe_results({
    session_id: sessionId,
    slot_name: "D3",
    well_name: "A1",
    actual_volume_ul: 88.5,
    run_id: "probe-run-1",
  });

  assert.equal(result.data.trust_level, "observed");
  assert.equal(result.data.volume_ul, 88.5);
  assert.equal(result.data.method, "explicit");
  assert.equal(result.data.container_key, "D3.A1");
  assert.equal(result.data.observed_run_id, "probe-run-1");

  const map = await TOOL_HANDLERS.get_liquid_source_map({ session_id: sessionId, slot_name: "D3" });
  const entry = map.data.sources.find(source => source.key === "D3.A1");
  assert.equal(entry.trust_level, "observed");
  assert.equal(entry.volume_ul, 88.5);
  assert.equal(entry.observed_source, "live_probe");
});

test("apply_liquid_probe_results writes presence-only observations with null volume", async t => {
  withTempPluginData(t);
  const sessionId = "apply-probe-presence-only";
  await TOOL_HANDLERS.record_liquid_source_map({
    session_id: sessionId,
    sources: [
      {
        slot_name: "D3",
        well_name: "A12",
        liquid_name: "empty-control",
        sample_id: "empty-d3-a12",
        expected_presence: false,
      },
    ],
  });

  const result = await TOOL_HANDLERS.apply_liquid_probe_results({
    session_id: sessionId,
    slot_name: "D3",
    well_name: "A12",
    observed_presence: false,
    run_id: "probe-run-empty",
  });

  assert.equal(result.data.trust_level, "observed");
  assert.equal(result.data.volume_ul, null);
  assert.equal(result.data.method, "presence_only");
  assert.equal(result.data.observed_presence, false);
  assert.equal(result.data.observed_presence_mismatch, false);

  const map = await TOOL_HANDLERS.get_liquid_source_map({ session_id: sessionId });
  const entry = map.data.sources.find(source => source.key === "D3.A12");
  assert.equal(entry.trust_level, "observed");
  assert.equal(entry.volume_ul, null);
  assert.equal(entry.observed_presence, false);
});

test("apply_liquid_probe_results converts height_mm when heightMmToVolumeUl is available", async t => {
  const probeMod = await import("../lib/probe.js");
  if (typeof probeMod.heightMmToVolumeUl !== "function") {
    t.skip("heightMmToVolumeUl export not yet available from parallel worker");
    return;
  }

  withTempPluginData(t);
  const sessionId = "apply-probe-height";
  await TOOL_HANDLERS.record_liquid_source_map({
    session_id: sessionId,
    sources: [
      {
        slot_name: "D3",
        well_name: "B1",
        labware_load_name: "corning_96_wellplate_360ul_flat",
        liquid_name: "water",
        sample_id: "water-d3-b1",
        expected_presence: true,
      },
    ],
  });

  const result = await TOOL_HANDLERS.apply_liquid_probe_results({
    session_id: sessionId,
    slot_name: "D3",
    well_name: "B1",
    labware_load_name: "corning_96_wellplate_360ul_flat",
    height_mm: 12.4,
    run_id: "probe-run-height",
  });

  assert.equal(result.data.trust_level, "observed");
  assert.ok(Number.isFinite(result.data.volume_ul));
  assert.notEqual(result.data.method, "explicit");
  assert.notEqual(result.data.method, "presence_only");
});

test("live_liquid_recovery_gate blocks on pending probe writeback and clears after apply", async t => {
  const tempRoot = withTempPluginData(t);
  const originalFetch = installStatusFetch();
  const sessionId = "pending-probe-gate";

  try {
    writePendingProbeRun(
      sessionId,
      {
        run_id: "probe-run-pending",
        mode: "detect_presence",
        wells: [{ slot_name: "D3", well_name: "H1", applied: false }],
      },
      tempRoot,
    );

    const blocked = await TOOL_HANDLERS.live_liquid_recovery_gate({
      robot_ip: "10.31.2.149:31950",
      session_id: sessionId,
    });

    assert.equal(blocked.data.blocked_by, "pending_probe_writeback");
    assert.equal(blocked.data.ok_for_live_liquid_rerun, false);
    assert.deepEqual(blocked.data.pending_probe_wells, [
      {
        slot_name: "D3",
        well_name: "H1",
        run_id: "probe-run-pending",
        mode: "detect_presence",
      },
    ]);

    await TOOL_HANDLERS.apply_liquid_probe_results({
      session_id: sessionId,
      slot_name: "D3",
      well_name: "H1",
      observed_presence: true,
      run_id: "probe-run-pending",
    });

    const cleared = await TOOL_HANDLERS.live_liquid_recovery_gate({
      robot_ip: "10.31.2.149:31950",
      session_id: sessionId,
    });

    assert.notEqual(cleared.data.blocked_by, "pending_probe_writeback");
    assert.deepEqual(cleared.data.pending_probe_wells, []);
  } finally {
    global.fetch = originalFetch;
  }
});

test("live_liquid_recovery_gate suffix preflight enables final_auto_resume_eligible when suffix passes", async t => {
  withTempPluginData(t);
  const originalFetch = installStatusFetch();
  const sessionId = "suffix-pass-gate";

  try {
    await seedSubstitutionSources(sessionId);
    const result = await TOOL_HANDLERS.live_liquid_recovery_gate({
      robot_ip: "10.31.2.149:31950",
      session_id: sessionId,
      failed_source_key: "D3.A1",
      preferred_source_key: "C3.A1",
      error_step_index: 0,
      recovery_steps: [
        {
          id: "suffix-pick-tip",
          type: "pick_up_tip",
          pipette_id: "left",
          tiprack_slot: "D1",
          well_name: "A1",
        },
        {
          id: "suffix-transfer",
          type: "transfer",
          source_key: "D3.A1",
          target_key: "C3.A2",
          volume_ul: 5,
          pipette_id: "left",
        },
      ],
    });

    assert.equal(result.data.substitution_plan?.auto_resume_eligible, true);
    assert.equal(result.data.suffix_sufficient, true);
    assert.equal(result.data.final_auto_resume_eligible, true);
    assert.notEqual(result.data.blocked_by, "suffix_plan_not_sufficient");
  } finally {
    global.fetch = originalFetch;
  }
});

test("live_liquid_recovery_gate blocks auto-resume when suffix replay fails", async t => {
  withTempPluginData(t);
  const originalFetch = installStatusFetch();
  const sessionId = "suffix-fail-gate";

  try {
    await seedSubstitutionSources(sessionId);
    const result = await TOOL_HANDLERS.live_liquid_recovery_gate({
      robot_ip: "10.31.2.149:31950",
      session_id: sessionId,
      failed_source_key: "D3.A1",
      preferred_source_key: "C3.A1",
      error_step_index: 0,
      recovery_steps: [
        {
          id: "suffix-pick-tip",
          type: "pick_up_tip",
          pipette_id: "left",
          tiprack_slot: "D1",
          well_name: "A1",
        },
        {
          id: "suffix-overflow",
          type: "transfer",
          source_key: "D3.A1",
          target_key: "C3.A2",
          volume_ul: 25,
          pipette_id: "left",
        },
      ],
    });

    assert.equal(result.data.blocked_by, "suffix_plan_not_sufficient");
    assert.equal(result.data.suffix_sufficient, false);
    assert.equal(result.data.final_auto_resume_eligible, false);
    assert.ok(Array.isArray(result.data.suffix_violations));
    assert.ok(result.data.suffix_violations.length > 0);
    const suffixCheck = result.data.checks.find(check => check.name === "suffix_plan_not_sufficient");
    assert.equal(suffixCheck.status, "fail");
    assert.ok(suffixCheck.violations.length > 0);
  } finally {
    global.fetch = originalFetch;
  }
});
