import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import { TOOL_HANDLERS } from "../index.js";
import { buildRestartReview, buildSafeNextAction } from "../lib/restart-review.js";
import { writeSessionState } from "../lib/state.js";
import { appendResultLogEntry } from "../lib/result-log.js";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("buildRestartReview includes run_history and parse_error when last_run_id is set", () => {
  const data = buildRestartReview({
    sessionState: {
      session_id: "s-run",
      state_revision: 1,
      needs_reconciliation: false,
      last_run_id: "run-abc",
      cleanup: { pending_actions: [] },
    },
    logEntries: [],
    homeSafety: null,
  });

  const order = data.guidance.suggested_tool_order;
  assert.ok(order.indexOf("reconcile_state") === -1);
  assert.ok(order.indexOf("robot_status") < order.indexOf("run_history"));
  assert.ok(order.indexOf("run_history") < order.indexOf("parse_error"));
  assert.ok(order.includes("experiment_history"));
  assert.ok(order.includes("is_home_safe"));
});

test("buildRestartReview extends narrative when home safety preview blocks auto-home", () => {
  const data = buildRestartReview({
    sessionState: {
      session_id: "s1",
      state_revision: 1,
      needs_reconciliation: false,
      last_run_id: null,
      cleanup: { pending_actions: [] },
    },
    logEntries: [
      {
        tool_name: "run_protocol",
        status: "succeeded",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
    ],
    homeSafety: {
      auto_home_allowed: false,
      blockers: ["tip_attached:left"],
      minimum_cleanup_actions: ["drop_tip:left"],
    },
  });

  assert.equal(data.guidance.home_safety_preview?.auto_home_allowed, false);
  assert.match(data.guidance.narrative, /Live home-safety preview disallows auto-home/i);
});

test("buildSafeNextAction recommends reconcile_state when session needs reconciliation", () => {
  const data = buildRestartReview({
    sessionState: {
      session_id: "s-rec",
      state_revision: 2,
      needs_reconciliation: true,
      last_run_id: "run-x",
      cleanup: { pending_actions: [] },
    },
    logEntries: [],
    homeSafety: null,
  });
  const sn = buildSafeNextAction(data);
  assert.equal(sn.recommended_next_tool, "reconcile_state");
  assert.equal(sn.reconcile_first, true);
  assert.ok(sn.operator_steps[0].includes("reconcile_state"));
});

test("buildSafeNextAction recommends robot_status when no reconciliation flag", () => {
  const data = buildRestartReview({
    sessionState: {
      session_id: "s-ok",
      state_revision: 1,
      needs_reconciliation: false,
      last_run_id: null,
      cleanup: { pending_actions: [] },
    },
    logEntries: [],
    homeSafety: null,
  });
  const sn = buildSafeNextAction(data);
  assert.equal(sn.recommended_next_tool, "robot_status");
  assert.equal(sn.reconcile_first, false);
});

test("buildSafeNextAction surfaces home blockers and cleanup actions from preview", () => {
  const data = buildRestartReview({
    sessionState: {
      session_id: "s-home",
      state_revision: 1,
      needs_reconciliation: false,
      last_run_id: "run-home",
      cleanup: { pending_actions: [] },
    },
    logEntries: [],
    homeSafety: {
      auto_home_allowed: false,
      blockers: ["tip_attached:left", "cleanup_pending"],
      minimum_cleanup_actions: ["drop_tip:left", "finish_cleanup_motion"],
    },
  });
  const sn = buildSafeNextAction(data);
  assert.equal(sn.home_action_required, true);
  assert.deepEqual(sn.home_blockers, ["tip_attached:left", "cleanup_pending"]);
  assert.deepEqual(sn.minimum_cleanup_actions, ["drop_tip:left", "finish_cleanup_motion"]);
  assert.ok(sn.operator_steps.some((step) => step.includes("Do not home yet")));
  assert.ok(sn.operator_steps.some((step) => step.includes("drop_tip:left")));
});

test("buildRestartReview flags reconcile_first when session needs reconciliation", () => {
  const data = buildRestartReview({
    sessionState: {
      session_id: "s1",
      state_revision: 2,
      needs_reconciliation: true,
      last_run_id: "run-x",
      cleanup: { pending_actions: [] },
    },
    logEntries: [
      {
        tool_name: "run_protocol",
        status: "succeeded",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
    ],
    homeSafety: null,
  });

  assert.equal(data.guidance.reconcile_first, true);
  assert.equal(data.guidance.logs_are_historical_only, true);
  assert.ok(data.guidance.suggested_tool_order.includes("reconcile_state"));
  assert.equal(data.guidance.home_safety_preview, null);
  assert.equal(data.recent_log_summary.total, 1);
});

test("restart_review handler includes run_history and parse_error when last_run_id is set", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "opentrons-restart-order-"));
  const sessionDir = path.join(tempDir, "session-state");
  const logDir = path.join(tempDir, "result-logs");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });

  const originalSessionDir = process.env.OPENTRONS_SESSION_STATE_DIR;
  const originalLogDir = process.env.OPENTRONS_RESULT_LOG_DIR;

  process.env.OPENTRONS_SESSION_STATE_DIR = sessionDir;
  process.env.OPENTRONS_RESULT_LOG_DIR = logDir;

  try {
    writeSessionState({
      session_id: "order-session",
      needs_reconciliation: false,
      state_revision: 2,
      last_run_id: "run-active",
      deck: { slots: {} },
      cleanup: { pending_actions: [] },
    });

    appendResultLogEntry({
      session_id: "order-session",
      run_id: "run-active",
      tool_name: "run_protocol",
      event_kind: "protocol_run",
      status: "succeeded",
      summary: "Historical success",
    });

    const result = await TOOL_HANDLERS.restart_review({
      session_id: "order-session",
      limit: 5,
    });

    const order = result.data.guidance.suggested_tool_order;
    assert.ok(order.includes("run_history"));
    assert.ok(order.includes("parse_error"));
    assert.ok(order.indexOf("robot_status") < order.indexOf("run_history"));
    assert.ok(order.indexOf("run_history") < order.indexOf("parse_error"));
    assert.equal(result.data.guidance.reconcile_first, false);
  } finally {
    if (originalSessionDir === undefined) {
      delete process.env.OPENTRONS_SESSION_STATE_DIR;
    } else {
      process.env.OPENTRONS_SESSION_STATE_DIR = originalSessionDir;
    }
    if (originalLogDir === undefined) {
      delete process.env.OPENTRONS_RESULT_LOG_DIR;
    } else {
      process.env.OPENTRONS_RESULT_LOG_DIR = originalLogDir;
    }
  }
});

