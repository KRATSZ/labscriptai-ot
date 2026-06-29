#!/usr/bin/env node
/**
 * Export restart/resume guidance as an artifact and result-log entry.
 *
 * This is read-only. Without --robot-ip it does not contact the robot; it only
 * reads persisted session state and recent result logs.
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
    limit: 5,
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
    } else if (item === "--limit") {
      args.limit = Number(argv[index + 1]);
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
    `safe-next-action-${sessionPart}-${timestampForFile()}-${randomUUID()}.json`,
  );
}

function summarizeSafeNext(safeNext = {}) {
  const inputSummary = safeNext.liquid_identity_inputs_needed_summary || {};
  const recovery = safeNext.latest_liquid_source_substitution_recovery || {};
  const recoverySource = safeNext.latest_liquid_source_substitution_recovery_source || {};
  return {
    recommended_next_tool: safeNext.recommended_next_tool || null,
    rationale_zh: safeNext.rationale_zh || null,
    request_count: safeNext.latest_operator_request?.request_count ?? null,
    operator_request_markdown_path:
      safeNext.latest_operator_request_artifacts?.markdown_path || null,
    latest_result_log_entry_id:
      safeNext.latest_operator_request_source?.entry_id ||
      safeNext.latest_resolution_plan_source?.entry_id ||
      null,
    liquid_identity_inputs_needed_count: inputSummary.count ?? 0,
    liquid_identity_input_keys: inputSummary.keys || [],
    liquid_source_substitution_recovery_entry_id: recoverySource.entry_id || null,
    liquid_source_substitution_recovery_status: recovery.status || null,
    liquid_source_substitution_recovery_prepared: recovery.fixed_script_prepared === true,
    liquid_source_substitution_recovery_failed_source_key: recovery.failed_source_key || null,
    liquid_source_substitution_recovery_selected_source_key: recovery.selected_source_key || null,
    liquid_source_substitution_recovery_auto_resume_eligible: recovery.auto_resume_eligible === true,
    liquid_source_substitution_recovery_live_execution_allowed: recovery.live_execution_allowed === true,
    no_robot_motion:
      (Array.isArray(safeNext.latest_resolution_plan) &&
        safeNext.latest_resolution_plan.some(step => step?.no_robot_motion === true)) ||
      recovery.no_robot_motion === true,
  };
}

function markdownCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function renderMarkdown(payload = {}) {
  const summary = payload.summary || {};
  const safeNext = payload.safe_next_action || {};
  const stepsZh = Array.isArray(safeNext.operator_steps_zh) ? safeNext.operator_steps_zh : [];
  const inputKeys = Array.isArray(summary.liquid_identity_input_keys)
    ? summary.liquid_identity_input_keys
    : [];
  const lines = [
    "# Runtime Resume Guidance",
    "",
    `Status: \`${payload.status || "unknown"}\``,
    `Session: \`${payload.session_id || DEFAULT_SESSION_ID}\``,
    `Result log entry: \`${payload.result_log_entry_id || "pending"}\``,
    `Recommended next tool: \`${summary.recommended_next_tool || "unknown"}\``,
    `No robot motion: \`${summary.no_robot_motion === true ? "true" : "false"}\``,
    "",
    "## 中文下一步",
    "",
  ];

  if (summary.rationale_zh) {
    lines.push(summary.rationale_zh, "");
  }
  if (stepsZh.length > 0) {
    for (const step of stepsZh) {
      lines.push(`- ${step}`);
    }
    lines.push("");
  }

  lines.push("## 当前阻塞摘要", "");
  lines.push(`- Operator request: \`${summary.operator_request_markdown_path || "none"}\``);
  lines.push(`- Latest gate/log entry: \`${summary.latest_result_log_entry_id || "none"}\``);
  lines.push(`- Liquid identity inputs needed: \`${summary.liquid_identity_inputs_needed_count || 0}\``);
  lines.push(`- Liquid recovery entry: \`${summary.liquid_source_substitution_recovery_entry_id || "none"}\``);
  lines.push(`- Liquid recovery prepared: \`${summary.liquid_source_substitution_recovery_prepared ? "true" : "false"}\``);
  lines.push(`- Liquid recovery source change: \`${summary.liquid_source_substitution_recovery_failed_source_key || "none"} -> ${summary.liquid_source_substitution_recovery_selected_source_key || "none"}\``);
  lines.push(`- Liquid recovery auto resume: \`${summary.liquid_source_substitution_recovery_auto_resume_eligible ? "true" : "false"}\``);
  lines.push(`- Liquid recovery live execution: \`${summary.liquid_source_substitution_recovery_live_execution_allowed ? "true" : "false"}\``);
  lines.push("");

  if (inputKeys.length > 0) {
    lines.push("| Missing liquid identity wells |");
    lines.push("|---|");
    for (const key of inputKeys) {
      lines.push(`| ${markdownCell(key)} |`);
    }
    lines.push("");
  }

  lines.push("## 安全边界", "");
  lines.push("- 这份文件是重启恢复建议，不代表当前 deck 真相。");
  lines.push("- 任何机器人运动前，先用 robot_status/module_status 或 live gate 重新确认。");
  lines.push("- 如果 No robot motion 为 true，不要自动 home，也不要继续液体测试。");
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outPath = resolveOutputPath(args);
  const markdownPath = args.markdown_out ? path.resolve(args.markdown_out) : null;
  const server = await import(path.join(PLUGIN_ROOT, "servers", "opentrons-mcp", "index.js"));
  const resultLog = await import(path.join(PLUGIN_ROOT, "servers", "opentrons-mcp", "lib", "result-log.js"));

  const request = {
    session_id: args.session_id,
    limit: Number.isFinite(args.limit) ? args.limit : 5,
    ...(args.robot_ip ? { robot_ip: args.robot_ip } : {}),
  };
  const result = await server.TOOL_HANDLERS.safe_next_action(request);
  const safeNext = result.data?.safe_next_action || {};
  const summary = summarizeSafeNext(safeNext);
  const recoveryRequiresGate =
    summary.liquid_source_substitution_recovery_prepared === true &&
    (summary.liquid_source_substitution_recovery_auto_resume_eligible === false ||
      summary.liquid_source_substitution_recovery_live_execution_allowed === false);
  const status = safeNext.reconcile_first ||
    safeNext.latest_operator_request?.human_required ||
    summary.no_robot_motion === true ||
    recoveryRequiresGate
    ? "needs_attention"
    : "completed";

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const logEntry = resultLog.appendResultLogEntry({
    session_id: args.session_id,
    run_id: null,
    tool_name: "safe_next_action_cli",
    event_kind: "resume_guidance",
    status,
    summary:
      summary.recommended_next_tool
        ? `Safe-next recommends ${summary.recommended_next_tool}.`
        : "Safe-next resume guidance exported.",
    robot_ip: args.robot_ip,
    requires_attention: status === "needs_attention",
    data: {
      output_path: outPath,
      markdown_path: markdownPath,
      request,
      summary,
      safe_next_action: safeNext,
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
    request,
    summary,
    safe_next_action: safeNext,
  };
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
