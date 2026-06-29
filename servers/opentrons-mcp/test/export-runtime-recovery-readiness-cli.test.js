import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "..", "..", "..");
const CLI_PATH = path.join(PLUGIN_ROOT, "scripts", "export-runtime-recovery-readiness.mjs");

function runNodeSnippet(source, env) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: PLUGIN_ROOT,
    env: {
      ...process.env,
      ...env,
    },
    encoding: "utf8",
    timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function runCli(args, env) {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: PLUGIN_ROOT,
    env: {
      ...process.env,
      ...env,
    },
    encoding: "utf8",
    timeout: 15000,
  });
  const stdoutJson = result.stdout ? JSON.parse(result.stdout) : null;
  return { ...result, stdoutJson };
}

test("export-runtime-recovery-readiness CLI writes a blocked readiness bundle", () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "readiness-cli-session-"));
  const resultLogDir = fs.mkdtempSync(path.join(os.tmpdir(), "readiness-cli-log-"));
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "readiness-cli-artifacts-"));
  const sessionId = "readiness-cli-test";
  const gatePath = path.join(artifactDir, "gate.json");
  const realMachinePath = path.join(artifactDir, "real-machine.json");
  const validationBundlePath = path.join(artifactDir, "validation-bundle.json");
  const recoveryBundlePath = path.join(artifactDir, "recovery-bundle.json");
  const outPath = path.join(artifactDir, "readiness.json");
  const markdownPath = path.join(artifactDir, "readiness.md");
  const env = {
    OPENTRONS_SESSION_STATE_DIR: sessionDir,
    OPENTRONS_RESULT_LOG_DIR: resultLogDir,
    OPENTRONS_SKIP_MCP_PROCESS_SCAN: "1",
  };

  fs.writeFileSync(gatePath, `${JSON.stringify({
    status: "blocked",
    ok_for_live_liquid_rerun: false,
    result_log_entry_id: "gate-entry-1",
    failed_checks: ["no_attached_tip_before_liquid_probe_rerun"],
    warning_checks: ["source_identity_metadata"],
    manual_gates: ["mcp_client_reload"],
    recommended_next_action: "clear_attached_tip_before_liquid_rerun",
    resolution_plan: [
      {
        order: 1,
        check_name: "no_attached_tip_before_liquid_probe_rerun",
        action: "clear_attached_tip_before_liquid_rerun",
        no_robot_motion: true,
        human_required: true,
      },
    ],
    operator_request: { request_count: 3 },
  }, null, 2)}\n`);

  fs.writeFileSync(realMachinePath, `${JSON.stringify({
    status: "blocked",
    result_log_entry_id: "real-machine-entry-1",
    summary: {
      robot_reachable: true,
      robot_name: "Silabrobot001",
      api_version: "9.0.0",
      door_status: "closed",
      estop_status: "disengaged",
      attached_tip_mounts: ["left"],
      blockers: ["attached_tip:left"],
      live_liquid_motion_allowed: false,
      no_robot_motion: true,
    },
  }, null, 2)}\n`);

  fs.writeFileSync(validationBundlePath, `${JSON.stringify({
    status: "passed",
    result_log_entry_id: "validation-entry-1",
    failed_source_key: "D3.A1",
    selected_source_key: "C3.A1",
    generated_protocol_path: "/tmp/liquid-source-substitution-validation.py",
    no_robot_motion: true,
    simulation: {
      parsed: {
        status: "passed",
        issue_count: 0,
      },
    },
    decision: {
      validation_passed: true,
      auto_resume_eligible: false,
      live_execution_allowed: false,
      live_protocol_run_allowed: false,
      no_robot_motion: true,
      next_tool: "live_liquid_recovery_gate",
      blocked_reason: "live_gate_and_operator_opt_in_required_before_any_robot_motion",
    },
    liquid_guard_analysis: {
      status: "pass",
      first_aspirate_guarded: true,
      no_aspirate_or_dispense: true,
    },
  }, null, 2)}\n`);

  fs.writeFileSync(recoveryBundlePath, `${JSON.stringify({
    status: "prepared",
    result_log_entry_id: "recovery-entry-1",
    playbook: "liquid_source_substitution_continuation_protocol",
    failed_source_key: "D3.A1",
    selected_source_key: "C3.A1",
    generated_protocol_path: "/tmp/liquid-source-substitution-recovery-validation.py",
    no_robot_motion: true,
    simulation: {
      status: "passed",
      issue_count: 0,
    },
    validation_protocol: {
      liquid_guard_analysis: {
        status: "pass",
        first_aspirate_guarded: true,
        no_aspirate_or_dispense: true,
      },
    },
    execution: {
      fixed_script_prepared: true,
      auto_resume_eligible: false,
      live_execution_allowed: false,
      live_protocol_run_allowed: false,
      next_tool: "live_liquid_recovery_gate",
      blocked_reason: "live_gate_and_operator_opt_in_required_before_any_robot_motion",
    },
  }, null, 2)}\n`);

  runNodeSnippet(`
    import { writeSessionState } from "./servers/opentrons-mcp/lib/state.js";
    import { appendResultLogEntry } from "./servers/opentrons-mcp/lib/result-log.js";
    writeSessionState({
      session_id: "${sessionId}",
      needs_reconciliation: false,
      state_revision: 1,
      deck: { slots: {} },
      cleanup: { pending_actions: [] },
    });
    appendResultLogEntry({
      session_id: "${sessionId}",
      run_id: null,
      tool_name: "live_liquid_recovery_gate_cli",
      event_kind: "live_readiness",
      status: "blocked",
      summary: "Gate blocked for readiness test.",
      data: {
        output_path: "${gatePath}",
        operator_request_md_path: "/tmp/operator-request.md",
        resolution_plan: [
          {
            order: 1,
            check_name: "no_attached_tip_before_liquid_probe_rerun",
            action: "clear_attached_tip_before_liquid_rerun",
            human_required: true,
            no_robot_motion: true,
            allowed_next_tools: ["robot_status"],
            acceptance_criteria: ["robot_status reports no pipette with tip_detected=true."],
          },
        ],
        operator_request: {
          human_required: true,
          request_count: 2,
          requests: [
            { request_type: "physical_state", check_name: "no_attached_tip_before_liquid_probe_rerun" },
            {
              request_type: "liquid_identity",
              check_name: "source_identity_metadata",
              inputs_needed: [
                {
                  key: "C3.A1",
                  slot_name: "C3",
                  well_name: "A1",
                  missing_identity_fields: ["specific_liquid_name", "sample_id"],
                },
              ],
            },
          ],
        },
      },
    });
  `, env);

  const result = runCli([
    "--session-id",
    sessionId,
    "--gate-artifact",
    gatePath,
    "--real-machine-artifact",
    realMachinePath,
    "--validation-bundle-artifact",
    validationBundlePath,
    "--recovery-bundle-artifact",
    recoveryBundlePath,
    "--out",
    outPath,
    "--markdown-out",
    markdownPath,
  ], env);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdoutJson.status, "blocked");
  assert.equal(result.stdoutJson.decision.live_liquid_tests_allowed, false);
  assert.equal(result.stdoutJson.decision.next_tool, "reload_mcp_client");
  assert.equal(result.stdoutJson.summary.no_robot_motion, true);
  assert.equal(result.stdoutJson.mcp_process.running, false);

  const artifact = JSON.parse(fs.readFileSync(outPath, "utf8"));
  assert.equal(artifact.gate.result_log_entry_id, "gate-entry-1");
  assert.equal(artifact.gate.attached_tip_blocked, true);
  assert.equal(artifact.gate.mcp_reload_required, true);
  assert.equal(artifact.real_machine.result_log_entry_id, "real-machine-entry-1");
  assert.deepEqual(artifact.real_machine.blockers, ["attached_tip:left"]);
  assert.equal(artifact.real_machine.live_liquid_motion_allowed, false);
  assert.equal(artifact.validation_bundle.result_log_entry_id, "validation-entry-1");
  assert.equal(artifact.validation_bundle.failed_source_key, "D3.A1");
  assert.equal(artifact.validation_bundle.selected_source_key, "C3.A1");
  assert.equal(artifact.validation_bundle.simulation_status, "passed");
  assert.equal(artifact.validation_bundle.simulation_issue_count, 0);
  assert.equal(artifact.validation_bundle.auto_resume_eligible, false);
  assert.equal(artifact.validation_bundle.live_execution_allowed, false);
  assert.equal(artifact.validation_bundle.liquid_guard_status, "pass");
  assert.equal(artifact.validation_bundle.liquid_guard_first_aspirate_guarded, true);
  assert.equal(artifact.validation_bundle.liquid_guard_no_aspirate_or_dispense, true);
  assert.equal(artifact.recovery_bundle.result_log_entry_id, "recovery-entry-1");
  assert.equal(artifact.recovery_bundle.playbook, "liquid_source_substitution_continuation_protocol");
  assert.equal(artifact.recovery_bundle.fixed_script_prepared, true);
  assert.equal(artifact.recovery_bundle.simulation_status, "passed");
  assert.equal(artifact.recovery_bundle.auto_resume_eligible, false);
  assert.equal(artifact.recovery_bundle.live_execution_allowed, false);
  assert.equal(artifact.recovery_bundle.liquid_guard_status, "pass");
  assert.equal(artifact.recovery_bundle.liquid_guard_first_aspirate_guarded, true);
  assert.equal(artifact.recovery_bundle.liquid_guard_no_aspirate_or_dispense, true);
  assert.equal(artifact.safe_next.liquid_identity_inputs_needed_count, 1);
  assert.deepEqual(artifact.safe_next.liquid_identity_input_keys, ["C3.A1"]);
  assert.equal(artifact.mcp_process.running, false);
  assert.equal(artifact.result_log_entry_id, result.stdoutJson.result_log_entry_id);

  const markdown = fs.readFileSync(markdownPath, "utf8");
  assert.match(markdown, /Runtime Recovery Readiness/);
  assert.match(markdown, /Live liquid tests allowed: `false`/);
  assert.match(markdown, /MCP process running: `false`/);
  assert.match(markdown, /attached_tip:left/);
  assert.match(markdown, /Liquid substitution validation: `passed`/);
  assert.match(markdown, /Liquid substitution selected source: `C3\.A1`/);
  assert.match(markdown, /Liquid substitution guard: `pass`/);
  assert.match(markdown, /Liquid recovery playbook: `liquid_source_substitution_continuation_protocol`/);
  assert.match(markdown, /Liquid recovery prepared: `true`/);
  assert.match(markdown, /Liquid recovery guard: `pass`/);
  assert.match(markdown, /C3\.A1/);

  runNodeSnippet(`
    import { TOOL_HANDLERS } from "./servers/opentrons-mcp/index.js";
    const history = await TOOL_HANDLERS.experiment_history({
      session_id: "${sessionId}",
      tool_name: "runtime_recovery_readiness_cli",
      event_kind: "readiness_bundle",
      limit: 1,
    });
    const entry = history.data.entries[0];
    if (!entry || entry.entry_id !== "${result.stdoutJson.result_log_entry_id}") {
      throw new Error("Expected readiness_bundle result log entry was not found.");
    }
    if (entry.data.decision.live_liquid_tests_allowed !== false) {
      throw new Error("Expected blocked readiness decision in result log.");
    }
    if (entry.data.real_machine.blockers[0] !== "attached_tip:left") {
      throw new Error("Expected real-machine blocker in result log.");
    }
    if (entry.data.validation_bundle.selected_source_key !== "C3.A1") {
      throw new Error("Expected liquid substitution validation bundle in result log.");
    }
    if (entry.data.validation_bundle.auto_resume_eligible !== false) {
      throw new Error("Expected liquid substitution bundle to keep live execution blocked.");
    }
    if (entry.data.recovery_bundle.fixed_script_prepared !== true) {
      throw new Error("Expected liquid substitution recovery bundle in result log.");
    }
  `, env);
});