test("safe_next_action handler merges safe_next_action summary into restart_review data", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "opentrons-safe-next-"));
  const sessionDir = path.join(tempDir, "session-state");
  const logDir = path.join(tempDir, "result-logs");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });

  const originalSessionDir = process.env.OPENTRONS_SESSION_STATE_DIR;
  const originalLogDir = process.env.OPENTRONS_RESULT_LOG_DIR;

  process.env.OPENTRONS_SESSION_STATE_DIR = sessionDir;
  process.env.OPENTRONS_RESULT_LOG_DIR = logDir;

  try {
    writeSessionState({
      session_id: "sns-session",
      needs_reconciliation: false,
      state_revision: 1,
      last_run_id: "run-active",
      deck: { slots: {} },
      cleanup: { pending_actions: [] },
    });

    const result = await TOOL_HANDLERS.safe_next_action({
      session_id: "sns-session",
      limit: 5,
    });

    assert.ok(result.data.guidance);
    assert.ok(result.data.safe_next_action);
    assert.equal(result.data.safe_next_action.recommended_next_tool, "robot_status");
    assert.equal(result.data.safe_next_action.reconcile_first, false);
  } finally {
    if (originalSessionDir === undefined) {
      delete process.env.OPENTRONS_SESSION_STATE_DIR;
    } else {
      process.env.OPENTRONS_SESSION_STATE_DIR = originalSessionDir;
    }
    if (originalLogDir === undefined) {
      delete process.env.OPENTRONS_RESULT_LOG_DIR;
    } else {
      process.env.OPENTRONS_RESULT_LOG_DIR = originalLogDir;
    }
  }
});

