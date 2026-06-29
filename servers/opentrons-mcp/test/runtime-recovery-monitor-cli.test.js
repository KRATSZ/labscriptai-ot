import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "..", "..", "..");
const CLI_PATH = path.join(PLUGIN_ROOT, "scripts", "runtime-recovery-monitor.mjs");

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

test("runtime-recovery-monitor CLI writes artifact, markdown, and result log", () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-monitor-cli-session-"));
  const resultLogDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-monitor-cli-log-"));
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-monitor-cli-artifacts-"));
  const outboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-monitor-cli-outbox-"));
  const hostAdapterDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-monitor-cli-host-"));
  const sessionId = "runtime-monitor-cli-test";
  const outPath = path.join(artifactDir, "monitor.json");
  const markdownPath = path.join(artifactDir, "monitor.md");
  const env = {
    OPENTRONS_SESSION_STATE_DIR: sessionDir,
    OPENTRONS_RESULT_LOG_DIR: resultLogDir,
  };

  const result = runCli([
    "--session-id",
    sessionId,
    "--levels",
    "L4",
    "--out",
    outPath,
    "--markdown-out",
    markdownPath,
    "--outbox-dir",
    outboxDir,
    "--host-adapter-dir",
    hostAdapterDir,
    "--notify-adapters",
    "claudecode,codex,cursor,cli",
  ], env);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdoutJson.status, "blocked");
  assert.equal(result.stdoutJson.output_path, outPath);
  assert.equal(result.stdoutJson.markdown_path, markdownPath);
  assert.equal(result.stdoutJson.latest.levels.L4.status, "blocked");
  assert.equal(result.stdoutJson.latest.latest, undefined);
  assert.match(result.stdoutJson.latest.result_log_entry_id, /^[0-9a-f-]+$/);

  const artifact = JSON.parse(fs.readFileSync(outPath, "utf8"));
  assert.equal(artifact.latest.result_log_entry_id, result.stdoutJson.latest.result_log_entry_id);
  assert.equal(artifact.latest.notifications[0].type, "guarded_execution_blocked");
  assert.equal(artifact.latest.notifications[0].requires_attention, true);
  assert.equal(artifact.latest.alert_publication.outbox_events.length, 1);
  assert.equal(artifact.latest.outbox_delivery.status, "delivered");
  assert.equal(artifact.latest.outbox_delivery.delivered.length, 4);
  const markdown = fs.readFileSync(markdownPath, "utf8");
  assert.match(markdown, /# Runtime Recovery Monitor/);
  assert.match(markdown, /受控执行被策略或当前状态阻止/);
  assert.match(markdown, /## 主动提醒/);
  assert.ok(fs.existsSync(path.join(hostAdapterDir, "claudecode", `${sessionId}.jsonl`)));
  assert.ok(fs.existsSync(path.join(hostAdapterDir, "codex", `${sessionId}.jsonl`)));
  assert.ok(fs.existsSync(path.join(hostAdapterDir, "cursor", `${sessionId}.jsonl`)));

  runNodeSnippet(`
    import { TOOL_HANDLERS } from "./servers/opentrons-mcp/index.js";
    const history = await TOOL_HANDLERS.experiment_history({
      session_id: "${sessionId}",
      tool_name: "runtime_recovery_monitor",
      event_kind: "runtime_monitor",
      limit: 1,
    });
    const entry = history.data.entries[0];
    if (!entry || entry.entry_id !== "${result.stdoutJson.latest.result_log_entry_id}") {
      throw new Error("Expected runtime_monitor result log entry was not found.");
    }
    if (entry.data.status !== "blocked") {
      throw new Error("Expected blocked monitor status in result log.");
    }
    if (entry.data.attention_count < 1) {
      throw new Error("Expected attention count in result log.");
    }
  `, env);
});