test("export-runtime-recovery-readiness prioritizes source-map blockers over MCP reload", () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "readiness-cli-source-map-session-"));
  const resultLogDir = fs.mkdtempSync(path.join(os.tmpdir(), "readiness-cli-source-map-log-"));
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "readiness-cli-source-map-artifacts-"));
  const sessionId = "readiness-cli-source-map-test";
  const gatePath = path.join(artifactDir, "gate.json");
  const realMachinePath = path.join(artifactDir, "real-machine.json");
  const outPath = path.join(artifactDir, "readiness.json");
  const env = {
    OPENTRONS_SESSION_STATE_DIR: sessionDir,
    OPENTRONS_RESULT_LOG_DIR: resultLogDir,
    OPENTRONS_SKIP_MCP_PROCESS_SCAN: "1",
  };

  fs.writeFileSync(gatePath, `${JSON.stringify({
    status: "blocked",
    ok_for_live_liquid_rerun: false,
    failed_checks: ["source_map_requirements"],
    warning_checks: [],
    manual_gates: ["mcp_client_reload"],
    recommended_next_action: "record_or_correct_liquid_source_map",
    checks: [
      {
        name: "source_map_requirements",
        status: "fail",
        observed_presence_mismatch_keys: ["D3.H1"],
      },
    ],
  }, null, 2)}\n`);

  fs.writeFileSync(realMachinePath, `${JSON.stringify({
    status: "pass",
    summary: {
      robot_reachable: true,
      blockers: [],
      live_liquid_motion_allowed: true,
      no_robot_motion: true,
    },
  }, null, 2)}\n`);

  runNodeSnippet(`
    import { writeSessionState } from "./servers/opentrons-mcp/lib/state.js";
    writeSessionState({
      session_id: "${sessionId}",
      needs_reconciliation: false,
      state_revision: 1,
      deck: { slots: {} },
      cleanup: { pending_actions: [] },
    });
  `, env);

  const result = runCli([
    "--session-id",
    sessionId,
    "--gate-artifact",
    gatePath,
    "--real-machine-artifact",
    realMachinePath,
    "--out",
    outPath,
  ], env);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdoutJson.status, "blocked");
  assert.equal(result.stdoutJson.decision.next_tool, "record_liquid_source_map");
  assert.match(result.stdoutJson.decision.reason_zh, /source map/);
  const artifact = JSON.parse(fs.readFileSync(outPath, "utf8"));
  assert.deepEqual(artifact.gate.failed_checks, ["source_map_requirements"]);
  assert.equal(artifact.mcp_process.running, false);
});

