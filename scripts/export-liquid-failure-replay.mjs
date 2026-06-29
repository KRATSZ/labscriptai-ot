#!/usr/bin/env node
/**
 * Replay a no-motion liquid-probe failure through the current recovery
 * decision logic and export the structured handoff.
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
    failed_source_key: "D3.A1",
    run_id: "synthetic-liquid-failure-replay",
    labware_id: null,
    labware_load_name: null,
    command_id: "synthetic-liquid-probe-failed",
    error_type: "liquidNotFound",
    attached_tip_mount: null,
    out: null,
    markdown_out: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--session-id") {
      args.session_id = argv[index + 1];
      index += 1;
    } else if (item === "--failed-source-key") {
      args.failed_source_key = argv[index + 1];
      index += 1;
    } else if (item === "--run-id") {
      args.run_id = argv[index + 1];
      index += 1;
    } else if (item === "--labware-id") {
      args.labware_id = argv[index + 1];
      index += 1;
    } else if (item === "--labware-load-name") {
      args.labware_load_name = argv[index + 1];
      index += 1;
    } else if (item === "--command-id") {
      args.command_id = argv[index + 1];
      index += 1;
    } else if (item === "--error-type") {
      args.error_type = argv[index + 1];
      index += 1;
    } else if (item === "--attached-tip-mount") {
      args.attached_tip_mount = argv[index + 1];
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

function safeFilePart(value, fallback = "unknown") {
  return String(value || fallback).replace(/[^a-zA-Z0-9_.-]/g, "_").toLowerCase();
}

function resolveOutputPath(args) {
  if (args.out) {
    return path.resolve(args.out);
  }
  return path.join(
    DEFAULT_OUT_DIR,
    `liquid-failure-replay-${safeFilePart(args.failed_source_key)}-${timestampForFile()}-${randomUUID()}.json`,
  );
}

function parseSourceKey(sourceKey) {
  const [slotName, wellName, ...rest] = String(sourceKey || "").split(".");
  if (!slotName || !wellName || rest.length > 0) {
    throw new Error("--failed-source-key must use SLOT.WELL form, for example D3.A1.");
  }
  return {
    slot_name: slotName.toUpperCase(),
    well_name: wellName.toUpperCase(),
    source_key: `${slotName.toUpperCase()}.${wellName.toUpperCase()}`,
  };
}

function buildReplayInputs({ args, source, sourceMapEntry }) {
  const labwareId = args.labware_id || `synthetic-${source.slot_name.toLowerCase()}-labware`;
  const labwareLoadName =
    args.labware_load_name ||
    sourceMapEntry?.labware_load_name ||
    (source.slot_name === "C3" ? "nest_12_reservoir_15ml" : "corning_96_wellplate_360ul_flat");
  const failedCommand = {
    id: args.command_id,
    commandType: "liquidProbe",
    status: "failed",
    params: {
      labwareId,
      wellName: source.well_name,
    },
    error: {
      errorType: args.error_type,
      detail: `${args.error_type} during liquid probe at ${source.source_key}`,
    },
  };
  const run = {
    data: {
      id: args.run_id,
      status: "awaiting-recovery",
      labware: [
        {
          id: labwareId,
          loadName: labwareLoadName,
          location: {
            slotName: source.slot_name,
          },
        },
      ],
    },
  };
  const commands = {
    data: [failedCommand],
  };
  const robotStatusSnapshot = args.attached_tip_mount
    ? {
        blockers: [`attached_tip:${args.attached_tip_mount}`],
        instruments_summary: [
          {
            mount: args.attached_tip_mount,
            tip_detected: true,
          },
        ],
      }
    : {
        blockers: [],
        instruments_summary: [],
      };
  return { run, commands, robotStatusSnapshot };
}

function renderMarkdown(payload) {
  const lines = [
    "# Liquid Failure Replay",
    "",
    `Status: \`${payload.status}\``,
    `Session: \`${payload.session_id}\``,
    `Synthetic run id: \`${payload.run_id}\``,
    `Failed source: \`${payload.failed_source_key}\``,
    `No robot motion: \`${payload.no_robot_motion ? "true" : "false"}\``,
    `Result log entry: \`${payload.result_log_entry_id || "pending"}\``,
    "",
    "## Decision",
    "",
    `- Action: \`${payload.recovery.action || "unknown"}\``,
    `- Recommended manual action: \`${payload.recovery.recommended_manual_action || "none"}\``,
    `- Next tool: \`${payload.summary.next_tool || "none"}\``,
    `- Playbook: \`${payload.summary.playbook || "none"}\``,
    `- Candidate count: \`${payload.summary.same_liquid_source_candidate_count}\``,
    `- Auto resume eligible: \`${payload.summary.same_liquid_auto_resume_eligible ? "true" : "false"}\``,
    `- Auto resume blocker: \`${payload.summary.same_liquid_auto_resume_blocker || "none"}\``,
    `- Cleanup required: \`${payload.summary.cleanup_required.join(", ") || "none"}\``,
    `- Blockers: \`${payload.summary.blockers.join(", ") || "none"}\``,
    "",
    "## Candidate Sources",
    "",
  ];
  if (payload.summary.same_liquid_source_candidates.length === 0) {
    lines.push("- none", "");
  } else {
    for (const candidate of payload.summary.same_liquid_source_candidates) {
      lines.push(`- \`${candidate.source_map_key}\` (${candidate.liquid_name || "unknown"})`);
    }
    lines.push("");
  }
  lines.push("## Boundary", "");
  lines.push("- This is a local replay of recovery decision logic.");
  lines.push("- It does not contact, home, upload to, play on, aspirate, dispense, or move the robot.");
  lines.push("- A fixed playbook next tool still requires live gate and operator opt-in before any live action.");
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = parseSourceKey(args.failed_source_key);
  const outPath = resolveOutputPath(args);
  const markdownPath = args.markdown_out ? path.resolve(args.markdown_out) : null;
  const state = await import(path.join(PLUGIN_ROOT, "servers", "opentrons-mcp", "lib", "state.js"));
  const decision = await import(path.join(PLUGIN_ROOT, "servers", "opentrons-mcp", "lib", "decision.js"));
  const resultLog = await import(path.join(PLUGIN_ROOT, "servers", "opentrons-mcp", "lib", "result-log.js"));

  const sessionState = state.readSessionState(args.session_id);
  const sourceMapEntry = sessionState?.liquid_tracking?.sources?.[source.source_key] || null;
  const replayInputs = buildReplayInputs({ args, source, sourceMapEntry });
  const recoverySuggestion = decision.buildRecoverySuggestion({
    errorCategory: "INSUFFICIENT_VOLUME",
    errorLeaf: "INSUFFICIENT_VOLUME",
    run: replayInputs.run,
    commands: replayInputs.commands,
    robotStatusSnapshot: replayInputs.robotStatusSnapshot,
    sessionState,
  });
  const actionSummary = decision.buildActionSummary({
    recoverySuggestion,
    run: replayInputs.run,
  });
  const params = actionSummary.params || {};
  const summary = {
    action: actionSummary.do_what,
    next_tool: params.same_liquid_source_substitution_next_tool || null,
    playbook: params.same_liquid_source_substitution_playbook || null,
    required_gates: params.same_liquid_source_substitution_required_gates || [],
    same_liquid_source_candidate_count: params.same_liquid_source_candidate_count || 0,
    same_liquid_source_candidates: params.same_liquid_source_candidates || [],
    same_liquid_auto_resume_eligible: params.same_liquid_auto_resume_eligible === true,
    same_liquid_auto_resume_blocker: params.same_liquid_auto_resume_blocker || null,
    blocked_auto_recovery_reason: params.blocked_auto_recovery_reason || null,
    source_map_key: params.source_map_key || null,
    source_map_expected_presence: params.source_map_expected_presence ?? null,
    observed_liquid_presence: params.observed_liquid_presence ?? null,
    cleanup_required: params.cleanup_required || [],
    blockers: params.blockers || [],
  };
  const status =
    actionSummary.do_what === "manual_only" &&
    summary.next_tool === "prepare_liquid_source_substitution_recovery" &&
    summary.same_liquid_source_candidate_count > 0 &&
    summary.same_liquid_auto_resume_eligible === false
      ? "passed"
      : "needs_attention";
  const payload = {
    status,
    session_id: args.session_id,
    run_id: args.run_id,
    failed_source_key: source.source_key,
    source_map_entry: sourceMapEntry,
    no_robot_motion: true,
    output_path: outPath,
    markdown_path: markdownPath,
    replay_inputs: replayInputs,
    recovery: recoverySuggestion,
    action_summary: actionSummary,
    summary,
    result_log_entry_id: null,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const entry = resultLog.appendResultLogEntry({
    session_id: args.session_id,
    run_id: args.run_id,
    tool_name: "export_liquid_failure_replay",
    event_kind: "liquid_failure_replay",
    status,
    summary: `${source.source_key} liquid failure replay -> ${summary.next_tool || "no_fixed_playbook"}`,
    requires_attention: status !== "passed",
    data: {
      output_path: outPath,
      markdown_path: markdownPath,
      failed_source_key: source.source_key,
      no_robot_motion: true,
      action: summary.action,
      next_tool: summary.next_tool,
      playbook: summary.playbook,
      required_gates: summary.required_gates,
      same_liquid_source_candidate_count: summary.same_liquid_source_candidate_count,
      same_liquid_source_candidates: summary.same_liquid_source_candidates,
      same_liquid_auto_resume_eligible: summary.same_liquid_auto_resume_eligible,
      same_liquid_auto_resume_blocker: summary.same_liquid_auto_resume_blocker,
      blocked_auto_recovery_reason: summary.blocked_auto_recovery_reason,
      source_map_expected_presence: summary.source_map_expected_presence,
      observed_liquid_presence: summary.observed_liquid_presence,
      cleanup_required: summary.cleanup_required,
      blockers: summary.blockers,
    },
  });
  payload.result_log_entry_id = entry.entry_id;
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
  if (markdownPath) {
    fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
    fs.writeFileSync(markdownPath, renderMarkdown(payload));
  }

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = status === "passed" ? 0 : 1;
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
