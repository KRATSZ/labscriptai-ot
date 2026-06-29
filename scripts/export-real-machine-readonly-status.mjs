#!/usr/bin/env node
/**
 * Export a read-only real-machine status snapshot.
 *
 * This never uploads, plays, homes, or moves the robot. It is meant as the
 * first evidence bundle before live recovery tests.
 */
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(process.env.OPENTRONS_PLUGIN_ROOT || path.join(__dirname, ".."));
const DEFAULT_OUT_DIR = path.join(PLUGIN_ROOT, "runs", "self-recovery", "artifacts");
const DEFAULT_SESSION_ID = "self-recovery-liquid";

const ENDPOINTS = [
  "/health",
  "/instruments",
  "/robot/door/status",
  "/robot/control/estopStatus",
  "/deck_configuration",
  "/modules",
  "/runs",
];

function parseArgs(argv) {
  const args = {
    session_id: process.env.OPENTRONS_SESSION_ID || DEFAULT_SESSION_ID,
    robot_ip: null,
    out: null,
    markdown_out: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--session-id") {
      args.session_id = argv[index + 1];
      index += 1;
    } else if (item === "--robot-ip") {
      args.robot_ip = argv[index + 1];
      index += 1;
    } else if (item === "--out") {
      args.out = argv[index + 1];
      index += 1;
    } else if (item === "--markdown-out") {
      args.markdown_out = argv[index + 1];
      index += 1;
    }
  }
  return args;
}

function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function resolveOutputPath(args) {
  if (args.out) {
    return path.resolve(args.out);
  }
  const sessionPart = String(args.session_id || DEFAULT_SESSION_ID).replace(/[^a-zA-Z0-9_.-]/g, "_");
  return path.join(
    DEFAULT_OUT_DIR,
    `real-machine-readonly-status-${sessionPart}-${timestampForFile()}-${randomUUID()}.json`,
  );
}

function normalizeRobotBase(robotIp) {
  if (!robotIp) {
    throw new Error("--robot-ip is required for real-machine read-only status export.");
  }
  const raw = String(robotIp).trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(raw)) {
    return raw;
  }
  return `http://${raw}:31950`;
}

async function fetchEndpoint(baseUrl, endpoint) {
  try {
    const response = await fetch(`${baseUrl}${endpoint}`, {
      headers: { "opentrons-version": "*" },
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text.slice(0, 2000);
    }
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, status: null, body: null, error: error.message };
  }
}

function endpointBody(snapshot, endpoint) {
  return snapshot.endpoints?.[endpoint]?.body || null;
}

function summarize(snapshot) {
  const health = endpointBody(snapshot, "/health") || {};
  const instruments = endpointBody(snapshot, "/instruments")?.data || [];
  const modules = endpointBody(snapshot, "/modules")?.data || [];
  const runs = endpointBody(snapshot, "/runs")?.data || [];
  const door = endpointBody(snapshot, "/robot/door/status")?.data || {};
  const estop = endpointBody(snapshot, "/robot/control/estopStatus")?.data || {};
  const pipettes = instruments
    .filter(item => item?.instrumentType === "pipette")
    .map(item => ({
      mount: item.mount || null,
      instrument_name: item.instrumentName || null,
      model: item.instrumentModel || null,
      serial: item.serialNumber || null,
      ok: item.ok ?? null,
      tip_detected: item.state?.tipDetected ?? null,
    }));
  const gripper = instruments.find(item => item?.instrumentType === "gripper") || null;
  const attachedTipMounts = pipettes
    .filter(item => item.tip_detected === true)
    .map(item => item.mount)
    .filter(Boolean);
  const estopDisengaged = estop.status === "disengaged";
  const doorClosed = door.status === "closed";
  const robotReachable = snapshot.endpoints?.["/health"]?.ok === true;
  const blockers = [];
  if (!robotReachable) {
    blockers.push("robot_unreachable");
  }
  if (!doorClosed) {
    blockers.push(`door:${door.status || "unknown"}`);
  }
  if (!estopDisengaged) {
    blockers.push(`estop:${estop.status || "unknown"}`);
  }
  for (const mount of attachedTipMounts) {
    blockers.push(`attached_tip:${mount}`);
  }

  return {
    robot_reachable: robotReachable,
    robot_name: health.name || null,
    robot_model: health.robot_model || null,
    api_version: health.api_version || null,
    system_version: health.system_version || null,
    pipettes,
    gripper: gripper
      ? {
          mount: gripper.mount || null,
          model: gripper.instrumentModel || null,
          serial: gripper.serialNumber || null,
          ok: gripper.ok ?? null,
          jaw_state: gripper.data?.jawState || null,
        }
      : null,
    attached_tip_mounts: attachedTipMounts,
    door_status: door.status || null,
    estop_status: estop.status || null,
    module_count: Array.isArray(modules) ? modules.length : null,
    module_summaries: Array.isArray(modules)
      ? modules.map(module => ({
          id: module.id || null,
          model: module.model || module.moduleModel || null,
          status: module.status || module.data?.status || null,
          location: module.location || module.data?.location || null,
        }))
      : [],
    run_count: Array.isArray(runs) ? runs.length : null,
    latest_runs: Array.isArray(runs)
      ? runs.slice(-5).map(run => ({
          id: run.id || null,
          status: run.status || null,
          createdAt: run.createdAt || null,
          protocolId: run.protocolId || null,
          current: run.current ?? null,
        }))
      : [],
    no_robot_motion: true,
    live_liquid_motion_allowed: blockers.length === 0,
    blockers,
  };
}

function markdownCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function renderMarkdown(payload) {
  const summary = payload.summary || {};
  const lines = [
    "# Real Machine Read-only Status",
    "",
    `Status: \`${payload.status}\``,
    `Robot: \`${summary.robot_name || "unknown"}\``,
    `API version: \`${summary.api_version || "unknown"}\``,
    `No robot motion: \`${summary.no_robot_motion ? "true" : "false"}\``,
    `Live liquid motion allowed: \`${summary.live_liquid_motion_allowed ? "true" : "false"}\``,
    `Result log entry: \`${payload.result_log_entry_id || "pending"}\``,
    "",
    "## Blockers",
    "",
  ];
  if (summary.blockers?.length) {
    for (const blocker of summary.blockers) {
      lines.push(`- \`${blocker}\``);
    }
  } else {
    lines.push("- none");
  }
  lines.push("", "## Pipettes", "", "| Mount | Instrument | Tip detected | OK |", "|---|---|---:|---:|");
  for (const pipette of summary.pipettes || []) {
    lines.push(
      `| ${markdownCell(pipette.mount)} | ${markdownCell(pipette.instrument_name)} | ${markdownCell(pipette.tip_detected)} | ${markdownCell(pipette.ok)} |`,
    );
  }
  lines.push("", "## Safety State", "");
  lines.push(`- Door: \`${summary.door_status || "unknown"}\``);
  lines.push(`- Estop: \`${summary.estop_status || "unknown"}\``);
  lines.push(`- Modules: \`${summary.module_count ?? "unknown"}\``);
  lines.push("");
  lines.push("## Boundary", "");
  lines.push("- This artifact is read-only evidence, not permission to move the robot.");
  lines.push("- If any blocker is present, do not home, upload, play, or run liquid tests.");
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outPath = resolveOutputPath(args);
  const markdownPath = args.markdown_out ? path.resolve(args.markdown_out) : null;
  const baseUrl = normalizeRobotBase(args.robot_ip);
  const resultLog = await import(path.join(PLUGIN_ROOT, "servers", "opentrons-mcp", "lib", "result-log.js"));
  const snapshot = {
    captured_at: new Date().toISOString(),
    session_id: args.session_id,
    robot_ip: args.robot_ip,
    base_url: baseUrl,
    read_only: true,
    endpoints: {},
  };
  for (const endpoint of ENDPOINTS) {
    snapshot.endpoints[endpoint] = await fetchEndpoint(baseUrl, endpoint);
  }
  const summary = summarize(snapshot);
  snapshot.summary = summary;
  const status = summary.live_liquid_motion_allowed ? "completed" : "blocked";
  const logEntry = resultLog.appendResultLogEntry({
    session_id: args.session_id,
    run_id: null,
    tool_name: "real_machine_readonly_status_cli",
    event_kind: "readonly_robot_status",
    status,
    robot_ip: args.robot_ip,
    requires_attention: status !== "completed",
    summary:
      status === "completed"
        ? "Robot reachable and no read-only live-liquid blockers detected."
        : `Read-only robot status blocked: ${summary.blockers.join(", ")}.`,
    data: {
      output_path: outPath,
      markdown_path: markdownPath,
      summary,
    },
  });
  const payload = {
    status,
    session_id: args.session_id,
    robot_ip: args.robot_ip,
    output_path: outPath,
    markdown_path: markdownPath,
    result_log_entry_id: logEntry.entry_id,
    result_log_entry: logEntry,
    ...snapshot,
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
  if (markdownPath) {
    fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
    fs.writeFileSync(markdownPath, renderMarkdown(payload));
  }
  console.log(JSON.stringify({
    status,
    output_path: outPath,
    markdown_path: markdownPath,
    result_log_entry_id: logEntry.entry_id,
    summary,
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
