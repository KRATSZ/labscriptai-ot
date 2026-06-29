import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "..", "..", "..");
const CLI_PATH = path.join(PLUGIN_ROOT, "scripts", "drop-attached-tip.mjs");

function createFakeRobotServer({ tipDetected = true, doorStatus = "closed", estopStatus = "disengaged" } = {}) {
  const routes = {
    "/health": {
      name: "Silabrobot001",
      robot_model: "OT-3 Standard",
      api_version: "9.0.0",
    },
    "/instruments": {
      data: [
        {
          mount: "left",
          instrumentType: "pipette",
          instrumentModel: "p1000_single_v3.6",
          instrumentName: "p1000_single_flex",
          ok: true,
          state: { tipDetected },
        },
      ],
    },
    "/robot/door/status": {
      data: { status: doorStatus },
    },
    "/robot/control/estopStatus": {
      data: { status: estopStatus },
    },
  };

  const server = http.createServer((request, response) => {
    const body = routes[request.url || ""];
    if (!body) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ errors: [{ detail: "not found" }] }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  return server;
}

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd: PLUGIN_ROOT,
      env: {
        ...process.env,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => {
      stdout += chunk;
    });
    child.stderr.on("data", chunk => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", status => {
      let stdoutJson = null;
      if (stdout.trim()) {
        stdoutJson = JSON.parse(stdout);
      }
      resolve({ status, stdout, stderr, stdoutJson });
    });
  });
}

test("drop-attached-tip CLI dry-run reports ready without robot motion", async () => {
  const server = createFakeRobotServer({ tipDetected: true });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = server.address().port;
    const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "drop-tip-artifacts-"));
    const resultLogDir = fs.mkdtempSync(path.join(os.tmpdir(), "drop-tip-log-"));
    const outPath = path.join(artifactDir, "drop-tip.json");
    const markdownPath = path.join(artifactDir, "drop-tip.md");
    const sessionId = "drop-tip-cli-test";
    const result = await runCli([
      "--session-id",
      sessionId,
      "--robot-ip",
      `http://127.0.0.1:${port}`,
      "--mount",
      "left",
      "--out",
      outPath,
      "--markdown-out",
      markdownPath,
    ], {
      OPENTRONS_RESULT_LOG_DIR: resultLogDir,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdoutJson.status, "dry_run_ready");
    assert.equal(result.stdoutJson.before.can_drop_tip, true);
    assert.equal(result.stdoutJson.before.no_robot_motion, true);
    assert.match(result.stdoutJson.next_command, /--execute/);

    const artifact = JSON.parse(fs.readFileSync(outPath, "utf8"));
    assert.equal(artifact.execute, false);
    assert.equal(artifact.before.target_pipette.tip_detected, true);
    assert.equal(artifact.result_log_entry_id, result.stdoutJson.result_log_entry_id);

    const markdown = fs.readFileSync(markdownPath, "utf8");
    assert.match(markdown, /Dry-run only/);
    assert.match(markdown, /Tip detected: `true`/);

    const logPath = path.join(resultLogDir, `${sessionId}.jsonl`);
    const entries = fs.readFileSync(logPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].tool_name, "drop_attached_tip_cli");
    assert.equal(entries[0].event_kind, "cleanup_dry_run");
    assert.equal(entries[0].status, "dry_run_ready");
    assert.equal(entries[0].data.before.can_drop_tip, true);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("drop-attached-tip CLI blocks dry-run when no tip is attached", async () => {
  const server = createFakeRobotServer({ tipDetected: false });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = server.address().port;
    const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "drop-tip-blocked-artifacts-"));
    const resultLogDir = fs.mkdtempSync(path.join(os.tmpdir(), "drop-tip-blocked-log-"));
    const outPath = path.join(artifactDir, "drop-tip.json");
    const sessionId = "drop-tip-cli-blocked-test";
    const result = await runCli([
      "--session-id",
      sessionId,
      "--robot-ip",
      `http://127.0.0.1:${port}`,
      "--out",
      outPath,
    ], {
      OPENTRONS_RESULT_LOG_DIR: resultLogDir,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdoutJson.status, "blocked");
    assert.deepEqual(result.stdoutJson.before.blockers, ["no_attached_tip:left"]);
    assert.equal(result.stdoutJson.next_command, null);

    const artifact = JSON.parse(fs.readFileSync(outPath, "utf8"));
    assert.equal(artifact.before.can_drop_tip, false);
    assert.deepEqual(artifact.before.blockers, ["no_attached_tip:left"]);

    const logPath = path.join(resultLogDir, `${sessionId}.jsonl`);
    const entries = fs.readFileSync(logPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(entries[0].status, "blocked");
    assert.deepEqual(entries[0].data.before.blockers, ["no_attached_tip:left"]);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