test("export-runtime-recovery-readiness blocks unsafe validation bundles that claim live execution", () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "readiness-cli-session-"));
  const resultLogDir = fs.mkdtempSync(path.join(os.tmpdir(), "readiness-cli-log-"));
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "readiness-cli-artifacts-"));
  const sessionId = "readiness-cli-unsafe-bundle-test";
  const gatePath = path.join(artifactDir, "gate.json");
  const realMachinePath = path.join(artifactDir, "real-machine.json");
  const validationBundlePath = path.join(artifactDir, "validation-bundle.json");
  const outPath = path.join(artifactDir, "readiness.json");
  const env = {
    OPENTRONS_SESSION_STATE_DIR: sessionDir,
    OPENTRONS_RESULT_LOG_DIR: resultLogDir,
    OPENTRONS_SKIP_MCP_PROCESS_SCAN: "1",
  };

  fs.writeFileSync(gatePath, `${JSON.stringify({
    status: "pass",
    ok_for_live_liquid_rerun: true,
    failed_checks: [],
    warning_checks: [],
    manual_gates: [],
    resolution_plan: [],
  }, null, 2)}\n`);

  fs.writeFileSync(realMachinePath, `${JSON.stringify({
    status: "pass",
    summary: {
      robot_reachable: true,
      blockers: [],
      live_liquid_motion_allowed: true,
      no_robot_motion: false,
    },
  }, null, 2)}\n`);

  fs.writeFileSync(validationBundlePath, `${JSON.stringify({
    status: "passed",
    failed_source_key: "D3.A1",
    selected_source_key: "C3.A1",
    simulation: { parsed: { status: "passed", issue_count: 0 } },
    decision: {
      validation_passed: true,
      auto_resume_eligible: true,
      live_execution_allowed: true,
      live_protocol_run_allowed: true,
    },
  }, null, 2)}\n`);

  runNodeSnippet(`
    import { writeSessionState } from "./servers/opentrons-mcp/lib/state.js";
    writeSessionState({
      session_id: "${sessionId}",
      needs_reconciliation: false,
      state_revision: 1,
      deck: { slots: {} },
      cleanup: { pending_actions: [] },
    });
  `, env);

  const result = runCli([
    "--session-id",
    sessionId,
    "--gate-artifact",
    gatePath,
    "--real-machine-artifact",
    realMachinePath,
    "--validation-bundle-artifact",
    validationBundlePath,
    "--out",
    outPath,
  ], env);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdoutJson.status, "blocked");
  assert.equal(result.stdoutJson.decision.live_liquid_tests_allowed, false);
  assert.equal(result.stdoutJson.decision.next_tool, "validate_liquid_source_substitution");
  assert.match(result.stdoutJson.decision.reason_zh, /直接真机执行/);

  const artifact = JSON.parse(fs.readFileSync(outPath, "utf8"));
  assert.equal(artifact.validation_bundle.auto_resume_eligible, true);
  assert.equal(artifact.validation_bundle.live_execution_allowed, true);
  assert.equal(artifact.validation_bundle.live_protocol_run_allowed, true);
});