test("restart_review and safe_next_action surface latest live resolution plan", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "opentrons-restart-resolution-plan-"));
  const sessionDir = path.join(tempDir, "session-state");
  const logDir = path.join(tempDir, "result-logs");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });

  const originalSessionDir = process.env.OPENTRONS_SESSION_STATE_DIR;
  const originalLogDir = process.env.OPENTRONS_RESULT_LOG_DIR;

  process.env.OPENTRONS_SESSION_STATE_DIR = sessionDir;
  process.env.OPENTRONS_RESULT_LOG_DIR = logDir;

  try {
    writeSessionState({
      session_id: "resolution-session",
      needs_reconciliation: false,
      state_revision: 1,
      deck: { slots: {} },
      cleanup: { pending_actions: [] },
    });

    const entry = appendResultLogEntry({
      session_id: "resolution-session",
      run_id: null,
      tool_name: "live_liquid_recovery_gate_cli",
      event_kind: "live_readiness",
      status: "blocked",
      summary: "Latest live liquid gate blocked.",
      data: {
        output_path: "/tmp/live-liquid-gate.json",
        operator_request_json_path: "/tmp/live-liquid-operator-request.json",
        operator_request_md_path: "/tmp/live-liquid-operator-request.md",
        operator_request: {
          human_required: true,
          request_count: 1,
          summary: "Human input is required before live liquid watcher/probe tests can continue.",
          summary_zh: "继续真机液体 watcher/probe 测试前，需要人先处理下面这些事项。",
          requests: [
            {
              order: 1,
              request_type: "physical_state",
              check_name: "no_attached_tip_before_liquid_probe_rerun",
              prompt: "Please clear or confirm the left attached-tip state.",
              prompt_zh: "请先清除或确认左侧移液器仍挂着的枪头状态。",
            },
            {
              order: 2,
              request_type: "liquid_identity",
              check_name: "source_identity_metadata",
              prompt: "Please fill exact liquid_name and sample_id.",
              prompt_zh: "请补全具体 liquid_name 与 sample_id。",
              inputs_needed: [
                {
                  key: "C3.A1",
                  slot_name: "C3",
                  well_name: "A1",
                  current_liquid_name: "operator-confirmed-liquid",
                  current_sample_id: null,
                  missing_identity_fields: ["specific_liquid_name", "sample_id"],
                },
              ],
            },
          ],
        },
        resolution_plan: [
          {
            order: 1,
            check_name: "no_attached_tip_before_liquid_probe_rerun",
            severity: "blocker",
            action: "clear_attached_tip_before_liquid_rerun",
            human_required: true,
            no_robot_motion: true,
            allowed_next_tools: ["robot_status", "live_liquid_recovery_gate", "experiment_history"],
            acceptance_criteria: ["robot_status reports no pipette with tip_detected=true."],
          },
        ],
      },
    });

    const review = await TOOL_HANDLERS.restart_review({
      session_id: "resolution-session",
      limit: 5,
    });
    assert.equal(review.data.guidance.latest_resolution_plan.length, 1);
    assert.equal(
      review.data.guidance.latest_resolution_plan[0].action,
      "clear_attached_tip_before_liquid_rerun",
    );
    assert.equal(review.data.guidance.latest_resolution_plan_source.entry_id, entry.entry_id);
    assert.equal(review.data.guidance.latest_operator_request.request_count, 1);
    assert.equal(review.data.guidance.latest_operator_request_source.entry_id, entry.entry_id);
    assert.equal(
      review.data.guidance.latest_operator_request_source.operator_request_md_path,
      "/tmp/live-liquid-operator-request.md",
    );

    const safe = await TOOL_HANDLERS.safe_next_action({
      session_id: "resolution-session",
      limit: 5,
    });
    assert.equal(safe.data.safe_next_action.recommended_next_tool, "robot_status");
    assert.equal(
      safe.data.safe_next_action.latest_resolution_plan[0].check_name,
      "no_attached_tip_before_liquid_probe_rerun",
    );
    assert.equal(safe.data.safe_next_action.latest_operator_request.requests[0].request_type, "physical_state");
    assert.equal(
      safe.data.safe_next_action.latest_operator_request_artifacts.markdown_path,
      "/tmp/live-liquid-operator-request.md",
    );
    assert.match(safe.data.safe_next_action.rationale_zh, /resolution_plan/);
    assert.equal(safe.data.safe_next_action.liquid_identity_inputs_needed_summary.count, 1);
    assert.deepEqual(safe.data.safe_next_action.liquid_identity_inputs_needed_summary.keys, ["C3.A1"]);
    assert.ok(
      safe.data.safe_next_action.operator_steps.some(step =>
        step.includes("clear_attached_tip_before_liquid_rerun"),
      ),
    );
    assert.ok(
      safe.data.safe_next_action.operator_steps_zh.some(step => step.includes("中文交接单")),
    );
    assert.ok(
      safe.data.safe_next_action.operator_steps_zh.some(step => step.includes("C3.A1")),
    );
    assert.ok(
      safe.data.safe_next_action.operator_steps.some(step =>
        step.includes("/tmp/live-liquid-operator-request.md"),
      ),
    );
    assert.ok(
      safe.data.safe_next_action.operator_steps.some(step => step.includes("Do not run robot motion")),
    );
  } finally {
    if (originalSessionDir === undefined) {
      delete process.env.OPENTRONS_SESSION_STATE_DIR;
    } else {
      process.env.OPENTRONS_SESSION_STATE_DIR = originalSessionDir;
    }
    if (originalLogDir === undefined) {
      delete process.env.OPENTRONS_RESULT_LOG_DIR;
    } else {
      process.env.OPENTRONS_RESULT_LOG_DIR = originalLogDir;
    }
  }
});

