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

function installStatusFetch({ leftTipDetected }) {
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
            model: "p1000_single_v3.6",
            serialNumber: "P1K",
            ok: true,
            state: { tipDetected: leftTipDetected },
          },
          {
            mount: "right",
            instrumentName: "p1000_multi_flex",
            ok: true,
            state: { tipDetected: false },
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

test("live_liquid_recovery_gate is registered", () => {
  const names = new Set(TOOL_DEFINITIONS.map(tool => tool.name));
  assert.equal(names.has("live_liquid_recovery_gate"), true);
  assert.equal(typeof TOOL_HANDLERS.live_liquid_recovery_gate, "function");
});

test("liquid gate handoffs require strict loaded MCP runtime proof", () => {
  const mcpSource = fs.readFileSync(path.resolve(process.cwd(), "index.js"), "utf8");
  const cliSource = fs.readFileSync(
    path.resolve(process.cwd(), "..", "..", "scripts", "live-liquid-recovery-gate.mjs"),
    "utf8",
  );
  const requiredCriteria = [
    "mcp_server.entrypoint under the expected labscriptai-ot clone root",
    "mcp_server.capabilities.runtime_build=liquid-source-map-v2",
    "mcp_server.required_runtime_tools.all_present=true",
    "runtime_recovery_self_test",
  ];

  for (const criterion of requiredCriteria) {
    assert.match(mcpSource, new RegExp(criterion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(cliSource, new RegExp(criterion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("live_liquid_recovery_gate blocks liquid rerun when a tip remains attached", async () => {
  const originalFetch = installStatusFetch({ leftTipDetected: true });
  const originalLogDir = process.env.OPENTRONS_RESULT_LOG_DIR;
  process.env.OPENTRONS_RESULT_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "liquid-gate-log-"));

  try {
    const result = await TOOL_HANDLERS.live_liquid_recovery_gate({
      robot_ip: "10.31.2.149:31950",
      session_id: "liquid-gate-attached-tip",
    });

    assert.equal(result.data.status, "blocked");
    assert.equal(result.data.ok_for_live_liquid_rerun, false);
    assert.deepEqual(result.data.failed_checks, ["no_attached_tip_before_liquid_probe_rerun"]);
    assert.equal(result.data.recommended_next_action, "clear_attached_tip_before_liquid_rerun");
    assert.deepEqual(result.data.allowed_next_tools, [
      "robot_status",
      "live_liquid_recovery_gate",
      "experiment_history",
    ]);
    assert.equal(result.data.human_required, true);
    assert.equal(result.data.resolution_plan.length, 1);
    assert.equal(result.data.resolution_plan[0].check_name, "no_attached_tip_before_liquid_probe_rerun");
    assert.equal(result.data.resolution_plan[0].severity, "blocker");
    assert.equal(result.data.resolution_plan[0].action, "clear_attached_tip_before_liquid_rerun");
    assert.equal(result.data.resolution_plan[0].human_required, true);
    assert.equal(result.data.resolution_plan[0].no_robot_motion, true);
    assert.ok(result.data.resolution_plan[0].acceptance_criteria.some(item => item.includes("tip_detected=true")));
    assert.equal(result.data.operator_request.human_required, true);
    assert.equal(result.data.operator_request.request_count, 1);
    assert.equal(result.data.operator_request.requests[0].request_type, "physical_state");
    assert.equal(result.data.operator_request.requests[0].check_name, "no_attached_tip_before_liquid_probe_rerun");
    assert.match(result.data.operator_request.requests[0].prompt, /attached-tip state/);
    assert.equal(result.data.operator_request.requests[0].no_robot_motion, true);
    const selfTestCheck = result.data.checks.find(check => check.name === "loaded_runtime_recovery_self_test");
    assert.equal(selfTestCheck.status, "pass");
    assert.equal(selfTestCheck.coverage.expected_absent_source.source_map_key, "D3.A12");
    assert.equal(selfTestCheck.coverage.expected_absent_source.source_map_expected_presence, false);
    assert.equal(selfTestCheck.coverage.expected_absent_source.observed_liquid_presence, false);
    assert.equal(selfTestCheck.coverage.expected_absent_source.manual_only, true);
    assert.equal(selfTestCheck.coverage.expected_absent_source.then_resume, false);
    assert.equal(selfTestCheck.coverage.expected_present_source.source_map_key, "D3.A1");
    assert.equal(selfTestCheck.coverage.expected_present_source.source_map_expected_presence, true);
    assert.equal(selfTestCheck.coverage.expected_present_source.observed_liquid_presence, false);
    assert.equal(selfTestCheck.coverage.expected_present_source.manual_only, true);
    assert.equal(selfTestCheck.coverage.expected_present_source.then_resume, false);
    assert.ok(result.data.checks.some(check => check.name === "robot_readonly_connectivity" && check.status === "pass"));

    const history = await TOOL_HANDLERS.experiment_history({
      session_id: "liquid-gate-attached-tip",
      tool_name: "live_liquid_recovery_gate",
    });
    assert.equal(history.data.entries.length, 1);
    assert.equal(history.data.entries[0].event_kind, "live_readiness");
    assert.equal(history.data.entries[0].status, "blocked");
    assert.deepEqual(history.data.entries[0].data.failed_checks, [
      "no_attached_tip_before_liquid_probe_rerun",
    ]);
    assert.equal(
      history.data.entries[0].data.recommended_next_action,
      "clear_attached_tip_before_liquid_rerun",
    );
    assert.equal(
      history.data.entries[0].data.resolution_plan[0].action,
      "clear_attached_tip_before_liquid_rerun",
    );
    assert.equal(
      history.data.entries[0].data.operator_request.requests[0].request_type,
      "physical_state",
    );
    assert.equal(
      history.data.entries[0].data.self_test_coverage.expected_present_source.source_map_key,
      "D3.A1",
    );
    assert.equal(
      history.data.entries[0].data.self_test_coverage.expected_present_source.source_map_expected_presence,
      true,
    );
    assert.equal(
      history.data.entries[0].data.self_test_coverage.expected_present_source.observed_liquid_presence,
      false,
    );
  } finally {
    global.fetch = originalFetch;
    if (originalLogDir === undefined) {
      delete process.env.OPENTRONS_RESULT_LOG_DIR;
    } else {
      process.env.OPENTRONS_RESULT_LOG_DIR = originalLogDir;
    }
  }
});

test("live_liquid_recovery_gate passes when read-only state is clear", async () => {
  const originalFetch = installStatusFetch({ leftTipDetected: false });

  try {
    const result = await TOOL_HANDLERS.live_liquid_recovery_gate({
      robot_ip: "10.31.2.149:31950",
      session_id: "liquid-gate-clear",
    });

    assert.equal(result.data.status, "pass");
    assert.equal(result.data.ok_for_live_liquid_rerun, true);
    assert.deepEqual(result.data.failed_checks, []);
    assert.equal(result.data.recommended_next_action, "run_live_liquid_recovery_tests");
    assert.ok(result.data.allowed_next_tools.includes("runtime_watch_poll"));
    assert.equal(result.data.resolution_plan.length, 1);
    assert.equal(result.data.resolution_plan[0].severity, "ready");
    assert.equal(result.data.resolution_plan[0].no_robot_motion, false);
    assert.equal(result.data.operator_request.human_required, false);
    assert.equal(result.data.operator_request.request_count, 0);
    assert.ok(result.data.next_steps.some(step => step.includes("D3 A12")));
  } finally {
    global.fetch = originalFetch;
  }
});

test("live_liquid_recovery_gate fails when required source-map entries are missing", async () => {
  const originalFetch = installStatusFetch({ leftTipDetected: false });
  const originalSessionDir = process.env.OPENTRONS_SESSION_STATE_DIR;
  process.env.OPENTRONS_SESSION_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "liquid-gate-source-map-missing-"));

  try {
    const result = await TOOL_HANDLERS.live_liquid_recovery_gate({
      robot_ip: "10.31.2.149:31950",
      session_id: "liquid-gate-source-map-missing",
      required_sources: [
        {
          slot_name: "D3",
          well_name: "A1",
          expected_presence: true,
        },
      ],
    });

    const sourceCheck = result.data.checks.find(check => check.name === "source_map_requirements");
    assert.equal(result.data.status, "blocked");
    assert.equal(result.data.ok_for_live_liquid_rerun, false);
    assert.ok(result.data.failed_checks.includes("source_map_requirements"));
    assert.equal(result.data.recommended_next_action, "record_or_correct_liquid_source_map");
    assert.ok(result.data.allowed_next_tools.includes("record_liquid_source_map"));
    assert.deepEqual(sourceCheck.missing_source_keys, ["D3.A1"]);
  } finally {
    global.fetch = originalFetch;
    if (originalSessionDir === undefined) {
      delete process.env.OPENTRONS_SESSION_STATE_DIR;
    } else {
      process.env.OPENTRONS_SESSION_STATE_DIR = originalSessionDir;
    }
  }
});

test("live_liquid_recovery_gate prioritizes source-map fixes over attached-tip cleanup", async () => {
  const originalFetch = installStatusFetch({ leftTipDetected: true });
  const originalSessionDir = process.env.OPENTRONS_SESSION_STATE_DIR;
  process.env.OPENTRONS_SESSION_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "liquid-gate-source-map-priority-"));

  try {
    const result = await TOOL_HANDLERS.live_liquid_recovery_gate({
      robot_ip: "10.31.2.149:31950",
      session_id: "liquid-gate-source-map-priority",
      required_sources: [
        {
          slot_name: "D3",
          well_name: "A1",
          expected_presence: true,
        },
      ],
    });

    assert.deepEqual(result.data.failed_checks, [
      "no_attached_tip_before_liquid_probe_rerun",
      "source_map_requirements",
    ]);
    assert.equal(result.data.recommended_next_action, "record_or_correct_liquid_source_map");
    assert.equal(result.data.reason, "required_liquid_sources_missing_or_mismatched");
  } finally {
    global.fetch = originalFetch;
    if (originalSessionDir === undefined) {
      delete process.env.OPENTRONS_SESSION_STATE_DIR;
    } else {
      process.env.OPENTRONS_SESSION_STATE_DIR = originalSessionDir;
    }
  }
});

test("live_liquid_recovery_gate rejects non-boolean expected_presence values", async () => {
  const originalFetch = installStatusFetch({ leftTipDetected: false });
  const originalSessionDir = process.env.OPENTRONS_SESSION_STATE_DIR;
  process.env.OPENTRONS_SESSION_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "liquid-gate-invalid-presence-"));

  try {
    await TOOL_HANDLERS.record_liquid_source_map({
      session_id: "liquid-gate-invalid-presence",
      sources: [
        {
          slot_name: "D3",
          well_name: "A1",
          liquid_name: "operator-confirmed-liquid",
          expected_presence: true,
        },
      ],
    });

    const result = await TOOL_HANDLERS.live_liquid_recovery_gate({
      robot_ip: "10.31.2.149:31950",
      session_id: "liquid-gate-invalid-presence",
      required_sources: [
        {
          slot_name: "D3",
          well_name: "A1",
          expected_presence: "maybe",
        },
      ],
    });

    const sourceCheck = result.data.checks.find(check => check.name === "source_map_requirements");
    assert.equal(result.data.status, "blocked");
    assert.deepEqual(result.data.failed_checks, ["source_map_requirements"]);
    assert.equal(result.data.recommended_next_action, "record_or_correct_liquid_source_map");
    assert.equal(sourceCheck.invalid_requirements.length, 1);
    assert.equal(sourceCheck.invalid_requirements[0].key, "D3.A1");
    assert.equal(
      sourceCheck.invalid_requirements[0].invalid_reason,
      "expected_presence must be boolean when provided, got string",
    );
  } finally {
    global.fetch = originalFetch;
    if (originalSessionDir === undefined) {
      delete process.env.OPENTRONS_SESSION_STATE_DIR;
    } else {
      process.env.OPENTRONS_SESSION_STATE_DIR = originalSessionDir;
    }
  }
});