test("export-runtime-recovery-readiness ignores node eval imports when detecting MCP server process", () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "readiness-cli-session-"));
  const resultLogDir = fs.mkdtempSync(path.join(os.tmpdir(), "readiness-cli-log-"));
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "readiness-cli-artifacts-"));
  const sessionId = "readiness-cli-process-filter-test";
  const gatePath = path.join(artifactDir, "gate.json");
  const realMachinePath = path.join(artifactDir, "real-machine.json");
  const outPath = path.join(artifactDir, "readiness.json");
  const validationBundlePath = path.join(artifactDir, "missing-validation-bundle.json");
  const recoveryBundlePath = path.join(artifactDir, "missing-recovery-bundle.json");
  const env = {
    OPENTRONS_SESSION_STATE_DIR: sessionDir,
    OPENTRONS_RESULT_LOG_DIR: resultLogDir,
    OPENTRONS_MCP_PROCESS_LIST: [
      "  PID  PPID STARTED                     ELAPSED COMMAND",
      "12345 11111 Tue Jun 23 12:30:00 2026  00:00 node --input-type=module -e import(\"./servers/opentrons-mcp/index.js\")",
      "23456 11111 Tue Jun 23 12:31:00 2026  00:01 /usr/local/bin/node /repo/servers/opentrons-mcp/index.js",
    ].join("\n"),
  };

  fs.writeFileSync(gatePath, `${JSON.stringify({
    status: "pass",
    ok_for_live_liquid_rerun: true,
    failed_checks: [],
    warning_checks: [],
    manual_gates: [],
    recommended_next_action: "run_live_liquid_recovery_tests",
    resolution_plan: [],
  }, null, 2)}\n`);

  fs.writeFileSync(realMachinePath, `${JSON.stringify({
    status: "pass",
    summary: {
      robot_reachable: true,
      blockers: [],
      live_liquid_motion_allowed: true,
      no_robot_motion: false,
    },
  }, null, 2)}\n`);

  runNodeSnippet(`
    import { writeSessionState } from "./servers/opentrons-mcp/lib/state.js";
    writeSessionState({
      session_id: "${sessionId}",
      needs_reconciliation: false,
      state_revision: 1,
      deck: { slots: {} },
      cleanup: { pending_actions: [] },
    });
  `, env);

  const result = runCli([
    "--session-id",
    sessionId,
    "--gate-artifact",
    gatePath,
    "--real-machine-artifact",
    realMachinePath,
    "--validation-bundle-artifact",
    validationBundlePath,
    "--recovery-bundle-artifact",
    recoveryBundlePath,
    "--out",
    outPath,
  ], env);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdoutJson.status, "ready");
  assert.equal(result.stdoutJson.decision.live_liquid_tests_allowed, true);
  assert.equal(result.stdoutJson.mcp_process.running, true);
  assert.equal(result.stdoutJson.mcp_process.count, 1);

  const artifact = JSON.parse(fs.readFileSync(outPath, "utf8"));
  assert.equal(artifact.mcp_process.count, 1);
  assert.match(artifact.mcp_process.processes[0].command, /opentrons-mcp\/index\.js/);
  assert.doesNotMatch(artifact.mcp_process.processes[0].command, /--input-type=module|-e/);
});