test("restart_review and safe_next_action surface prepared liquid source-substitution recovery", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "opentrons-restart-liquid-recovery-"));
  const sessionDir = path.join(tempDir, "session-state");
  const logDir = path.join(tempDir, "result-logs");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });

  const originalSessionDir = process.env.OPENTRONS_SESSION_STATE_DIR;
  const originalLogDir = process.env.OPENTRONS_RESULT_LOG_DIR;

  process.env.OPENTRONS_SESSION_STATE_DIR = sessionDir;
  process.env.OPENTRONS_RESULT_LOG_DIR = logDir;

  try {
    writeSessionState({
      session_id: "liquid-recovery-session",
      needs_reconciliation: false,
      state_revision: 1,
      deck: { slots: {} },
      cleanup: { pending_actions: [] },
    });

    const entry = appendResultLogEntry({
      session_id: "liquid-recovery-session",
      run_id: null,
      tool_name: "prepare_liquid_source_substitution_recovery",
      event_kind: "liquid_source_substitution_recovery_bundle",
      status: "prepared",
      summary: "Prepared D3.A1 to C3.A1 liquid source substitution recovery.",
      data: {
        output_path: "/tmp/liquid-source-substitution-recovery-bundle.json",
        generated_protocol_path: "/tmp/liquid-source-substitution-recovery-validation.py",
        playbook: "liquid_source_substitution_continuation_protocol",
        failed_source_key: "D3.A1",
        selected_source_key: "C3.A1",
        fixed_script_prepared: true,
        no_robot_motion: true,
        no_aspirate_or_dispense: true,
        simulation_status: "passed",
        simulation_issue_count: 0,
        auto_resume_eligible: false,
        live_execution_allowed: false,
        live_protocol_run_allowed: false,
        next_tool: "live_liquid_recovery_gate",
        blocked_reason: "live_gate_and_operator_opt_in_required_before_any_robot_motion",
        required_next_gates: [
          "live_liquid_recovery_gate",
          "run_protocol_only_after_operator_opt_in",
        ],
      },
    });

    const review = await TOOL_HANDLERS.restart_review({
      session_id: "liquid-recovery-session",
      limit: 5,
    });
    const recovery = review.data.guidance.latest_liquid_source_substitution_recovery;
    assert.equal(recovery.failed_source_key, "D3.A1");
    assert.equal(recovery.selected_source_key, "C3.A1");
    assert.equal(recovery.fixed_script_prepared, true);
    assert.equal(recovery.simulation_status, "passed");
    assert.equal(recovery.auto_resume_eligible, false);
    assert.equal(recovery.live_execution_allowed, false);
    assert.equal(
      review.data.guidance.latest_liquid_source_substitution_recovery_source.entry_id,
      entry.entry_id,
    );

    const safe = await TOOL_HANDLERS.safe_next_action({
      session_id: "liquid-recovery-session",
      limit: 5,
    });
    assert.equal(
      safe.data.safe_next_action.latest_liquid_source_substitution_recovery.selected_source_key,
      "C3.A1",
    );
    assert.equal(
      safe.data.safe_next_action.latest_liquid_source_substitution_recovery_source.output_path,
      "/tmp/liquid-source-substitution-recovery-bundle.json",
    );
    assert.ok(
      safe.data.safe_next_action.operator_steps.some(step =>
        step.includes("Liquid source-substitution recovery is prepared: D3.A1 -> C3.A1"),
      ),
    );
    assert.ok(
      safe.data.safe_next_action.operator_steps_zh.some(step =>
        step.includes("液体换源固定恢复包已准备：D3.A1 -> C3.A1"),
      ),
    );
    assert.ok(
      safe.data.safe_next_action.operator_steps.some(step =>
        step.includes("Do not auto-resume this liquid recovery"),
      ),
    );
  } finally {
    if (originalSessionDir === undefined) {
      delete process.env.OPENTRONS_SESSION_STATE_DIR;
    } else {
      process.env.OPENTRONS_SESSION_STATE_DIR = originalSessionDir;
    }
    if (originalLogDir === undefined) {
      delete process.env.OPENTRONS_RESULT_LOG_DIR;
    } else {
      process.env.OPENTRONS_RESULT_LOG_DIR = originalLogDir;
    }
  }
});

