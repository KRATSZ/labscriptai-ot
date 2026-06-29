#!/usr/bin/env node
/**
 * Export a concise runtime-recovery readiness bundle.
 *
 * This is read-only. It summarizes the latest gate artifact plus safe_next_action
 * so a restarted agent can decide whether live liquid tests are allowed.
 */
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(process.env.OPENTRONS_PLUGIN_ROOT || path.join(__dirname, ".."));
const DEFAULT_OUT_DIR = path.join(PLUGIN_ROOT, "runs", "self-recovery", "artifacts");
const DEFAULT_SESSION_ID = "self-recovery-liquid";
const DEFAULT_GATE_ARTIFACT = path.join(DEFAULT_OUT_DIR, "live-liquid-recovery-gate-source-plan-latest.json");
const DEFAULT_REAL_MACHINE_ARTIFACT = path.join(DEFAULT_OUT_DIR, "real-machine-readonly-status-latest.json");
const DEFAULT_VALIDATION_BUNDLE_ARTIFACT = path.join(
  DEFAULT_OUT_DIR,
  "liquid-source-substitution-validation-bundle-latest.json",
);
const DEFAULT_RECOVERY_BUNDLE_ARTIFACT = path.join(
  DEFAULT_OUT_DIR,
  "liquid-source-substitution-recovery-bundle-latest.json",
);

function parseArgs(argv) {
  const args = {
    session_id: process.env.OPENTRONS_SESSION_ID || DEFAULT_SESSION_ID,
    robot_ip: null,
    limit: 8,
    gate_artifact: DEFAULT_GATE_ARTIFACT,
    real_machine_artifact: DEFAULT_REAL_MACHINE_ARTIFACT,
    validation_bundle_artifact: DEFAULT_VALIDATION_BUNDLE_ARTIFACT,
    recovery_bundle_artifact: DEFAULT_RECOVERY_BUNDLE_ARTIFACT,
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
    } else if (item === "--gate-artifact") {
      args.gate_artifact = argv[index + 1];
      index += 1;
    } else if (item === "--real-machine-artifact") {
      args.real_machine_artifact = argv[index + 1];
      index += 1;
    } else if (item === "--validation-bundle-artifact") {
      args.validation_bundle_artifact = argv[index + 1];
      index += 1;
    } else if (item === "--recovery-bundle-artifact") {
      args.recovery_bundle_artifact = argv[index + 1];
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
    `runtime-recovery-readiness-${sessionPart}-${timestampForFile()}-${randomUUID()}.json`,
  );
}

function readJsonIfPresent(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    return { path: resolved, exists: false, data: null, error: null };
  }
  try {
    return {
      path: resolved,
      exists: true,
      data: JSON.parse(fs.readFileSync(resolved, "utf8")),
      error: null,
    };
  } catch (error) {
    return { path: resolved, exists: true, data: null, error: error.message };
  }
}

function summarizeSafeNext(safeNext = {}) {
  const inputSummary = safeNext.liquid_identity_inputs_needed_summary || {};
  return {
    recommended_next_tool: safeNext.recommended_next_tool || null,
    rationale_zh: safeNext.rationale_zh || null,
    no_robot_motion:
      Array.isArray(safeNext.latest_resolution_plan) &&
      safeNext.latest_resolution_plan.some(step => step?.no_robot_motion === true),
    operator_steps_zh: Array.isArray(safeNext.operator_steps_zh)
      ? safeNext.operator_steps_zh
      : [],
    latest_result_log_entry_id:
      safeNext.latest_operator_request_source?.entry_id ||
      safeNext.latest_resolution_plan_source?.entry_id ||
      null,
    operator_request_markdown_path:
      safeNext.latest_operator_request_artifacts?.markdown_path || null,
    liquid_identity_inputs_needed_count: inputSummary.count ?? 0,
    liquid_identity_input_keys: inputSummary.keys || [],
  };
}

