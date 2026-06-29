import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "..", "..", "..");
const CLI_PATH = path.join(PLUGIN_ROOT, "scripts", "export-liquid-failure-replay.mjs");

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

test("export-liquid-failure-replay CLI writes a no-motion fixed-playbook replay", () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "liquid-failure-replay-session-"));
  const resultLogDir = fs.mkdtempSync(path.join(os.tmpdir(), "liquid-failure-replay-log-"));
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "liquid-failure-replay-artifacts-"));
  const sessionId = "liquid-failure-replay-cli-test";
  const outPath = path.join(artifactDir, "replay.json");
  const markdownPath = path.join(artifactDir, "replay.md");
  const env = {
    OPENTRONS_SESSION_STATE_DIR: sessionDir,
    OPENTRONS_RESULT_LOG_DIR: resultLogDir,
  };

  runNodeSnippet(`
    import { TOOL_HANDLERS } from "./servers/opentrons-mcp/index.js";
    await TOOL_HANDLERS.record_liquid_source_map({
      session_id: "${sessionId}",
      sources: [
        {
          slot_name: "D3",
          well_name: "A1",
          labware_load_name: "corning_96_wellplate_360ul_flat",
          liquid_name: "water",
          sample_id: "water-d3-a1",
          expected_presence: true,
        },
        {
          slot_name: "C3",
          well_name: "A1",
          labware_load_name: "nest_12_reservoir_15ml",
          liquid_name: "water",
          sample_id: "water-c3-a1",
          expected_presence: true,
        },
      ],
    });
  `, env);

  const result = runCli([
    "--session-id",
    sessionId,
    "--failed-source-key",
    "D3.A1",
    "--run-id",
    "synthetic-test-run",
    "--attached-tip-mount",
    "left",
    "--out",
    outPath,
    "--markdown-out",
    markdownPath,
  ], env);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdoutJson.status, "passed");
  assert.equal(result.stdoutJson.no_robot_motion, true);
  assert.equal(result.stdoutJson.failed_source_key, "D3.A1");
  assert.equal(result.stdoutJson.summary.action, "manual_only");
  assert.equal(result.stdoutJson.summary.next_tool, "prepare_liquid_source_substitution_recovery");
  assert.equal(result.stdoutJson.summary.playbook, "liquid_source_substitution_continuation_protocol");
  assert.deepEqual(result.stdoutJson.summary.required_gates, [
    "live_liquid_recovery_gate",
    "run_protocol_only_after_operator_opt_in",
  ]);
  assert.equal(result.stdoutJson.summary.same_liquid_source_candidate_count, 1);
  assert.equal(result.stdoutJson.summary.same_liquid_source_candidates[0].source_map_key, "C3.A1");
  assert.equal(result.stdoutJson.summary.same_liquid_auto_resume_eligible, false);
  assert.equal(
    result.stdoutJson.summary.same_liquid_auto_resume_blocker,
    "live_gate_and_operator_opt_in_required_before_any_robot_motion",
  );
  assert.equal(result.stdoutJson.summary.source_map_expected_presence, true);
  assert.equal(result.stdoutJson.summary.observed_liquid_presence, false);
  assert.deepEqual(result.stdoutJson.summary.cleanup_required, ["drop_tip:left"]);
  assert.deepEqual(result.stdoutJson.summary.blockers, ["attached_tip:left"]);
  assert.match(result.stdoutJson.result_log_entry_id, /^[0-9a-f-]+$/);
  assert.equal(fs.existsSync(outPath), true);
  assert.equal(fs.existsSync(markdownPath), true);

  const artifact = JSON.parse(fs.readFileSync(outPath, "utf8"));
  assert.equal(artifact.result_log_entry_id, result.stdoutJson.result_log_entry_id);
  assert.equal(artifact.action_summary.then_resume, false);
  assert.deepEqual(artifact.action_summary.params.blockers, ["attached_tip:left"]);
  assert.equal(artifact.replay_inputs.commands.data[0].error.errorType, "liquidNotFound");

  const markdown = fs.readFileSync(markdownPath, "utf8");
  assert.match(markdown, /Liquid Failure Replay/);
  assert.match(markdown, /Next tool: `prepare_liquid_source_substitution_recovery`/);
  assert.match(markdown, /Auto resume eligible: `false`/);
  assert.match(markdown, /Cleanup required: `drop_tip:left`/);
  assert.match(markdown, /Blockers: `attached_tip:left`/);

  runNodeSnippet(`
    import { TOOL_HANDLERS } from "./servers/opentrons-mcp/index.js";
    const history = await TOOL_HANDLERS.experiment_history({
      session_id: "${sessionId}",
      tool_name: "export_liquid_failure_replay",
      event_kind: "liquid_failure_replay",
      limit: 1,
    });
    const entry = history.data.entries[0];
    if (!entry || entry.entry_id !== "${result.stdoutJson.result_log_entry_id}") {
      throw new Error("Expected replay result log entry was not found.");
    }
    if (entry.data.next_tool !== "prepare_liquid_source_substitution_recovery") {
      throw new Error("Expected fixed recovery playbook next tool in result log.");
    }
    if (entry.data.no_robot_motion !== true) {
      throw new Error("Expected no-motion result log.");
    }
    if (entry.data.same_liquid_auto_resume_eligible !== false) {
      throw new Error("Expected auto resume to remain false.");
    }
    if (entry.data.cleanup_required[0] !== "drop_tip:left") {
      throw new Error("Expected attached-tip cleanup to remain visible.");
    }
    if (entry.data.blockers[0] !== "attached_tip:left") {
      throw new Error("Expected attached-tip blocker to remain visible.");
    }
  `, env);
});