test("restart_review with tip on pipette warns in narrative despite succeeded log line", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "opentrons-restart-home-block-"));
  const sessionDir = path.join(tempDir, "session-state");
  const logDir = path.join(tempDir, "result-logs");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });

  const originalSessionDir = process.env.OPENTRONS_SESSION_STATE_DIR;
  const originalLogDir = process.env.OPENTRONS_RESULT_LOG_DIR;
  const originalFetch = global.fetch;

  process.env.OPENTRONS_SESSION_STATE_DIR = sessionDir;
  process.env.OPENTRONS_RESULT_LOG_DIR = logDir;

  writeSessionState({
    session_id: "home-block",
    needs_reconciliation: false,
    state_revision: 1,
    last_run_id: "run-z",
    deck: { slots: {} },
    cleanup: { pending_actions: [] },
  });

  appendResultLogEntry({
    session_id: "home-block",
    run_id: "run-z",
    tool_name: "run_protocol",
    event_kind: "protocol_run",
    status: "succeeded",
    summary: "Looks successful in audit log",
  });

  global.fetch = async (url, options = {}) => {
    const requestUrl = new URL(url);
    if ((options.method || "GET") === "GET" && requestUrl.pathname === "/health") {
      return jsonResponse({
        name: "Flex",
        robot_model: "OT-3 Standard",
        robot_serial: "home-block",
      });
    }
    if ((options.method || "GET") === "GET" && requestUrl.pathname === "/instruments") {
      return jsonResponse({
        data: [
          {
            mount: "left",
            instrumentName: "p1000_single_flex",
            ok: true,
            state: { tipDetected: true },
          },
        ],
      });
    }
    if ((options.method || "GET") === "GET" && requestUrl.pathname === "/robot/door/status") {
      return jsonResponse({ data: { status: "closed" } });
    }
    if ((options.method || "GET") === "GET" && requestUrl.pathname === "/robot/control/estopStatus") {
      return jsonResponse({ data: { status: "disengaged" } });
    }
    if ((options.method || "GET") === "GET" && requestUrl.pathname === "/deck_configuration") {
      return jsonResponse({ data: { cutoutFixtures: [] } });
    }
    throw new Error(`Unexpected request: ${requestUrl.pathname}`);
  };

  try {
    const result = await TOOL_HANDLERS.restart_review({
      robot_ip: "10.0.0.2:31950",
      session_id: "home-block",
      limit: 5,
    });

    assert.equal(result.data.guidance.home_safety_preview?.auto_home_allowed, false);
    assert.match(result.data.guidance.narrative, /Live home-safety preview disallows auto-home/i);
    assert.equal(result.data.recent_log_entries[0].status, "succeeded");
  } finally {
    global.fetch = originalFetch;
    if (originalSessionDir === undefined) {
      delete process.env.OPENTRONS_SESSION_STATE_DIR;
    } else {
      process.env.OPENTRONS_SESSION_STATE_DIR = originalSessionDir;
    }
    if (originalLogDir === undefined) {
      delete process.env.OPENTRONS_RESULT_LOG_DIR;
    } else {
      process.env.OPENTRONS_RESULT_LOG_DIR = originalLogDir;
    }
  }
});