function summarizeGate(gate = {}) {
  return {
    status: gate.status || null,
    ok_for_live_liquid_rerun: gate.ok_for_live_liquid_rerun === true,
    result_log_entry_id: gate.result_log_entry_id || null,
    failed_checks: gate.failed_checks || [],
    warning_checks: gate.warning_checks || [],
    manual_gates: gate.manual_gates || [],
    recommended_next_action: gate.recommended_next_action || null,
    no_robot_motion:
      Array.isArray(gate.resolution_plan) &&
      gate.resolution_plan.some(step => step?.no_robot_motion === true),
    attached_tip_blocked: (gate.failed_checks || []).includes("no_attached_tip_before_liquid_probe_rerun"),
    mcp_reload_required: (gate.manual_gates || []).includes("mcp_client_reload"),
    liquid_identity_incomplete: (gate.warning_checks || []).includes("source_identity_metadata"),
    request_count: gate.operator_request?.request_count ?? null,
  };
}

function summarizeRealMachineStatus(realMachine = {}) {
  const summary = realMachine.summary || {};
  const blockers = Array.isArray(summary.blockers) ? summary.blockers : [];
  return {
    status: realMachine.status || null,
    result_log_entry_id: realMachine.result_log_entry_id || null,
    robot_reachable: summary.robot_reachable ?? null,
    robot_name: summary.robot_name || null,
    api_version: summary.api_version || null,
    door_status: summary.door_status || null,
    estop_status: summary.estop_status || null,
    attached_tip_mounts: Array.isArray(summary.attached_tip_mounts)
      ? summary.attached_tip_mounts
      : [],
    blockers,
    live_liquid_motion_allowed: summary.live_liquid_motion_allowed === true,
    no_robot_motion: summary.no_robot_motion === true || blockers.length > 0,
  };
}

function summarizeValidationBundle(bundle = {}) {
  const decision = bundle.decision || {};
  const parsedSimulation = bundle.simulation?.parsed || {};
  return {
    status: bundle.status || null,
    result_log_entry_id: bundle.result_log_entry_id || null,
    failed_source_key: bundle.failed_source_key || null,
    selected_source_key: bundle.selected_source_key || null,
    generated_protocol_path: bundle.generated_protocol_path || null,
    simulation_status: parsedSimulation.status || null,
    simulation_issue_count: parsedSimulation.issue_count ?? null,
    validation_passed: decision.validation_passed === true || bundle.status === "passed",
    auto_resume_eligible: decision.auto_resume_eligible === true,
    live_execution_allowed: decision.live_execution_allowed === true,
    live_protocol_run_allowed: decision.live_protocol_run_allowed === true,
    semantic_invariant_status:
      decision.semantic_invariant_status ||
      bundle.semantic_invariants?.status ||
      null,
    experiment_intent_violation_count:
      decision.experiment_intent_violation_count ??
      bundle.semantic_invariants?.experiment_intent_violation_count ??
      null,
    semantic_gate_blocker_count:
      decision.semantic_gate_blocker_count ??
      bundle.semantic_invariants?.gate_blocker_count ??
      null,
    next_tool: decision.next_tool || null,
    blocked_reason: decision.blocked_reason || null,
    no_robot_motion: decision.no_robot_motion === true || bundle.no_robot_motion === true,
    liquid_guard_status: bundle.liquid_guard_analysis?.status ||
      bundle.generation?.validation_protocol?.liquid_guard_analysis?.status ||
      null,
    liquid_guard_first_aspirate_guarded:
      bundle.liquid_guard_analysis?.first_aspirate_guarded ??
      bundle.generation?.validation_protocol?.liquid_guard_analysis?.first_aspirate_guarded ??
      null,
    liquid_guard_no_aspirate_or_dispense:
      bundle.liquid_guard_analysis?.no_aspirate_or_dispense ??
      bundle.generation?.validation_protocol?.liquid_guard_analysis?.no_aspirate_or_dispense ??
      null,
  };
}

