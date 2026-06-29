#!/usr/bin/env node
/**
 * Run active L1-L4 runtime recovery monitor ticks.
 *
 * Default mode is observe-only for run watching. Pass --self-fix-mode l0 plus
 * --allow-l4-execution and --operator-opt-in to allow runtime_watch_poll to
 * execute its existing whitelisted L0 self-fix branches.
 */
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(process.env.OPENTRONS_PLUGIN_ROOT || path.join(__dirname, ".."));
const DEFAULT_OUT_DIR = path.join(PLUGIN_ROOT, "runs", "self-recovery", "artifacts");
const DEFAULT_SESSION_ID = "self-recovery-liquid";

function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const args = {
    session_id: process.env.OPENTRONS_SESSION_ID || DEFAULT_SESSION_ID,
    robot_ip: null,
    run_id: null,
    levels: null,
    self_fix_mode: "observe",
    allow_l4_execution: false,
    operator_opt_in: false,
    source_plan: null,
    enable_liquid_gate: false,
    allow_observed_mismatch_reprobe: false,
    max_block_ms: 0,
    poll_interval_ms: 250,
    page_length: 20,
    cycles: 1,
    interval_ms: 30000,
    out: null,
    markdown_out: null,
    fail_on_attention: false,
    publish_notifications: true,
    include_info_notifications: false,
    notify_adapters: [],
    notify_limit: 20,
    outbox_dir: null,
    host_adapter_dir: null,
    webhook_url: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--session-id") {
      args.session_id = argv[index + 1];
      index += 1;
    } else if (item === "--robot-ip") {
      args.robot_ip = argv[index + 1];
      index += 1;
    } else if (item === "--run-id") {
      args.run_id = argv[index + 1];
      index += 1;
    } else if (item === "--levels") {
      args.levels = parseCsv(argv[index + 1]);
      index += 1;
    } else if (item === "--self-fix-mode") {
      args.self_fix_mode = argv[index + 1];
      index += 1;
    } else if (item === "--allow-l4-execution") {
      args.allow_l4_execution = true;
    } else if (item === "--operator-opt-in") {
      args.operator_opt_in = true;
    } else if (item === "--source-plan") {
      args.source_plan = argv[index + 1];
      index += 1;
    } else if (item === "--enable-liquid-gate") {
      args.enable_liquid_gate = true;
    } else if (item === "--allow-observed-mismatch-reprobe") {
      args.allow_observed_mismatch_reprobe = true;
    } else if (item === "--max-block-ms") {
      args.max_block_ms = Number(argv[index + 1]);
      index += 1;
    } else if (item === "--poll-interval-ms") {
      args.poll_interval_ms = Number(argv[index + 1]);
      index += 1;
    } else if (item === "--page-length") {
      args.page_length = Number(argv[index + 1]);
      index += 1;
    } else if (item === "--cycles") {
      args.cycles = Number(argv[index + 1]);
      index += 1;
    } else if (item === "--interval-ms") {
      args.interval_ms = Number(argv[index + 1]);
      index += 1;
    } else if (item === "--out") {
      args.out = argv[index + 1];
      index += 1;
    } else if (item === "--markdown-out") {
      args.markdown_out = argv[index + 1];
      index += 1;
    } else if (item === "--fail-on-attention") {
      args.fail_on_attention = true;
    } else if (item === "--no-publish-notifications") {
      args.publish_notifications = false;
    } else if (item === "--include-info-notifications") {
      args.include_info_notifications = true;
    } else if (item === "--notify-adapters") {
      args.notify_adapters = parseCsv(argv[index + 1]);
      index += 1;
    } else if (item === "--notify-limit") {
      args.notify_limit = Number(argv[index + 1]);
      index += 1;
    } else if (item === "--outbox-dir") {
      args.outbox_dir = argv[index + 1];
      index += 1;
    } else if (item === "--host-adapter-dir") {
      args.host_adapter_dir = argv[index + 1];
      index += 1;
    } else if (item === "--webhook-url") {
      args.webhook_url = argv[index + 1];
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
    `runtime-recovery-monitor-${sessionPart}-${timestampForFile()}-${randomUUID()}.json`,
  );
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function renderMarkdown(payload = {}) {
  const latest = payload.latest || {};
  const notifications = Array.isArray(latest.notifications) ? latest.notifications : [];
  const lines = [
    "# Runtime Recovery Monitor",
    "",
    `Status: \`${latest.status || "unknown"}\``,
    `Session: \`${payload.session_id || DEFAULT_SESSION_ID}\``,
    `Run: \`${payload.run_id || "none"}\``,
    `Robot: \`${payload.robot_ip || "none"}\``,
    `Self-fix mode: \`${payload.self_fix_mode || "observe"}\``,
    `Cycles: \`${payload.cycles?.length || 0}\``,
    `No robot motion in latest tick: \`${latest.no_robot_motion === false ? "false" : "true"}\``,
    "",
    "## 中文摘要",
    "",
    latest.summary_zh || "没有摘要。",
    "",
    "## 通知",
    "",
  ];

  if (notifications.length === 0) {
    lines.push("- none", "");
  } else {
    for (const item of notifications) {
      lines.push(
        `- [${item.level || "L?"}/${item.severity || "info"}] ${item.message_zh || item.message || item.type}`,
      );
    }
    lines.push("");
  }

  const metrics = latest.acceptance?.metrics || {};
  lines.push("## 验收指标", "");
  lines.push(`- Acceptance: \`${latest.acceptance?.status || "unknown"}\``);
  lines.push(`- L0 auto-fix count: \`${metrics.l0_auto_fix_count ?? 0}\``);
  lines.push(`- Human gate count: \`${metrics.human_gate_count ?? 0}\``);
  lines.push(`- Unapproved motion count: \`${metrics.unapproved_motion_count ?? 0}\``);
  lines.push(`- Experiment intent violation count: \`${metrics.experiment_intent_violation_count ?? 0}\``);
  lines.push("");

  const publication = latest.alert_publication || null;
  if (publication) {
    lines.push("## 主动提醒", "");
    lines.push(`- Published alerts: \`${publication.alerts?.length ?? 0}\``);
    lines.push(`- Outbox events: \`${publication.outbox_events?.length ?? 0}\``);
    lines.push(`- Monitor state: \`${publication.monitor_state_path || "none"}\``);
    if (latest.outbox_delivery) {
      lines.push(`- Delivery status: \`${latest.outbox_delivery.status || "unknown"}\``);
      lines.push(`- Delivered attempts: \`${latest.outbox_delivery.delivered?.length ?? 0}\``);
      lines.push(`- Failed attempts: \`${latest.outbox_delivery.failed?.length ?? 0}\``);
    }
    lines.push("");
  }

  lines.push("## 安全边界", "");
  lines.push("- 默认 observe 模式不会通过 run watcher 执行自修动作。");
  lines.push("- L0 自修只能通过 runtime_watch_poll 的既有白名单动作执行。");
  lines.push("- 液体换源、resume 和任何样本身份相关动作仍需要 live gate 和 operator opt-in。");
  lines.push("");
  return lines.join("\n");
}