test("live_liquid_recovery_gate passes required source-map entries when recorded", async () => {
  const originalFetch = installStatusFetch({ leftTipDetected: false });
  const originalSessionDir = process.env.OPENTRONS_SESSION_STATE_DIR;
  process.env.OPENTRONS_SESSION_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "liquid-gate-source-map-pass-"));

  try {
    await TOOL_HANDLERS.record_liquid_source_map({
      session_id: "liquid-gate-source-map-pass",
      sources: [
        {
          slot_name: "D3",
          well_name: "A1",
          liquid_name: "buffer-a",
          sample_id: "sample-a1",
          expected_presence: true,
        },
      ],
    });
    const result = await TOOL_HANDLERS.live_liquid_recovery_gate({
      robot_ip: "10.31.2.149:31950",
      session_id: "liquid-gate-source-map-pass",
      required_sources: [
        {
          slot_name: "d3",
          well_name: "a1",
          expected_presence: true,
        },
      ],
    });

    const sourceCheck = result.data.checks.find(check => check.name === "source_map_requirements");
    const identityCheck = result.data.checks.find(check => check.name === "source_identity_metadata");
    assert.equal(result.data.status, "pass");
    assert.equal(result.data.ok_for_live_liquid_rerun, true);
    assert.equal(sourceCheck.status, "pass");
    assert.equal(sourceCheck.required_sources[0].key, "D3.A1");
    assert.equal(sourceCheck.required_sources[0].sample_id, "sample-a1");
    assert.equal(identityCheck.status, "pass");
    assert.equal(identityCheck.incomplete_source_count, 0);
  } finally {
    global.fetch = originalFetch;
    if (originalSessionDir === undefined) {
      delete process.env.OPENTRONS_SESSION_STATE_DIR;
    } else {
      process.env.OPENTRONS_SESSION_STATE_DIR = originalSessionDir;
    }
  }
});