function summarizeRecoveryBundle(bundle = {}) {
  const execution = bundle.execution || {};
  const simulation = bundle.simulation || {};
  return {
    status: bundle.status || null,
    result_log_entry_id: bundle.result_log_entry_id || null,
    playbook: bundle.playbook || null,
    failed_source_key: bundle.failed_source_key || null,
    selected_source_key: bundle.selected_source_key || null,
    generated_protocol_path: bundle.generated_protocol_path || null,
    simulation_status: simulation.status || simulation.parsed?.status || null,
    simulation_issue_count: simulation.issue_count ?? simulation.parsed?.issue_count ?? null,
    fixed_script_prepared: execution.fixed_script_prepared === true,
    auto_resume_eligible: execution.auto_resume_eligible === true,
    live_execution_allowed: execution.live_execution_allowed === true,
    live_protocol_run_allowed: execution.live_protocol_run_allowed === true,
    semantic_invariant_status:
      execution.semantic_invariant_status ||
      bundle.semantic_invariants?.status ||
      null,
    experiment_intent_violation_count:
      execution.experiment_intent_violation_count ??
      bundle.semantic_invariants?.experiment_intent_violation_count ??
      null,
    semantic_gate_blocker_count:
      execution.semantic_gate_blocker_count ??
      bundle.semantic_invariants?.gate_blocker_count ??
      null,
    next_tool: execution.next_tool || null,
    blocked_reason: execution.blocked_reason || null,
    no_robot_motion: bundle.no_robot_motion === true,
    liquid_guard_status: bundle.validation_protocol?.liquid_guard_analysis?.status || null,
    liquid_guard_first_aspirate_guarded:
      bundle.validation_protocol?.liquid_guard_analysis?.first_aspirate_guarded ?? null,
    liquid_guard_no_aspirate_or_dispense:
      bundle.validation_protocol?.liquid_guard_analysis?.no_aspirate_or_dispense ?? null,
  };
}

function findMcpProcesses() {
  if (process.env.OPENTRONS_SKIP_MCP_PROCESS_SCAN === "1") {
    return [];
  }
  try {
    const stdout = process.env.OPENTRONS_MCP_PROCESS_LIST || execFileSync("ps", ["-axo", "pid,ppid,lstart,etime,command"], {
      encoding: "utf8",
      timeout: 5000,
    });
    return stdout
      .split(/\r?\n/)
      .slice(1)
      .map(line => line.trim())
      .filter(line => {
        if (!/node .*opentrons-mcp\/index\.js(?:\s|$)/.test(line)) {
          return false;
        }
        if (/(?:^|\s)-e(?:\s|$)|(?:^|\s)--eval(?:\s|=)|(?:^|\s)--input-type=module(?:\s|$)/.test(line)) {
          return false;
        }
        return true;
      })
      .map(line => {
        const match = line.match(/^(\d+)\s+(\d+)\s+(.+?)\s{2,}(.+?)\s+(.+)$/);
        return {
          raw: line,
          pid: match ? Number(match[1]) : null,
          ppid: match ? Number(match[2]) : null,
          started: match ? match[3].trim() : null,
          elapsed: match ? match[4].trim() : null,
          command: match ? match[5].trim() : line,
        };
      });
  } catch (error) {
    return [{ raw: null, pid: null, ppid: null, started: null, elapsed: null, command: null, error: error.message }];
  }
}

function summarizeMcpProcess(processes = []) {
  const running = processes.filter(processInfo => processInfo.pid);
  return {
    running: running.length > 0,
    count: running.length,
    processes,
  };
}

