import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "..", "..", "..");
const CLI_PATH = path.join(PLUGIN_ROOT, "scripts", "export-safe-next-action.mjs");

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

test("export-safe-next-action CLI writes artifact and resume_guidance result log", () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "safe-next-cli-session-"));
  const resultLogDir = fs.mkdtempSync(path.join(os.tmpdir(), "safe-next-cli-log-"));
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "safe-next-cli-artifacts-"));
  const sessionId = "safe-next-cli-test";
  const outPath = path.join(artifactDir, "safe-next.json");
  const markdownPath = path.join(artifactDir, "safe-next.md");
  const env = {
    OPENTRONS_SESSION_STATE_DIR: sessionDir,
    OPENTRONS_RESULT_LOG_DIR: resultLogDir,
  };

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
      tool_name: "prepare_liquid_source_substitution_recovery",
      event_kind: "liquid_source_substitution_recovery_bundle",
      status: "prepared",
      summary: "Prepared D3.A1 to C3.A1 liquid recovery.",
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
        required_next_gates: ["live_liquid_recovery_gate", "run_protocol_only_after_operator_opt_in"],
      },
    });
    appendResultLogEntry({
      session_id: "${sessionId}",
      run_id: null,
      tool_name: "live_liquid_recovery_gate_cli",
      event_kind: "live_readiness",
      status: "blocked",
      summary: "Gate blocked for test.",
      data: {
        output_path: "/tmp/live-liquid-gate.json",
        operator_request_json_path: "/tmp/live-liquid-operator-request.json",
        operator_request_md_path: "/tmp/live-liquid-operator-request.md",
        resolution_plan: [
          {
            order: 1,
            check_name: "no_attached_tip_before_liquid_probe_rerun",
            action: "clear_attached_tip_before_liquid_rerun",
            human_required: true,
            no_robot_motion: true,
            allowed_next_tools: ["robot_status", "live_liquid_recovery_gate"],
            acceptance_criteria: ["robot_status reports no pipette with tip_detected=true."],
          },
        ],
        operator_request: {
          human_required: true,
          request_count: 2,
          summary_zh: "继续真机液体 watcher/probe 测试前，需要人先处理下面这些事项。",
          requests: [
            {
              request_type: "physical_state",
              check_name: "no_attached_tip_before_liquid_probe_rerun",
              prompt_zh: "请先清除或确认左侧移液器仍挂着的枪头状态。",
            },
            {
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
  `, env);

  const result = runCli([
    "--session-id",
    sessionId,
    "--limit",
    "5",
    "--out",
    outPath,
    "--markdown-out",
    markdownPath,
  ], env);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdoutJson.status, "needs_attention");
  assert.equal(result.stdoutJson.output_path, outPath);
  assert.equal(result.stdoutJson.markdown_path, markdownPath);
  assert.equal(result.stdoutJson.summary.recommended_next_tool, "robot_status");
  assert.equal(result.stdoutJson.summary.no_robot_motion, true);
  assert.equal(result.stdoutJson.summary.liquid_identity_inputs_needed_count, 2);
  assert.deepEqual(result.stdoutJson.summary.liquid_identity_input_keys, ["C3.A1", "D3.A1"]);
  assert.equal(result.stdoutJson.summary.liquid_source_substitution_recovery_status, "prepared");
  assert.equal(result.stdoutJson.summary.liquid_source_substitution_recovery_prepared, true);
  assert.equal(result.stdoutJson.summary.liquid_source_substitution_recovery_failed_source_key, "D3.A1");
  assert.equal(result.stdoutJson.summary.liquid_source_substitution_recovery_selected_source_key, "C3.A1");
  assert.equal(result.stdoutJson.summary.liquid_source_substitution_recovery_auto_resume_eligible, false);
  assert.equal(result.stdoutJson.summary.liquid_source_substitution_recovery_live_execution_allowed, false);
  assert.match(result.stdoutJson.result_log_entry_id, /^[0-9a-f-]+$/);

  const artifact = JSON.parse(fs.readFileSync(outPath, "utf8"));
  assert.equal(artifact.result_log_entry_id, result.stdoutJson.result_log_entry_id);
  assert.equal(artifact.markdown_path, markdownPath);
  assert.equal(artifact.summary.operator_request_markdown_path, "/tmp/live-liquid-operator-request.md");
  assert.match(artifact.summary.liquid_source_substitution_recovery_entry_id, /^[0-9a-f-]+$/);
  assert.equal(artifact.safe_next_action.latest_liquid_source_substitution_recovery.selected_source_key, "C3.A1");
  assert.equal(artifact.safe_next_action.operator_steps_zh.some(step => step.includes("C3.A1")), true);
  assert.equal(artifact.safe_next_action.operator_steps_zh.some(step => step.includes("液体换源固定恢复包已准备")), true);
  const markdown = fs.readFileSync(markdownPath, "utf8");
  assert.match(markdown, /# Runtime Resume Guidance/);
  assert.match(markdown, /中文下一步/);
  assert.match(markdown, /不要自动 home/);
  assert.match(markdown, /C3\.A1/);
  assert.match(markdown, /D3\.A1/);
  assert.match(markdown, /Liquid recovery prepared: `true`/);
  assert.match(markdown, /Liquid recovery auto resume: `false`/);

  runNodeSnippet(`
    import { TOOL_HANDLERS } from "./servers/opentrons-mcp/index.js";
    const history = await TOOL_HANDLERS.experiment_history({
      session_id: "${sessionId}",
      tool_name: "safe_next_action_cli",
      event_kind: "resume_guidance",
      limit: 1,
    });
    const entry = history.data.entries[0];
    if (!entry || entry.entry_id !== "${result.stdoutJson.result_log_entry_id}") {
      throw new Error("Expected resume_guidance result log entry was not found.");
    }
    if (entry.data.summary.liquid_identity_inputs_needed_count !== 2) {
      throw new Error("Expected liquid identity input summary in result log.");
    }
    if (entry.data.summary.liquid_source_substitution_recovery_prepared !== true) {
      throw new Error("Expected liquid source-substitution recovery summary in result log.");
    }
    if (entry.data.markdown_path !== "${markdownPath}") {
      throw new Error("Expected markdown path in result log.");
    }
  `, env);
});

test("export-safe-next-action marks prepared liquid recovery as needs_attention without operator request", () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "safe-next-cli-session-"));
  const resultLogDir = fs.mkdtempSync(path.join(os.tmpdir(), "safe-next-cli-log-"));
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "safe-next-cli-artifacts-"));
  const sessionId = "safe-next-cli-recovery-only-test";
  const outPath = path.join(artifactDir, "safe-next.json");
  const env = {
    OPENTRONS_SESSION_STATE_DIR: sessionDir,
    OPENTRONS_RESULT_LOG_DIR: resultLogDir,
  };

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
      tool_name: "prepare_liquid_source_substitution_recovery",
      event_kind: "liquid_source_substitution_recovery_bundle",
      status: "prepared",
      summary: "Prepared D3.A1 to C3.A1 liquid recovery.",
      data: {
        output_path: "/tmp/liquid-source-substitution-recovery-bundle.json",
        generated_protocol_path: "/tmp/liquid-source-substitution-recovery-validation.py",
        playbook: "liquid_source_substitution_continuation_protocol",
        failed_source_key: "D3.A1",
        selected_source_key: "C3.A1",
        fixed_script_prepared: true,
        no_robot_motion: true,
        simulation_status: "passed",
        simulation_issue_count: 0,
        auto_resume_eligible: false,
        live_execution_allowed: false,
        live_protocol_run_allowed: false,
        next_tool: "live_liquid_recovery_gate",
      },
    });
  `, env);

  const result = runCli([
    "--session-id",
    sessionId,
    "--limit",
    "5",
    "--out",
    outPath,
  ], env);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdoutJson.status, "needs_attention");
  assert.equal(result.stdoutJson.summary.no_robot_motion, true);
  assert.equal(result.stdoutJson.summary.liquid_source_substitution_recovery_prepared, true);
  assert.equal(result.stdoutJson.summary.liquid_source_substitution_recovery_auto_resume_eligible, false);

  const artifact = JSON.parse(fs.readFileSync(outPath, "utf8"));
  assert.equal(artifact.status, "needs_attention");
  assert.equal(artifact.summary.liquid_source_substitution_recovery_selected_source_key, "C3.A1");
});