test("safe_next_action with robot_ip preserves live blocker and liquid handoff context", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "opentrons-safe-next-live-liquid-"));
  const sessionDir = path.join(tempDir, "session-state");
  const logDir = path.join(tempDir, "result-logs");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });

  const originalSessionDir = process.env.OPENTRONS_SESSION_STATE_DIR;
  const originalLogDir = process.env.OPENTRONS_RESULT_LOG_DIR;
  const originalFetch = global.fetch;

  process.env.OPENTRONS_SESSION_STATE_DIR = sessionDir;
  process.env.OPENTRONS_RESULT_LOG_DIR = logDir;

  writeSessionState({
    session_id: "safe-live-liquid",
    needs_reconciliation: false,
    state_revision: 1,
    deck: { slots: {} },
    cleanup: { pending_actions: [] },
  });

  appendResultLogEntry({
    session_id: "safe-live-liquid",
    run_id: null,
    tool_name: "live_liquid_recovery_gate_cli",
    event_kind: "live_readiness",
    status: "blocked",
    summary: "Live liquid gate blocked.",
    data: {
      output_path: "/tmp/live-liquid-gate.json",
      operator_request_json_path: "/tmp/live-liquid-operator-request.json",
      operator_request_md_path: "/tmp/live-liquid-operator-request.md",
      resolution_plan: [
        {
          order: 1,
          no_robot_motion: true,
          check_name: "no_attached_tip_before_liquid_probe_rerun",
          severity: "blocker",
          action: "clear_attached_tip_before_liquid_rerun",
          human_required: true,
          allowed_next_tools: ["robot_status", "live_liquid_recovery_gate", "experiment_history"],
          acceptance_criteria: ["robot_status reports no pipette with tip_detected=true."],
        },
      ],
      operator_request: {
        human_required: true,
        request_count: 2,
        summary_zh: "继续真机液体 watcher/probe 测试前，需要人先处理下面这些事项。",
        requests: [
          {
            order: 1,
            request_type: "physical_state",
            check_name: "no_attached_tip_before_liquid_probe_rerun",
            prompt_zh: "请先清除或确认左侧移液器仍挂着的枪头状态。",
          },
          {
            order: 2,
            request_type: "liquid_identity",
            check_name: "source_identity_metadata",
            prompt_zh: "请补全具体 liquid_name 与 sample_id。",
            inputs_needed: [
              {
                key: "C3.A1",
                slot_name: "C3",
                well_name: "A1",
                current_liquid_name: "operator-confirmed-liquid",
                current_sample_id: null,
                missing_identity_fields: ["specific_liquid_name", "sample_id"],
              },
              {
                key: "D3.A1",
                slot_name: "D3",
                well_name: "A1",
                current_liquid_name: "operator-confirmed-liquid",
                current_sample_id: null,
                missing_identity_fields: ["specific_liquid_name", "sample_id"],
              },
            ],
          },
        ],
      },
    },
  });

  global.fetch = async (url, options = {}) => {
    const requestUrl = new URL(url);
    if ((options.method || "GET") === "GET" && requestUrl.pathname === "/health") {
      return jsonResponse({
        name: "Flex",
        robot_model: "OT-3 Standard",
        robot_serial: "safe-live-liquid",
      });
    }
    if ((options.method || "GET") === "GET" && requestUrl.pathname === "/instruments") {
      return jsonResponse({
        data: [
          {
            mount: "left",
            instrumentName: "p1000_single_flex",
            ok: true,
            state: { tipDetected: true },
          },
        ],
      });
    }
    if ((options.method || "GET") === "GET" && requestUrl.pathname === "/robot/door/status") {
      return jsonResponse({ data: { status: "closed" } });
    }
    if ((options.method || "GET") === "GET" && requestUrl.pathname === "/robot/control/estopStatus") {
      return jsonResponse({ data: { status: "disengaged" } });
    }
    if ((options.method || "GET") === "GET" && requestUrl.pathname === "/deck_configuration") {
      return jsonResponse({ data: { cutoutFixtures: [] } });
    }
    throw new Error(`Unexpected request: ${requestUrl.pathname}`);
  };

  try {
    const result = await TOOL_HANDLERS.safe_next_action({
      robot_ip: "10.0.0.3:31950",
      session_id: "safe-live-liquid",
      limit: 5,
    });

    const safe = result.data.safe_next_action;
    assert.equal(safe.recommended_next_tool, "robot_status");
    assert.equal(safe.home_action_required, true);
    assert.deepEqual(safe.home_blockers, ["tip_attached:left"]);
    assert.equal(safe.latest_resolution_plan[0].action, "clear_attached_tip_before_liquid_rerun");
    assert.equal(safe.latest_operator_request_artifacts.markdown_path, "/tmp/live-liquid-operator-request.md");
    assert.equal(safe.liquid_identity_inputs_needed_summary.count, 2);
    assert.deepEqual(safe.liquid_identity_inputs_needed_summary.keys, ["C3.A1", "D3.A1"]);
    assert.match(safe.rationale_zh, /resolution_plan/);
    assert.ok(safe.operator_steps_zh.some(step => step.includes("C3.A1")));
    assert.ok(safe.operator_steps_zh.some(step => step.includes("现在不要 home")));
  } finally {
    global.fetch = originalFetch;
    if (originalSessionDir === undefined) {
      delete process.env.OPENTRONS_SESSION_STATE_DIR;
    } else {
      process.env.OPENTRONS_SESSION_STATE_DIR = originalSessionDir;
    }
    if (originalLogDir === undefined) {
      delete process.env.OPENTRONS_RESULT_LOG_DIR;
    } else {
      process.env.OPENTRONS_RESULT_LOG_DIR = originalLogDir;
    }
  }
});