test("export-runtime-recovery-readiness blocks unsafe recovery bundles that claim live execution", () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "readiness-cli-session-"));
  const resultLogDir = fs.mkdtempSync(path.join(os.tmpdir(), "readiness-cli-log-"));
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "readiness-cli-artifacts-"));
  const sessionId = "readiness-cli-unsafe-recovery-bundle-test";
  const gatePath = path.join(artifactDir, "gate.json");
  const realMachinePath = path.join(artifactDir, "real-machine.json");
  const validationBundlePath = path.join(artifactDir, "validation-bundle.json");
  const recoveryBundlePath = path.join(artifactDir, "recovery-bundle.json");
  const outPath = path.join(artifactDir, "readiness.json");
  const env = {
    OPENTRONS_SESSION_STATE_DIR: sessionDir,
    OPENTRONS_RESULT_LOG_DIR: resultLogDir,
    OPENTRONS_SKIP_MCP_PROCESS_SCAN: "1",
  };

  fs.writeFileSync(gatePath, `${JSON.stringify({
    status: "pass",
    ok_for_live_liquid_rerun: true,
    failed_checks: [],
    warning_checks: [],
    manual_gates: [],
    resolution_plan: [],
  }, null, 2)}\n`);

  fs.writeFileSync(realMachinePath, `${JSON.stringify({
    status: "pass",
    summary: {
      robot_reachable: true,
      blockers: [],
      live_liquid_motion_allowed: true,
      no_robot_motion: false,
    },
  }, null, 2)}\n`);

  fs.writeFileSync(validationBundlePath, `${JSON.stringify({
    status: "passed",
    failed_source_key: "D3.A1",
    selected_source_key: "C3.A1",
    simulation: { parsed: { status: "passed", issue_count: 0 } },
    decision: {
      validation_passed: true,
      auto_resume_eligible: false,
      live_execution_allowed: false,
      live_protocol_run_allowed: false,
    },
  }, null, 2)}\n`);

  fs.writeFileSync(recoveryBundlePath, `${JSON.stringify({
    status: "prepared",
    playbook: "liquid_source_substitution_continuation_protocol",
    failed_source_key: "D3.A1",
    selected_source_key: "C3.A1",
    simulation: { status: "passed", issue_count: 0 },
    execution: {
      fixed_script_prepared: true,
      auto_resume_eligible: true,
      live_execution_allowed: true,
      live_protocol_run_allowed: true,
    },
  }, null, 2)}\n`);

  runNodeSnippet(`
    import { writeSessionState } from "./servers/opentrons-mcp/lib/state.js";
    writeSessionState({
      session_id: "${sessionId}",
      needs_reconciliation: false,
      state_revision: 1,
      deck: { slots: {} },
      cleanup: { pending_actions: [] },
    });
  `, env);

  const result = runCli([
    "--session-id",
    sessionId,
    "--gate-artifact",
    gatePath,
    "--real-machine-artifact",
    realMachinePath,
    "--validation-bundle-artifact",
    validationBundlePath,
    "--recovery-bundle-artifact",
    recoveryBundlePath,
    "--out",
    outPath,
  ], env);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdoutJson.status, "blocked");
  assert.equal(result.stdoutJson.decision.live_liquid_tests_allowed, false);
  assert.equal(result.stdoutJson.decision.next_tool, "prepare_liquid_source_substitution_recovery");
  assert.match(result.stdoutJson.decision.reason_zh, /直接真机执行/);

  const artifact = JSON.parse(fs.readFileSync(outPath, "utf8"));
  assert.equal(artifact.recovery_bundle.auto_resume_eligible, true);
  assert.equal(artifact.recovery_bundle.live_execution_allowed, true);
  assert.equal(artifact.recovery_bundle.live_protocol_run_allowed, true);
});
