#!/usr/bin/env node
/**
 * Drop an attached tip through the same MCP handler, with a dry-run default.
 *
 * This is a fallback for the common recovery case where Codex MCP transport is
 * unavailable but the local plugin checkout can still reach the robot.
 */
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(process.env.OPENTRONS_PLUGIN_ROOT || path.join(__dirname, ".."));
const DEFAULT_OUT_DIR = path.join(PLUGIN_ROOT, "runs", "self-recovery", "artifacts");
const DEFAULT_SESSION_ID = "self-recovery-liquid";

function parseArgs(argv) {
  const args = {
    session_id: process.env.OPENTRONS_SESSION_ID || DEFAULT_SESSION_ID,
    robot_ip: null,
    mount: "left",
    context_id: null,
    pipette_name: null,
    timeout_ms: 30000,
    poll_interval_ms: 500,
    execute: false,
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
    } else if (item === "--mount") {
      args.mount = argv[index + 1];
      index += 1;
    } else if (item === "--context-id") {
      args.context_id = argv[index + 1];
      index += 1;
    } else if (item === "--pipette-name") {
      args.pipette_name = argv[index + 1];
      index += 1;
    } else if (item === "--timeout-ms") {
      args.timeout_ms = Number(argv[index + 1]);
      index += 1;
    } else if (item === "--poll-interval-ms") {
      args.poll_interval_ms = Number(argv[index + 1]);
      index += 1;
    } else if (item === "--execute") {
      args.execute = true;
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
    `drop-attached-tip-${sessionPart}-${timestampForFile()}-${randomUUID()}.json`,
  );
}

function normalizeRobotBase(robotIp) {
  if (!robotIp) {
    throw new Error("--robot-ip is required.");
  }
  const raw = String(robotIp).trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(raw)) {
    return raw;
  }
  return `http://${raw}:31950`;
}

async function fetchJson(baseUrl, endpoint) {
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
}

async function readAttachedTipStatus(robotIp, mount) {
  const baseUrl = normalizeRobotBase(robotIp);
  const [health, instruments, door, estop] = await Promise.all([
    fetchJson(baseUrl, "/health"),
    fetchJson(baseUrl, "/instruments"),
    fetchJson(baseUrl, "/robot/door/status"),
    fetchJson(baseUrl, "/robot/control/estopStatus"),
  ]);
  const pipettes = (instruments.body?.data || [])
    .filter(item => item?.instrumentType === "pipette")
    .map(item => ({
      mount: item.mount || null,
      instrument_name: item.instrumentName || null,
      model: item.instrumentModel || null,
      ok: item.ok ?? null,
      tip_detected: item.state?.tipDetected ?? null,
    }));
  const target = pipettes.find(item => item.mount === mount) || null;
  const blockers = [];
  if (health.ok !== true) {
    blockers.push("robot_unreachable");
  }
  if ((door.body?.data?.status || null) !== "closed") {
    blockers.push(`door:${door.body?.data?.status || "unknown"}`);
  }
  if ((estop.body?.data?.status || null) !== "disengaged") {
    blockers.push(`estop:${estop.body?.data?.status || "unknown"}`);
  }
  if (!target) {
    blockers.push(`pipette_missing:${mount}`);
  } else if (target.tip_detected !== true) {
    blockers.push(`no_attached_tip:${mount}`);
  }

  return {
    robot_name: health.body?.name || null,
    api_version: health.body?.api_version || null,
    door_status: door.body?.data?.status || null,
    estop_status: estop.body?.data?.status || null,
    pipettes,
    target_pipette: target,
    can_drop_tip: blockers.length === 0,
    blockers,
    no_robot_motion: true,
  };
}

function renderMarkdown(payload) {
  const lines = [
    "# Drop Attached Tip",
    "",
    `Status: \`${payload.status}\``,
    `Mode: \`${payload.execute ? "execute" : "dry-run"}\``,
    `Robot: \`${payload.before?.robot_name || "unknown"}\``,
    `Mount: \`${payload.mount}\``,
    `Result log entry: \`${payload.result_log_entry_id || "pending"}\``,
    "",
    "## Before",
    "",
    `- Tip detected: \`${payload.before?.target_pipette?.tip_detected ?? "unknown"}\``,
    `- Door: \`${payload.before?.door_status || "unknown"}\``,
    `- Estop: \`${payload.before?.estop_status || "unknown"}\``,
    `- Blockers: \`${payload.before?.blockers?.join(", ") || "none"}\``,
    "",
    "## Result",
    "",
  ];
  if (payload.execute) {
    lines.push(`- Context id: \`${payload.context_id || "unknown"}\``);
    lines.push(`- Tip still attached: \`${payload.drop_result?.data?.tip_still_attached ?? "unknown"}\``);
  } else {
    lines.push("- Dry-run only; no maintenance context was created and no robot command was enqueued.");
    lines.push("- Re-run with `--execute` only when an attached tip is confirmed and cleanup is intended.");
  }
  if (payload.after) {
    lines.push("", "## After", "");
    lines.push(`- Tip detected: \`${payload.after?.target_pipette?.tip_detected ?? "unknown"}\``);
    lines.push(`- Blockers: \`${payload.after?.blockers?.join(", ") || "none"}\``);
  }
  lines.push("", "## Boundary", "");
  lines.push("- This tool only clears an attached tip; it does not upload, play, resume, aspirate, or dispense.");
  return lines.join("\n");
}