function buildMonitorRequest(args) {
  return {
    session_id: args.session_id,
    ...(args.robot_ip ? { robot_ip: args.robot_ip } : {}),
    ...(args.run_id ? { run_id: args.run_id } : {}),
    ...(Array.isArray(args.levels) && args.levels.length > 0 ? { levels: args.levels } : {}),
    self_fix_mode: args.self_fix_mode,
    allow_l4_execution: args.allow_l4_execution,
    operator_opt_in: args.operator_opt_in,
    ...(args.source_plan ? { source_plan: args.source_plan } : {}),
    enable_liquid_gate: args.enable_liquid_gate,
    allow_observed_mismatch_reprobe: args.allow_observed_mismatch_reprobe,
    max_block_ms: Number.isFinite(args.max_block_ms) ? args.max_block_ms : 0,
    poll_interval_ms: Number.isFinite(args.poll_interval_ms) ? args.poll_interval_ms : 250,
    page_length: Number.isFinite(args.page_length) ? args.page_length : 20,
    publish_notifications: args.publish_notifications !== false,
    include_info_notifications: args.include_info_notifications === true,
    ...(Array.isArray(args.notify_adapters) && args.notify_adapters.length > 0
      ? { notify_adapters: args.notify_adapters }
      : {}),
    notify_limit: Number.isFinite(args.notify_limit) ? args.notify_limit : 20,
    ...(args.outbox_dir ? { outbox_dir: args.outbox_dir } : {}),
    ...(args.host_adapter_dir ? { host_adapter_dir: args.host_adapter_dir } : {}),
    ...(args.webhook_url ? { webhook_url: args.webhook_url } : {}),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outPath = resolveOutputPath(args);
  const markdownPath = args.markdown_out ? path.resolve(args.markdown_out) : null;
  const server = await import(path.join(PLUGIN_ROOT, "servers", "opentrons-mcp", "index.js"));

  const cycleCount = Math.max(1, Math.min(Number(args.cycles || 1), 1000000));
  const intervalMs = Math.max(1000, Math.min(Number(args.interval_ms || 30000), 24 * 60 * 60 * 1000));
  const cycles = [];
  let latest = null;

  for (let index = 0; index < cycleCount; index += 1) {
    const request = buildMonitorRequest(args);
    const result = await server.TOOL_HANDLERS.runtime_recovery_monitor(request);
    latest = result.data;
    cycles.push({
      order: index + 1,
      timestamp: latest.timestamp,
      request,
      result: latest,
    });

    const payload = {
      status: latest.status,
      session_id: args.session_id,
      run_id: args.run_id,
      robot_ip: args.robot_ip,
      self_fix_mode: args.self_fix_mode,
      output_path: outPath,
      markdown_path: markdownPath,
      latest,
      cycles,
    };
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
    if (markdownPath) {
      fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
      fs.writeFileSync(markdownPath, renderMarkdown(payload));
    }

    if (index < cycleCount - 1) {
      await sleep(intervalMs);
    }
  }

  const finalPayload = {
    status: latest?.status || "unknown",
    session_id: args.session_id,
    run_id: args.run_id,
    robot_ip: args.robot_ip,
    self_fix_mode: args.self_fix_mode,
    output_path: outPath,
    markdown_path: markdownPath,
    latest,
    cycles,
  };
  process.stdout.write(`${JSON.stringify(finalPayload, null, 2)}\n`);
  if (args.fail_on_attention && latest?.requires_attention) {
    process.exitCode = 2;
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