test("restart_review merges session file and result logs without robot_ip", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "opentrons-restart-review-"));
  const sessionDir = path.join(tempDir, "session-state");
  const logDir = path.join(tempDir, "result-logs");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });

  const originalSessionDir = process.env.OPENTRONS_SESSION_STATE_DIR;
  const originalLogDir = process.env.OPENTRONS_RESULT_LOG_DIR;

  process.env.OPENTRONS_SESSION_STATE_DIR = sessionDir;
  process.env.OPENTRONS_RESULT_LOG_DIR = logDir;

  try {
    writeSessionState({
      session_id: "rr-session",
      needs_reconciliation: true,
      state_revision: 5,
      last_run_id: "run-99",
      deck: { slots: {} },
    });

    appendResultLogEntry({
      session_id: "rr-session",
      run_id: "run-99",
      tool_name: "run_protocol",
      event_kind: "protocol_run",
      status: "succeeded",
      summary: "Past success",
    });

    const result = await TOOL_HANDLERS.restart_review({
      session_id: "rr-session",
      limit: 10,
    });

    assert.equal(result.data.session_summary.needs_reconciliation, true);
    assert.equal(result.data.guidance.reconcile_first, true);
    assert.equal(result.data.recent_log_entries.length, 1);
    assert.equal(result.data.recent_log_entries[0].tool_name, "run_protocol");
    assert.equal(result.sessionId, "rr-session");
  } finally {
    if (originalSessionDir === undefined) {
      delete process.env.OPENTRONS_SESSION_STATE_DIR;
    } else {
      process.env.OPENTRONS_SESSION_STATE_DIR = originalSessionDir;
    }
    if (originalLogDir === undefined) {
      delete process.env.OPENTRONS_RESULT_LOG_DIR;
    } else {
      process.env.OPENTRONS_RESULT_LOG_DIR = originalLogDir;
    }
  }
});