async function writePayload({ args, outPath, markdownPath, payload, status, summary }) {
  const resultLog = await import(path.join(PLUGIN_ROOT, "servers", "opentrons-mcp", "lib", "result-log.js"));
  const logEntry = resultLog.appendResultLogEntry({
    session_id: args.session_id,
    run_id: null,
    tool_name: "drop_attached_tip_cli",
    event_kind: args.execute ? "cleanup_action" : "cleanup_dry_run",
    status,
    robot_ip: args.robot_ip,
    requires_attention: status !== "completed",
    summary,
    data: {
      output_path: outPath,
      markdown_path: markdownPath,
      mount: args.mount,
      execute: args.execute,
      before: payload.before || null,
      after: payload.after || null,
      context_id: payload.context_id || null,
      tip_still_attached: payload.drop_result?.data?.tip_still_attached ?? null,
    },
  });
  const finalPayload = {
    ...payload,
    status,
    result_log_entry_id: logEntry.entry_id,
    result_log_entry: logEntry,
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(finalPayload, null, 2)}\n`);
  if (markdownPath) {
    fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
    fs.writeFileSync(markdownPath, renderMarkdown(finalPayload));
  }
  return finalPayload;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outPath = resolveOutputPath(args);
  const markdownPath = args.markdown_out ? path.resolve(args.markdown_out) : null;
  const before = await readAttachedTipStatus(args.robot_ip, args.mount);
  const payload = {
    session_id: args.session_id,
    robot_ip: args.robot_ip,
    mount: args.mount,
    execute: args.execute,
    output_path: outPath,
    markdown_path: markdownPath,
    before,
  };

  if (!args.execute) {
    const finalPayload = await writePayload({
      args,
      outPath,
      markdownPath,
      payload,
      status: before.can_drop_tip ? "dry_run_ready" : "blocked",
      summary: before.can_drop_tip
        ? `Dry-run ready to drop attached tip on ${args.mount}.`
        : `Dry-run blocked: ${before.blockers.join(", ")}.`,
    });
    console.log(JSON.stringify({
      status: finalPayload.status,
      output_path: outPath,
      markdown_path: markdownPath,
      result_log_entry_id: finalPayload.result_log_entry_id,
      before,
      next_command: before.can_drop_tip
        ? `node scripts/drop-attached-tip.mjs --robot-ip ${args.robot_ip} --session-id ${args.session_id} --mount ${args.mount} --execute`
        : null,
    }, null, 2));
    return;
  }

  if (!before.can_drop_tip) {
    const finalPayload = await writePayload({
      args,
      outPath,
      markdownPath,
      payload,
      status: "blocked",
      summary: `Refused to drop attached tip: ${before.blockers.join(", ")}.`,
    });
    console.log(JSON.stringify({
      status: finalPayload.status,
      output_path: outPath,
      markdown_path: markdownPath,
      result_log_entry_id: finalPayload.result_log_entry_id,
      before,
    }, null, 2));
    process.exitCode = 2;
    return;
  }

  const { TOOL_HANDLERS } = await import(path.join(PLUGIN_ROOT, "servers", "opentrons-mcp", "index.js"));
  let contextId = args.context_id;
  let contextResult = null;
  if (!contextId) {
    contextResult = await TOOL_HANDLERS.create_run_context({
      robot_ip: args.robot_ip,
      context_type: "maintenance",
      session_id: args.session_id,
    });
    contextId = contextResult.data.context_id;
  }
  const dropResult = await TOOL_HANDLERS.drop_attached_tip({
    robot_ip: args.robot_ip,
    session_id: args.session_id,
    context_id: contextId,
    mount: args.mount,
    pipette_name: args.pipette_name || before.target_pipette?.instrument_name || undefined,
    timeout_ms: args.timeout_ms,
    poll_interval_ms: args.poll_interval_ms,
  });
  const after = await readAttachedTipStatus(args.robot_ip, args.mount);
  payload.context_id = contextId;
  payload.context_result = contextResult;
  payload.drop_result = dropResult;
  payload.after = after;
  const completed = after.target_pipette?.tip_detected === false && dropResult.data?.tip_still_attached === false;
  const finalPayload = await writePayload({
    args,
    outPath,
    markdownPath,
    payload,
    status: completed ? "completed" : "blocked",
    summary: completed
      ? `Dropped attached tip from ${args.mount}.`
      : `Drop attached tip did not clear ${args.mount}.`,
  });
  console.log(JSON.stringify({
    status: finalPayload.status,
    output_path: outPath,
    markdown_path: markdownPath,
    result_log_entry_id: finalPayload.result_log_entry_id,
    context_id: contextId,
    tip_still_attached: dropResult.data?.tip_still_attached ?? null,
    before,
    after,
  }, null, 2));
  if (!completed) {
    process.exitCode = 2;
  }
}

main().catch(async error => {
  console.error(error);
  process.exit(1);
});