function buildDecision({
  gateSummary,
  safeNextSummary,
  realMachineSummary,
  mcpProcessSummary,
  validationBundleArtifact,
  validationBundleSummary,
  recoveryBundleArtifact,
  recoveryBundleSummary,
}) {
  if (recoveryBundleArtifact.exists && recoveryBundleArtifact.error) {
    return {
      status: "blocked",
      live_liquid_tests_allowed: false,
      reason_zh: `当前不能继续真机液体测试：液体换源恢复 bundle 读不出来：${recoveryBundleArtifact.error}。`,
      next_tool: "prepare_liquid_source_substitution_recovery",
    };
  }
  if (recoveryBundleArtifact.exists && recoveryBundleSummary.status !== "prepared") {
    return {
      status: "blocked",
      live_liquid_tests_allowed: false,
      reason_zh: "当前不能继续真机液体测试：液体换源固定恢复脚本尚未准备完成或本地模拟未通过。",
      next_tool: "prepare_liquid_source_substitution_recovery",
    };
  }
  if (
    recoveryBundleArtifact.exists &&
    Number(recoveryBundleSummary.experiment_intent_violation_count || 0) > 0
  ) {
    return {
      status: "blocked",
      live_liquid_tests_allowed: false,
      reason_zh: "当前不能继续真机液体测试：液体换源恢复 bundle 的实验语义不变量未通过，不能续跑。",
      next_tool: "prepare_liquid_source_substitution_recovery",
    };
  }
  if (
    recoveryBundleArtifact.exists &&
    (recoveryBundleSummary.live_execution_allowed ||
      recoveryBundleSummary.live_protocol_run_allowed)
  ) {
    return {
      status: "blocked",
      live_liquid_tests_allowed: false,
      reason_zh: "当前不能继续真机液体测试：液体换源恢复 bundle 声称可以直接真机执行，这违反当前安全边界，需要先修正固定恢复脚本。",
      next_tool: "prepare_liquid_source_substitution_recovery",
    };
  }
  if (validationBundleArtifact.exists && validationBundleArtifact.error) {
    return {
      status: "blocked",
      live_liquid_tests_allowed: false,
      reason_zh: `当前不能继续真机液体测试：液体换源验证 bundle 读不出来：${validationBundleArtifact.error}。`,
      next_tool: "validate_liquid_source_substitution",
    };
  }
  if (validationBundleArtifact.exists && validationBundleSummary.status !== "passed") {
    return {
      status: "blocked",
      live_liquid_tests_allowed: false,
      reason_zh: "当前不能继续真机液体测试：液体换源验证 bundle 尚未通过本地模拟。",
      next_tool: "validate_liquid_source_substitution",
    };
  }
  if (
    validationBundleArtifact.exists &&
    Number(validationBundleSummary.experiment_intent_violation_count || 0) > 0
  ) {
    return {
      status: "blocked",
      live_liquid_tests_allowed: false,
      reason_zh: "当前不能继续真机液体测试：液体换源验证 bundle 的实验语义不变量未通过，不能继续。",
      next_tool: "validate_liquid_source_substitution",
    };
  }
  if (
    validationBundleArtifact.exists &&
    (validationBundleSummary.live_execution_allowed ||
      validationBundleSummary.live_protocol_run_allowed)
  ) {
    return {
      status: "blocked",
      live_liquid_tests_allowed: false,
      reason_zh: "当前不能继续真机液体测试：液体换源验证 bundle 声称可以直接真机执行，这违反当前安全边界，需要先修正恢复策略。",
      next_tool: "validate_liquid_source_substitution",
    };
  }

  const realMachineBlockers = realMachineSummary.blockers || [];
  if (Array.isArray(gateSummary.failed_checks) && gateSummary.failed_checks.includes("source_map_requirements")) {
    return {
      status: "blocked",
      live_liquid_tests_allowed: false,
      reason_zh: "当前不能继续真机液体测试：source map 与 gate 要求或最新 live probe 观测不一致，需要先修正液体来源账本。",
      next_tool: "record_liquid_source_map",
    };
  }
  if (mcpProcessSummary.running === false) {
    const physicalClause = realMachineBlockers.length > 0
      ? ` 另外，最新真机只读快照仍有 blocker：${realMachineBlockers.join(", ")}。`
      : "";
    return {
      status: "blocked",
      live_liquid_tests_allowed: false,
      reason_zh: `当前不能继续真机液体测试：本地没有运行中的 opentrons MCP 进程，实际客户端通常会表现为 Transport closed。${physicalClause}`,
      next_tool: "reload_mcp_client",
    };
  }
  if (realMachineBlockers.length > 0 || realMachineSummary.live_liquid_motion_allowed === false) {
    return {
      status: "blocked",
      live_liquid_tests_allowed: false,
      reason_zh: `当前不能继续真机液体测试：最新真机只读快照仍有 blocker：${realMachineBlockers.join(", ") || "unknown"}。`,
      next_tool: "export_real_machine_readonly_status",
    };
  }
  if (!gateSummary.ok_for_live_liquid_rerun || gateSummary.mcp_reload_required || gateSummary.attached_tip_blocked) {
    return {
      status: "blocked",
      live_liquid_tests_allowed: false,
      reason_zh: "当前不能继续真机液体测试：还有 gate blocker 或 MCP reload 人工门。",
      next_tool: safeNextSummary.recommended_next_tool || gateSummary.recommended_next_action || "robot_status",
    };
  }
  if (gateSummary.liquid_identity_incomplete || safeNextSummary.liquid_identity_inputs_needed_count > 0) {
    return {
      status: "needs_attention",
      live_liquid_tests_allowed: true,
      reason_zh: "液体探测本身可继续，但涉及语义恢复或换源前必须补全液体/样本身份。",
      next_tool: safeNextSummary.recommended_next_tool || "record_liquid_source_map",
    };
  }
  return {
    status: "ready",
    live_liquid_tests_allowed: true,
    reason_zh: "当前 readiness bundle 未发现阻止液体 watcher/probe 重跑的 blocker。",
    next_tool: safeNextSummary.recommended_next_tool || "live_liquid_recovery_gate",
  };
}

function markdownCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function renderMarkdown(payload = {}) {
  const lines = [
    "# Runtime Recovery Readiness",
    "",
    `Status: \`${payload.status}\``,
    `Live liquid tests allowed: \`${payload.decision.live_liquid_tests_allowed ? "true" : "false"}\``,
    `Next tool: \`${payload.decision.next_tool}\``,
    `No robot motion: \`${payload.summary.no_robot_motion ? "true" : "false"}\``,
    `MCP process running: \`${payload.mcp_process.running ? "true" : "false"}\``,
    "",
    "## 中文结论",
    "",
    payload.decision.reason_zh,
    "",
    "## Evidence",
    "",
    `- Gate artifact: \`${payload.gate_artifact.path}\``,
    `- Gate result log: \`${payload.gate.result_log_entry_id || "none"}\``,
    `- Real-machine artifact: \`${payload.real_machine_artifact.path}\``,
    `- Real-machine result log: \`${payload.real_machine.result_log_entry_id || "none"}\``,
    `- Liquid substitution validation artifact: \`${payload.validation_bundle_artifact.path}\``,
    `- Liquid substitution validation result log: \`${payload.validation_bundle.result_log_entry_id || "none"}\``,
    `- Liquid substitution recovery artifact: \`${payload.recovery_bundle_artifact.path}\``,
    `- Liquid substitution recovery result log: \`${payload.recovery_bundle.result_log_entry_id || "none"}\``,
    `- Safe-next result log: \`${payload.safe_next.latest_result_log_entry_id || "none"}\``,
    `- Readiness result log: \`${payload.result_log_entry_id || "pending"}\``,
    "",
    "## Blockers",
    "",
    `- Failed checks: \`${payload.gate.failed_checks.join(", ") || "none"}\``,
    `- Real-machine blockers: \`${payload.real_machine.blockers.join(", ") || "none"}\``,
    `- Warnings: \`${payload.gate.warning_checks.join(", ") || "none"}\``,
    `- Manual gates: \`${payload.gate.manual_gates.join(", ") || "none"}\``,
    `- MCP process count: \`${payload.mcp_process.count}\``,
    `- Liquid substitution validation: \`${payload.validation_bundle.status || "missing"}\``,
    `- Liquid substitution simulation: \`${payload.validation_bundle.simulation_status || "missing"}\``,
    `- Liquid substitution selected source: \`${payload.validation_bundle.selected_source_key || "none"}\``,
    `- Liquid substitution guard: \`${payload.validation_bundle.liquid_guard_status || "missing"}\``,
    `- Liquid substitution auto resume: \`${payload.validation_bundle.auto_resume_eligible ? "true" : "false"}\``,
    `- Liquid substitution live execution: \`${payload.validation_bundle.live_execution_allowed ? "true" : "false"}\``,
    `- Liquid recovery playbook: \`${payload.recovery_bundle.playbook || "missing"}\``,
    `- Liquid recovery prepared: \`${payload.recovery_bundle.fixed_script_prepared ? "true" : "false"}\``,
    `- Liquid recovery simulation: \`${payload.recovery_bundle.simulation_status || "missing"}\``,
    `- Liquid recovery guard: \`${payload.recovery_bundle.liquid_guard_status || "missing"}\``,
    `- Liquid recovery auto resume: \`${payload.recovery_bundle.auto_resume_eligible ? "true" : "false"}\``,
    `- Liquid recovery live execution: \`${payload.recovery_bundle.live_execution_allowed ? "true" : "false"}\``,
    `- Liquid recovery semantic status: \`${payload.recovery_bundle.semantic_invariant_status || "missing"}\``,
    `- Liquid recovery intent violations: \`${payload.recovery_bundle.experiment_intent_violation_count ?? "missing"}\``,
    "",
  ];

  if (payload.safe_next.operator_steps_zh.length > 0) {
    lines.push("## 下一步", "");
    for (const step of payload.safe_next.operator_steps_zh) {
      lines.push(`- ${step}`);
    }
    lines.push("");
  }

  if (payload.safe_next.liquid_identity_input_keys.length > 0) {
    lines.push("## 需要补全的液体身份", "");
    lines.push("| Well |");
    lines.push("|---|");
    for (const key of payload.safe_next.liquid_identity_input_keys) {
      lines.push(`| ${markdownCell(key)} |`);
    }
    lines.push("");
  }

  lines.push("## 安全边界", "");
  lines.push("- 这是只读 readiness 总结，不代表 deck truth。");
  lines.push("- `No robot motion=true` 时，不要自动 home，不要继续液体 watcher/probe。");
  lines.push("- 涉及液体来源、样本身份或换源时，必须先人工确认。");
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outPath = resolveOutputPath(args);
  const markdownPath = args.markdown_out ? path.resolve(args.markdown_out) : null;
  const server = await import(path.join(PLUGIN_ROOT, "servers", "opentrons-mcp", "index.js"));
  const resultLog = await import(path.join(PLUGIN_ROOT, "servers", "opentrons-mcp", "lib", "result-log.js"));

  const safeNextRequest = {
    session_id: args.session_id,
    limit: Number.isFinite(args.limit) ? args.limit : 8,
    ...(args.robot_ip ? { robot_ip: args.robot_ip } : {}),
  };
  const safeNextResult = await server.TOOL_HANDLERS.safe_next_action(safeNextRequest);
  const safeNext = safeNextResult.data?.safe_next_action || {};
  const safeNextSummary = summarizeSafeNext(safeNext);
  const gateArtifact = readJsonIfPresent(args.gate_artifact);
  const gateSummary = summarizeGate(gateArtifact.data || {});
  const realMachineArtifact = readJsonIfPresent(args.real_machine_artifact);
  const realMachineSummary = summarizeRealMachineStatus(realMachineArtifact.data || {});
  const validationBundleArtifact = readJsonIfPresent(args.validation_bundle_artifact);
  const validationBundleSummary = summarizeValidationBundle(validationBundleArtifact.data || {});
  const recoveryBundleArtifact = readJsonIfPresent(args.recovery_bundle_artifact);
  const recoveryBundleSummary = summarizeRecoveryBundle(recoveryBundleArtifact.data || {});
  const mcpProcessSummary = summarizeMcpProcess(findMcpProcesses());
  const decision = buildDecision({
    gateSummary,
    safeNextSummary,
    realMachineSummary,
    mcpProcessSummary,
    validationBundleArtifact,
    validationBundleSummary,
    recoveryBundleArtifact,
    recoveryBundleSummary,
  });
  const noRobotMotion =
    gateSummary.no_robot_motion ||
    safeNextSummary.no_robot_motion ||
    realMachineSummary.no_robot_motion ||
    validationBundleSummary.no_robot_motion ||
    recoveryBundleSummary.no_robot_motion;

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const logEntry = resultLog.appendResultLogEntry({
    session_id: args.session_id,
    run_id: null,
    tool_name: "runtime_recovery_readiness_cli",
    event_kind: "readiness_bundle",
    status: decision.status,
    summary: `Runtime recovery readiness: ${decision.status}; next=${decision.next_tool}.`,
    robot_ip: args.robot_ip,
    requires_attention: decision.status !== "ready",
    data: {
      output_path: outPath,
      markdown_path: markdownPath,
      gate_artifact_path: gateArtifact.path,
      real_machine_artifact_path: realMachineArtifact.path,
      validation_bundle_artifact_path: validationBundleArtifact.path,
      recovery_bundle_artifact_path: recoveryBundleArtifact.path,
      gate_result_log_entry_id: gateSummary.result_log_entry_id,
      real_machine_result_log_entry_id: realMachineSummary.result_log_entry_id,
      validation_bundle_result_log_entry_id: validationBundleSummary.result_log_entry_id,
      recovery_bundle_result_log_entry_id: recoveryBundleSummary.result_log_entry_id,
      safe_next_result_log_entry_id: safeNextSummary.latest_result_log_entry_id,
      decision,
      no_robot_motion: noRobotMotion,
      gate: gateSummary,
      real_machine: realMachineSummary,
      validation_bundle: validationBundleSummary,
      recovery_bundle: recoveryBundleSummary,
      safe_next: safeNextSummary,
      mcp_process: mcpProcessSummary,
    },
  });

  const payload = {
    status: decision.status,
    session_id: args.session_id,
    robot_ip: args.robot_ip,
    output_path: outPath,
    markdown_path: markdownPath,
    result_log_entry_id: logEntry.entry_id,
    result_log_entry: logEntry,
    request: {
      session_id: args.session_id,
      robot_ip: args.robot_ip,
      limit: args.limit,
      gate_artifact: gateArtifact.path,
      real_machine_artifact: realMachineArtifact.path,
      validation_bundle_artifact: validationBundleArtifact.path,
      recovery_bundle_artifact: recoveryBundleArtifact.path,
    },
    decision,
    summary: {
      no_robot_motion: noRobotMotion,
      live_liquid_tests_allowed: decision.live_liquid_tests_allowed,
      next_tool: decision.next_tool,
    },
    gate_artifact: {
      path: gateArtifact.path,
      exists: gateArtifact.exists,
      error: gateArtifact.error,
    },
    gate: gateSummary,
    real_machine_artifact: {
      path: realMachineArtifact.path,
      exists: realMachineArtifact.exists,
      error: realMachineArtifact.error,
    },
    real_machine: realMachineSummary,
    validation_bundle_artifact: {
      path: validationBundleArtifact.path,
      exists: validationBundleArtifact.exists,
      error: validationBundleArtifact.error,
    },
    validation_bundle: validationBundleSummary,
    recovery_bundle_artifact: {
      path: recoveryBundleArtifact.path,
      exists: recoveryBundleArtifact.exists,
      error: recoveryBundleArtifact.error,
    },
    recovery_bundle: recoveryBundleSummary,
    safe_next: safeNextSummary,
    mcp_process: mcpProcessSummary,
  };

  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
  if (markdownPath) {
    fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
    fs.writeFileSync(markdownPath, renderMarkdown(payload));
  }
  console.log(JSON.stringify({
    status: payload.status,
    output_path: outPath,
    markdown_path: markdownPath,
    result_log_entry_id: logEntry.entry_id,
    decision,
    summary: payload.summary,
    mcp_process: {
      running: mcpProcessSummary.running,
      count: mcpProcessSummary.count,
    },
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