test("restart_review with robot_ip includes home_safety_preview", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "opentrons-restart-review-live-"));
  const sessionDir = path.join(tempDir, "session-state");
  const logDir = path.join(tempDir, "result-logs");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });

  const originalSessionDir = process.env.OPENTRONS_SESSION_STATE_DIR;
  const originalLogDir = process.env.OPENTRONS_RESULT_LOG_DIR;
  const originalFetch = global.fetch;

  process.env.OPENTRONS_SESSION_STATE_DIR = sessionDir;
  process.env.OPENTRONS_RESULT_LOG_DIR = logDir;

  writeSessionState({
    session_id: "rr-live",
    needs_reconciliation: false,
    state_revision: 1,
    deck: { slots: {} },
    cleanup: { pending_actions: [] },
  });

  global.fetch = async (url, options = {}) => {
    const requestUrl = new URL(url);
    if ((options.method || "GET") === "GET" && requestUrl.pathname === "/health") {
      return jsonResponse({
        name: "Flex",
        robot_model: "OT-3 Standard",
        robot_serial: "rr-live",
      });
    }
    if ((options.method || "GET") === "GET" && requestUrl.pathname === "/instruments") {
      return jsonResponse({
        data: [{ mount: "left", instrumentName: "p1000_single_flex", ok: true, state: { tipDetected: false } }],
      });
    }
    if ((options.method || "GET") === "GET" && requestUrl.pathname === "/robot/door/status") {
      return jsonResponse({ data: { status: "closed" } });
    }
    if ((options.method || "GET") === "GET" && requestUrl.pathname === "/robot/control/estopStatus") {
      return jsonResponse({ data: { status: "disengaged" } });
    }
    if ((options.method || "GET") === "GET" && requestUrl.pathname === "/deck_configuration") {
      return jsonResponse({ data: { cutoutFixtures: [] } });
    }
    throw new Error(`Unexpected request: ${requestUrl.pathname}`);
  };

  try {
    const result = await TOOL_HANDLERS.restart_review({
      robot_ip: "10.0.0.1:31950",
      session_id: "rr-live",
      limit: 5,
    });

    assert.equal(result.sessionId, "rr-live");
    assert.equal(result.data.guidance.reconcile_first, false);
    assert.equal(result.data.guidance.home_safety_preview?.auto_home_allowed, true);
  } finally {
    global.fetch = originalFetch;
    if (originalSessionDir === undefined) {
      delete process.env.OPENTRONS_SESSION_STATE_DIR;
    } else {
      process.env.OPENTRONS_SESSION_STATE_DIR = originalSessionDir;
    }
    if (originalLogDir === undefined) {
      delete process.env.OPENTRONS_RESULT_LOG_DIR;
    } else {
      process.env.OPENTRONS_RESULT_LOG_DIR = originalLogDir;
    }
  }
});