test("live_liquid_recovery_gate expands the c3_d3_liquid_recovery source plan", async () => {
  const originalFetch = installStatusFetch({ leftTipDetected: false });
  const originalSessionDir = process.env.OPENTRONS_SESSION_STATE_DIR;
  process.env.OPENTRONS_SESSION_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "liquid-gate-source-plan-"));

  try {
    const result = await TOOL_HANDLERS.live_liquid_recovery_gate({
      robot_ip: "10.31.2.149:31950",
      session_id: "liquid-gate-source-plan",
      source_plan: "c3_d3_liquid_recovery",
    });

    const sourceCheck = result.data.checks.find(check => check.name === "source_map_requirements");
    assert.equal(result.data.source_plan, "c3_d3_liquid_recovery");
    assert.equal(result.data.status, "blocked");
    assert.equal(result.data.recommended_next_action, "record_or_correct_liquid_source_map");
    assert.equal(sourceCheck.required_sources.length, 10);
    assert.deepEqual(sourceCheck.missing_source_keys, [
      "C3.A1",
      "D3.A1",
      "D3.B1",
      "D3.C1",
      "D3.D1",
      "D3.E1",
      "D3.F1",
      "D3.G1",
      "D3.H1",
      "D3.A12",
    ]);
  } finally {
    global.fetch = originalFetch;
    if (originalSessionDir === undefined) {
      delete process.env.OPENTRONS_SESSION_STATE_DIR;
    } else {
      process.env.OPENTRONS_SESSION_STATE_DIR = originalSessionDir;
    }
  }
});

