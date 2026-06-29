import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "..", "..", "..");
const CLI_PATH = path.join(PLUGIN_ROOT, "scripts", "validate-liquid-source-substitution.mjs");

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

test("validate-liquid-source-substitution CLI writes a no-motion validation bundle", () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "liquid-substitution-cli-session-"));
  const resultLogDir = fs.mkdtempSync(path.join(os.tmpdir(), "liquid-substitution-cli-log-"));
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "liquid-substitution-cli-artifacts-"));
  const sessionId = "liquid-substitution-cli-test";
  const protocolPath = path.join(artifactDir, "validation.py");
  const outPath = path.join(artifactDir, "bundle.json");
  const markdownPath = path.join(artifactDir, "bundle.md");
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
    "--preferred-source-key",
    "C3.A1",
    "--pipette-name",
    "flex_1channel_1000",
    "--mount",
    "left",
    "--tiprack-load-name",
    "opentrons_flex_96_tiprack_1000ul",
    "--tiprack-slot",
    "B2",
    "--output-protocol-path",
    protocolPath,
    "--out",
    outPath,
    "--markdown-out",
    markdownPath,
    "--skip-simulation",
  ], env);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdoutJson.status, "needs_simulation");
  assert.equal(result.stdoutJson.no_robot_motion, true);
  assert.equal(result.stdoutJson.generated_protocol_path, protocolPath);
  assert.equal(fs.existsSync(protocolPath), true);
  assert.equal(fs.existsSync(outPath), true);
  assert.equal(fs.existsSync(markdownPath), true);

  const protocol = fs.readFileSync(protocolPath, "utf8");
  assert.match(protocol, /require_liquid_presence/);
  assert.doesNotMatch(protocol, /\.aspirate\(/);
  assert.doesNotMatch(protocol, /\.dispense\(/);

  const artifact = JSON.parse(fs.readFileSync(outPath, "utf8"));
  assert.equal(artifact.status, "needs_simulation");
  assert.equal(artifact.failed_source_key, "D3.A1");
  assert.equal(artifact.selected_source_key, "C3.A1");
  assert.equal(artifact.no_robot_motion, true);
  assert.equal(artifact.no_aspirate_or_dispense, true);
  assert.equal(artifact.liquid_guard_analysis.status, "pass");
  assert.equal(artifact.liquid_guard_analysis.no_aspirate_or_dispense, true);
  assert.equal(artifact.liquid_guard_analysis.first_aspirate_guarded, true);
  assert.equal(artifact.simulation.skipped, true);
  assert.equal(artifact.decision.auto_resume_eligible, false);
  assert.equal(artifact.decision.live_execution_allowed, false);
  assert.equal(artifact.decision.next_tool, "simulate_protocol");
  assert.equal(artifact.decision.blocked_reason, "simulation_not_run");
  assert.equal(artifact.result_log_entry_id, result.stdoutJson.result_log_entry_id);
  assert.equal(result.stdoutJson.decision.auto_resume_eligible, false);
  assert.equal(result.stdoutJson.decision.live_execution_allowed, false);
  assert.equal(result.stdoutJson.liquid_guard_status, "pass");

  const markdown = fs.readFileSync(markdownPath, "utf8");
  assert.match(markdown, /Liquid Source Substitution Validation/);
  assert.match(markdown, /Status: `needs_simulation`/);
  assert.match(markdown, /Auto resume eligible: `false`/);
  assert.match(markdown, /Live execution allowed: `false`/);
  assert.match(markdown, /Liquid guard status: `pass`/);
  assert.match(markdown, /First aspirate guarded: `true`/);

  runNodeSnippet(`
    import { TOOL_HANDLERS } from "./servers/opentrons-mcp/index.js";
    const history = await TOOL_HANDLERS.experiment_history({
      session_id: "${sessionId}",
      tool_name: "validate_liquid_source_substitution_cli",
      event_kind: "liquid_source_substitution_validation_bundle",
      limit: 1,
    });
    const entry = history.data.entries[0];
    if (!entry || entry.entry_id !== "${result.stdoutJson.result_log_entry_id}") {
      throw new Error("Expected validation bundle result log entry was not found.");
    }
    if (entry.data.selected_source_key !== "C3.A1") {
      throw new Error("Expected selected source key in result log.");
    }
    if (entry.data.no_robot_motion !== true) {
      throw new Error("Expected no-motion result log.");
    }
    if (entry.data.decision.live_execution_allowed !== false) {
      throw new Error("Expected live execution to remain blocked in result log.");
    }
    if (entry.data.liquid_guard_analysis.status !== "pass") {
      throw new Error("Expected liquid guard analysis in result log.");
    }
  `, env);
});
