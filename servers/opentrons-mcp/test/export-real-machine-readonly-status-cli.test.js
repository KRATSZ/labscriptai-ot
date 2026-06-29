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
const CLI_PATH = path.join(PLUGIN_ROOT, "scripts", "export-real-machine-readonly-status.mjs");

function createFakeRobotServer() {
  const routes = {
    "/health": {
      name: "Silabrobot001",
      robot_model: "OT-3 Standard",
      api_version: "9.0.0",
      system_version: "v0.9.14",
    },
    "/instruments": {
      data: [
        {
          mount: "left",
          instrumentType: "pipette",
          instrumentModel: "p1000_single_v3.6",
          instrumentName: "p1000_single_flex",
          serialNumber: "P1KSV-test",
          ok: true,
          state: { tipDetected: true },
        },
        {
          mount: "right",
          instrumentType: "pipette",
          instrumentModel: "p1000_multi_v3.5",
          instrumentName: "p1000_multi_flex",
          serialNumber: "P1KM-test",
          ok: true,
          state: { tipDetected: false },
        },
        {
          mount: "extension",
          instrumentType: "gripper",
          instrumentModel: "gripperV1.3",
          serialNumber: "GRP-test",
          ok: true,
          data: { jawState: "stopped" },
        },
      ],
    },
    "/robot/door/status": {
      data: {
        status: "closed",
        doorRequiredClosedForProtocol: true,
      },
    },
    "/robot/control/estopStatus": {
      data: {
        status: "disengaged",
        leftEstopPhysicalStatus: "disengaged",
        rightEstopPhysicalStatus: "notPresent",
      },
    },
    "/deck_configuration": {
      data: [],
    },
    "/modules": {
      data: [],
    },
    "/runs": {
      data: [
        {
          id: "old-run",
          status: "succeeded",
          createdAt: "2026-06-22T01:00:00.000Z",
          protocolId: "protocol-old",
          current: false,
        },
        {
          id: "latest-run",
          status: "stopped",
          createdAt: "2026-06-22T02:00:00.000Z",
          protocolId: "protocol-latest",
          current: true,
        },
      ],
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

test("export-real-machine-readonly-status CLI writes blocked status for attached tip", async () => {
  const server = createFakeRobotServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = server.address().port;
    const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "readonly-status-artifacts-"));
    const resultLogDir = fs.mkdtempSync(path.join(os.tmpdir(), "readonly-status-log-"));
    const outPath = path.join(artifactDir, "status.json");
    const markdownPath = path.join(artifactDir, "status.md");
    const sessionId = "readonly-status-test";
    const result = await runCli([
      "--session-id",
      sessionId,
      "--robot-ip",
      `http://127.0.0.1:${port}`,
      "--out",
      outPath,
      "--markdown-out",
      markdownPath,
    ], {
      OPENTRONS_RESULT_LOG_DIR: resultLogDir,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdoutJson.status, "blocked");
    assert.deepEqual(result.stdoutJson.summary.attached_tip_mounts, ["left"]);
    assert.deepEqual(result.stdoutJson.summary.blockers, ["attached_tip:left"]);
    assert.equal(result.stdoutJson.summary.live_liquid_motion_allowed, false);

    const artifact = JSON.parse(fs.readFileSync(outPath, "utf8"));
    assert.equal(artifact.result_log_entry_id, result.stdoutJson.result_log_entry_id);
    assert.equal(artifact.summary.robot_name, "Silabrobot001");
    assert.equal(artifact.summary.pipettes[0].tip_detected, true);
    assert.equal(artifact.summary.latest_runs.at(-1).id, "latest-run");
    assert.equal(artifact.summary.no_robot_motion, true);

    const markdown = fs.readFileSync(markdownPath, "utf8");
    assert.match(markdown, /Real Machine Read-only Status/);
    assert.match(markdown, /attached_tip:left/);
    assert.match(markdown, /p1000_single_flex/);

    const logPath = path.join(resultLogDir, `${sessionId}.jsonl`);
    const entries = fs.readFileSync(logPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].tool_name, "real_machine_readonly_status_cli");
    assert.equal(entries[0].event_kind, "readonly_robot_status");
    assert.equal(entries[0].status, "blocked");
    assert.equal(entries[0].data.summary.blockers[0], "attached_tip:left");
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