test("live_liquid_recovery_gate rejects unknown source plans", async () => {
  const originalFetch = installStatusFetch({ leftTipDetected: false });

  try {
    const result = await TOOL_HANDLERS.live_liquid_recovery_gate({
      robot_ip: "10.31.2.149:31950",
      session_id: "liquid-gate-unknown-source-plan",
      source_plan: "typo_plan",
    });

    const sourcePlanCheck = result.data.checks.find(check => check.name === "source_plan");
    const sourceMapCheck = result.data.checks.find(check => check.name === "source_map_requirements");
    assert.equal(result.data.status, "blocked");
    assert.deepEqual(result.data.failed_checks, ["source_plan"]);
    assert.equal(result.data.recommended_next_action, "correct_gate_source_plan");
    assert.equal(result.data.reason, "unknown_liquid_source_plan");
    assert.equal(sourcePlanCheck.status, "fail");
    assert.equal(sourcePlanCheck.requested_source_plan, "typo_plan");
    assert.deepEqual(sourcePlanCheck.supported_source_plans, ["c3_d3_liquid_recovery"]);
    assert.equal(sourceMapCheck.required_sources.length, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test("live_liquid_recovery_gate warns when c3_d3_liquid_recovery source identity metadata is incomplete", async () => {
  const originalFetch = installStatusFetch({ leftTipDetected: false });
  const originalSessionDir = process.env.OPENTRONS_SESSION_STATE_DIR;
  process.env.OPENTRONS_SESSION_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "liquid-gate-source-plan-pass-"));
  const sources = [
    { slot_name: "C3", well_name: "A1", expected_presence: true },
    ...["A", "B", "C", "D", "E", "F", "G", "H"].map(row => ({
      slot_name: "D3",
      well_name: `${row}1`,
      expected_presence: true,
    })),
    { slot_name: "D3", well_name: "A12", expected_presence: false },
  ];

  try {
    await TOOL_HANDLERS.record_liquid_source_map({
      session_id: "liquid-gate-source-plan-pass",
      sources,
    });
    const result = await TOOL_HANDLERS.live_liquid_recovery_gate({
      robot_ip: "10.31.2.149:31950",
      session_id: "liquid-gate-source-plan-pass",
      source_plan: "c3_d3_liquid_recovery",
    });

    const sourceCheck = result.data.checks.find(check => check.name === "source_map_requirements");
    const identityCheck = result.data.checks.find(check => check.name === "source_identity_metadata");
    assert.equal(result.data.status, "warn");
    assert.equal(result.data.ok_for_live_liquid_rerun, true);
    assert.deepEqual(result.data.warning_checks, ["source_identity_metadata"]);
    assert.equal(result.data.recommended_next_action, "confirm_liquid_source_identity_before_semantic_recovery");
    assert.deepEqual(result.data.allowed_next_tools, [
      "record_liquid_source_map",
      "get_liquid_source_map",
      "live_liquid_recovery_gate",
    ]);
    assert.equal(result.data.human_required, true);
    assert.equal(sourceCheck.status, "pass");
    assert.equal(sourceCheck.required_sources.length, 10);
    assert.deepEqual(sourceCheck.missing_source_keys, []);
    assert.deepEqual(sourceCheck.mismatched_presence_keys, []);
    assert.equal(identityCheck.status, "warn");
    assert.equal(identityCheck.checked_source_count, 9);
    assert.equal(identityCheck.incomplete_source_count, 9);
    assert.deepEqual(identityCheck.incomplete_sources[0].missing_identity_fields, ["liquid_name", "sample_id"]);
    const identityPlan = result.data.resolution_plan.find(
      step => step.check_name === "source_identity_metadata",
    );
    assert.equal(identityPlan.severity, "warning");
    assert.equal(identityPlan.action, "confirm_liquid_source_identity_before_semantic_recovery");
    assert.equal(identityPlan.human_required, true);
    assert.equal(identityPlan.no_robot_motion, true);
    assert.equal(
      identityPlan.operator_guidance.draft_markdown_path,
      "runs/self-recovery/artifacts/liquid-source-identity-draft.md",
    );
    assert.ok(identityPlan.acceptance_criteria.some(item => item.includes("validate-template-md")));
    assert.equal(result.data.operator_request.human_required, true);
    assert.equal(result.data.operator_request.request_count, 1);
    assert.equal(result.data.operator_request.requests[0].request_type, "liquid_identity");
    assert.equal(result.data.operator_request.requests[0].check_name, "source_identity_metadata");
    assert.match(result.data.operator_request.summary_zh, /继续真机液体/);
    assert.match(result.data.operator_request.requests[0].prompt_zh, /液体/);
    assert.equal(result.data.operator_request.requests[0].inputs_needed.length, 9);
    assert.deepEqual(result.data.operator_request.requests[0].inputs_needed[0], {
      key: "C3.A1",
      slot_name: "C3",
      well_name: "A1",
      current_liquid_name: null,
      current_sample_id: null,
      missing_identity_fields: ["liquid_name", "sample_id"],
    });
    assert.equal(
      result.data.operator_request.requests[0].artifacts.draft_markdown_path,
      "runs/self-recovery/artifacts/liquid-source-identity-draft.md",
    );
    assert.match(
      result.data.operator_request.requests[0].commands.validate_markdown_command,
      /--validate-template-md/,
    );
    assert.equal(
      identityCheck.operator_guidance.draft_markdown_path,
      "runs/self-recovery/artifacts/liquid-source-identity-draft.md",
    );
    assert.match(
      identityCheck.operator_guidance.generate_draft_command,
      /--template-md-out runs\/self-recovery\/artifacts\/liquid-source-identity-draft\.md/,
    );
    assert.match(
      identityCheck.operator_guidance.validate_markdown_command,
      /--validate-template-md runs\/self-recovery\/artifacts\/liquid-source-identity-draft\.md/,
    );
    assert.match(
      identityCheck.operator_guidance.apply_markdown_command,
      /--apply-template-md runs\/self-recovery\/artifacts\/liquid-source-identity-draft\.md/,
    );
    assert.ok(result.data.next_steps.some(step => step.includes("liquid-source-identity-draft.md")));
  } finally {
    global.fetch = originalFetch;
    if (originalSessionDir === undefined) {
      delete process.env.OPENTRONS_SESSION_STATE_DIR;
    } else {
      process.env.OPENTRONS_SESSION_STATE_DIR = originalSessionDir;
    }
  }
});

test("live_liquid_recovery_gate passes c3_d3_liquid_recovery when source identities are complete", async () => {
  const originalFetch = installStatusFetch({ leftTipDetected: false });
  const originalSessionDir = process.env.OPENTRONS_SESSION_STATE_DIR;
  process.env.OPENTRONS_SESSION_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "liquid-gate-source-plan-ready-"));
  const sources = [
    {
      slot_name: "C3",
      well_name: "A1",
      labware_load_name: "nest_12_reservoir_15ml",
      liquid_name: "reservoir-buffer-a",
      sample_id: "reservoir-buffer-a-c3-a1",
      expected_presence: true,
    },
    ...["A", "B", "C", "D", "E", "F", "G", "H"].map(row => ({
      slot_name: "D3",
      well_name: `${row}1`,
      labware_load_name: "corning_96_wellplate_360ul_flat",
      liquid_name: "reaction-sample",
      sample_id: `reaction-sample-d3-${row.toLowerCase()}1`,
      expected_presence: true,
    })),
    {
      slot_name: "D3",
      well_name: "A12",
      labware_load_name: "corning_96_wellplate_360ul_flat",
      liquid_name: "empty-control",
      sample_id: "validated-empty-source-d3-a12",
      expected_presence: false,
    },
  ];

  try {
    await TOOL_HANDLERS.record_liquid_source_map({
      session_id: "liquid-gate-source-plan-ready",
      sources,
    });
    const result = await TOOL_HANDLERS.live_liquid_recovery_gate({
      robot_ip: "10.31.2.149:31950",
      session_id: "liquid-gate-source-plan-ready",
      source_plan: "c3_d3_liquid_recovery",
    });

    const sourceCheck = result.data.checks.find(check => check.name === "source_map_requirements");
    const identityCheck = result.data.checks.find(check => check.name === "source_identity_metadata");
    assert.equal(result.data.status, "pass");
    assert.equal(result.data.ok_for_live_liquid_rerun, true);
    assert.deepEqual(result.data.failed_checks, []);
    assert.deepEqual(result.data.warning_checks, []);
    assert.equal(result.data.recommended_next_action, "run_live_liquid_recovery_tests");
    assert.equal(result.data.human_required, false);
    assert.equal(sourceCheck.status, "pass");
    assert.equal(sourceCheck.required_sources.length, 10);
    assert.equal(identityCheck.status, "pass");
    assert.equal(identityCheck.checked_source_count, 9);
    assert.equal(identityCheck.incomplete_source_count, 0);
  } finally {
    global.fetch = originalFetch;
    if (originalSessionDir === undefined) {
      delete process.env.OPENTRONS_SESSION_STATE_DIR;
    } else {
      process.env.OPENTRONS_SESSION_STATE_DIR = originalSessionDir;
    }
  }
});

test("live_liquid_recovery_gate fails when live observation contradicts source map", async () => {
  const originalFetch = installStatusFetch({ leftTipDetected: false });
  const originalSessionDir = process.env.OPENTRONS_SESSION_STATE_DIR;
  process.env.OPENTRONS_SESSION_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "liquid-gate-observed-mismatch-"));
  const sources = [
    {
      slot_name: "C3",
      well_name: "A1",
      labware_load_name: "nest_12_reservoir_15ml",
      liquid_name: "water",
      sample_id: "water-c3-a1",
      expected_presence: true,
      observed_presence: true,
    },
    ...["A", "B", "C", "D", "E", "F", "G", "H"].map(row => ({
      slot_name: "D3",
      well_name: `${row}1`,
      labware_load_name: "corning_96_wellplate_360ul_flat",
      liquid_name: "water",
      sample_id: `water-d3-${row.toLowerCase()}1`,
      expected_presence: true,
      observed_presence: row === "H" ? false : true,
      observed_run_id: "probe-run",
    })),
    {
      slot_name: "D3",
      well_name: "A12",
      labware_load_name: "corning_96_wellplate_360ul_flat",
      liquid_name: "empty-control",
      sample_id: "validated-empty-source-d3-a12",
      expected_presence: false,
      observed_presence: false,
    },
  ];

  try {
    await TOOL_HANDLERS.record_liquid_source_map({
      session_id: "liquid-gate-observed-mismatch",
      sources,
    });
    const result = await TOOL_HANDLERS.live_liquid_recovery_gate({
      robot_ip: "10.31.2.149:31950",
      session_id: "liquid-gate-observed-mismatch",
      source_plan: "c3_d3_liquid_recovery",
    });

    const sourceCheck = result.data.checks.find(check => check.name === "source_map_requirements");
    assert.equal(result.data.status, "blocked");
    assert.equal(result.data.ok_for_live_liquid_rerun, false);
    assert.ok(result.data.failed_checks.includes("source_map_requirements"));
    assert.equal(sourceCheck.status, "fail");
    assert.deepEqual(sourceCheck.observed_presence_mismatch_keys, ["D3.H1"]);
    assert.equal(
      sourceCheck.required_sources.find(source => source.key === "D3.H1").observed_presence,
      false,
    );
  } finally {
    global.fetch = originalFetch;
    if (originalSessionDir === undefined) {
      delete process.env.OPENTRONS_SESSION_STATE_DIR;
    } else {
      process.env.OPENTRONS_SESSION_STATE_DIR = originalSessionDir;
    }
  }
});

test("live_liquid_recovery_gate allows targeted no-aspirate re-probe for observed mismatch", async () => {
  const originalFetch = installStatusFetch({ leftTipDetected: false });
  const originalSessionDir = process.env.OPENTRONS_SESSION_STATE_DIR;

  process.env.OPENTRONS_SESSION_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "liquid-gate-reprobe-"));
  const sources = [
    {
      slot_name: "C3",
      well_name: "A1",
      labware_load_name: "nest_12_reservoir_15ml",
      liquid_name: "water",
      sample_id: "water-c3-a1",
      expected_presence: true,
      observed_presence: true,
    },
    ...["A", "B", "C", "D", "E", "F", "G", "H"].map(row => ({
      slot_name: "D3",
      well_name: `${row}1`,
      labware_load_name: "corning_96_wellplate_360ul_flat",
      liquid_name: "water",
      sample_id: `water-d3-${row.toLowerCase()}1`,
      expected_presence: true,
      observed_presence: row === "H" ? false : true,
      observed_run_id: "probe-run",
    })),
    {
      slot_name: "D3",
      well_name: "A12",
      labware_load_name: "corning_96_wellplate_360ul_flat",
      liquid_name: "empty-control",
      sample_id: "validated-empty-source-d3-a12",
      expected_presence: false,
      observed_presence: false,
    },
  ];

  try {
    await TOOL_HANDLERS.record_liquid_source_map({
      session_id: "liquid-gate-reprobe",
      sources,
    });
    const result = await TOOL_HANDLERS.live_liquid_recovery_gate({
      robot_ip: "10.31.2.149:31950",
      session_id: "liquid-gate-reprobe",
      source_plan: "c3_d3_liquid_recovery",
      allow_observed_mismatch_reprobe: true,
    });

    const sourceCheck = result.data.checks.find(check => check.name === "source_map_requirements");
    assert.equal(result.data.status, "warn");
    assert.equal(result.data.ok_for_live_liquid_rerun, true);
    assert.deepEqual(result.data.failed_checks, []);
    assert.ok(result.data.warning_checks.includes("source_map_requirements"));
    assert.equal(result.data.recommended_next_action, "run_observed_mismatch_reprobe");
    assert.deepEqual(sourceCheck.observed_presence_mismatch_keys, ["D3.H1"]);
    assert.equal(sourceCheck.observed_mismatch_reprobe_allowed, true);
    assert.deepEqual(sourceCheck.allowed_probe_targets, ["D3.H1"]);
    const sourcePlan = result.data.resolution_plan.find(item => item.check_name === "source_map_requirements");
    assert.deepEqual(sourcePlan.allowed_probe_targets, ["D3.H1"]);
  } finally {
    global.fetch = originalFetch;
    if (originalSessionDir === undefined) {
      delete process.env.OPENTRONS_SESSION_STATE_DIR;
    } else {
      process.env.OPENTRONS_SESSION_STATE_DIR = originalSessionDir;
    }
  }
});
