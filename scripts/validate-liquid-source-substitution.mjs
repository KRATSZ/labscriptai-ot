#!/usr/bin/env node
/**
 * Build a no-motion liquid source-substitution validation bundle.
 *
 * This chains the fixed-source planner, validation protocol generator, local
 * simulation gate, and result-log recording. It never uploads, plays, homes, or
 * moves the robot.
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
    failed_source_key: null,
    failed_slot_name: null,
    failed_well_name: null,
    preferred_source_key: null,
    pipette_name: null,
    mount: null,
    tiprack_load_name: null,
    tiprack_slot: null,
    output_protocol_path: null,
    out: null,
    markdown_out: null,
    python_executable: process.env.OPENTRONS_PYTHON || null,
    skip_simulation: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--session-id") {
      args.session_id = argv[index + 1];
      index += 1;
    } else if (item === "--failed-source-key") {
      args.failed_source_key = argv[index + 1];
      index += 1;
    } else if (item === "--failed-slot-name") {
      args.failed_slot_name = argv[index + 1];
      index += 1;
    } else if (item === "--failed-well-name") {
      args.failed_well_name = argv[index + 1];
      index += 1;
    } else if (item === "--preferred-source-key") {
      args.preferred_source_key = argv[index + 1];
      index += 1;
    } else if (item === "--pipette-name") {
      args.pipette_name = argv[index + 1];
      index += 1;
    } else if (item === "--mount") {
      args.mount = argv[index + 1];
      index += 1;
    } else if (item === "--tiprack-load-name") {
      args.tiprack_load_name = argv[index + 1];
      index += 1;
    } else if (item === "--tiprack-slot") {
      args.tiprack_slot = argv[index + 1];
      index += 1;
    } else if (item === "--output-protocol-path") {
      args.output_protocol_path = argv[index + 1];
      index += 1;
    } else if (item === "--out") {
      args.out = argv[index + 1];
      index += 1;
    } else if (item === "--markdown-out") {
      args.markdown_out = argv[index + 1];
      index += 1;
    } else if (item === "--python-executable") {
      args.python_executable = argv[index + 1];
      index += 1;
    } else if (item === "--skip-simulation") {
      args.skip_simulation = true;
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

function resolveBundlePath(args) {
  if (args.out) {
    return path.resolve(args.out);
  }
  return path.join(
    DEFAULT_OUT_DIR,
    `liquid-source-substitution-validation-${safeFilePart(args.failed_source_key)}-${timestampForFile()}-${randomUUID()}.json`,
  );
}

function resolveProtocolPath(args) {
  if (args.output_protocol_path) {
    return path.resolve(args.output_protocol_path);
  }
  const failed = safeFilePart(args.failed_source_key || `${args.failed_slot_name || "source"}-${args.failed_well_name || "well"}`);
  const preferred = safeFilePart(args.preferred_source_key || "replacement");
  return path.join(
    DEFAULT_OUT_DIR,
    `liquid-source-substitution-${failed}-to-${preferred}-validation.py`,
  );
}

function requiredArg(args, key, flag) {
  if (!args[key]) {
    throw new Error(`${flag} is required.`);
  }
}

function buildStatus({ generated, simulationParse, skipped, semanticInvariants = null }) {
  if (generated?.data?.plan?.status !== "planned") {
    return "blocked";
  }
  if (Number(semanticInvariants?.experiment_intent_violation_count || 0) > 0) {
    return "blocked";
  }
  if (skipped) {
    return "needs_simulation";
  }
  return simulationParse?.status === "passed" ? "passed" : "blocked";
}

function buildDecision({ status, generated, simulationParse, skipped, semanticInvariants = null }) {
  const selectedSourceKey = generated?.data?.plan?.selected_source_key || null;
  const failedSourceKey = generated?.data?.plan?.failed_source_key || null;
  const simulationPassed = simulationParse?.status === "passed";
  const planAutoResumeEligible = generated?.data?.plan?.auto_resume_eligible === true;
  const base = {
    validation_passed: status === "passed",
    replacement_source_validated: status === "passed" ? selectedSourceKey : null,
    failed_source_key: failedSourceKey,
    selected_source_key: selectedSourceKey,
    auto_resume_eligible: false,
    live_execution_allowed: false,
    live_protocol_run_allowed: false,
    no_robot_motion: true,
    next_tool: null,
    blocked_reason: null,
    required_operator_gate: "run_protocol_only_after_operator_opt_in",
    required_next_gates: [
      "live_liquid_recovery_gate",
      "run_protocol_only_after_operator_opt_in",
    ],
    semantic_invariant_status: semanticInvariants?.status || null,
    experiment_intent_violation_count:
      semanticInvariants?.experiment_intent_violation_count ?? null,
    semantic_gate_blocker_count: semanticInvariants?.gate_blocker_count ?? null,
  };

  if (generated?.data?.plan?.status !== "planned") {
    return {
      ...base,
      blocked_reason: generated?.data?.plan?.blocked_reason || "substitution_plan_not_ready",
      next_tool: "record_liquid_source_map",
    };
  }
  if (Number(semanticInvariants?.experiment_intent_violation_count || 0) > 0) {
    return {
      ...base,
      blocked_reason: "experiment_intent_invariant_failed",
      next_tool: "inspect_semantic_invariants",
    };
  }
  if (skipped) {
    return {
      ...base,
      blocked_reason: "simulation_not_run",
      next_tool: "simulate_protocol",
    };
  }
  if (!simulationPassed) {
    return {
      ...base,
      blocked_reason: simulationParse?.primary_issue?.category || simulationParse?.status || "simulation_failed",
      next_tool: "inspect_simulation_output",
    };
  }
  return {
    ...base,
    auto_resume_eligible: planAutoResumeEligible,
    blocked_reason: "live_gate_and_operator_opt_in_required_before_any_robot_motion",
    next_tool: "live_liquid_recovery_gate",
  };
}

function renderMarkdown(payload) {
  const lines = [
    "# Liquid Source Substitution Validation",
    "",
    `Status: \`${payload.status}\``,
    `Session: \`${payload.session_id}\``,
    `Failed source: \`${payload.failed_source_key || "unknown"}\``,
    `Selected source: \`${payload.selected_source_key || "none"}\``,
    `No robot motion: \`${payload.no_robot_motion ? "true" : "false"}\``,
    `Result log entry: \`${payload.result_log_entry_id || "pending"}\``,
    "",
    "## Artifacts",
    "",
    `- Bundle: \`${payload.output_path}\``,
    `- Protocol: \`${payload.generated_protocol_path || "none"}\``,
    "",
    "## Gates",
    "",
    `- Simulation skipped: \`${payload.simulation.skipped ? "true" : "false"}\``,
    `- Simulation status: \`${payload.simulation.parsed?.status || "not_run"}\``,
    `- Simulation issue count: \`${payload.simulation.parsed?.issue_count ?? "not_run"}\``,
    `- Liquid guard status: \`${payload.liquid_guard_analysis?.status || "unknown"}\``,
    `- First aspirate guarded: \`${payload.liquid_guard_analysis?.first_aspirate_guarded === false ? "false" : "true"}\``,
    `- Aspirate calls: \`${payload.liquid_guard_analysis?.aspirate_count ?? "unknown"}\``,
    `- Dispense calls: \`${payload.liquid_guard_analysis?.dispense_count ?? "unknown"}\``,
    `- Auto resume eligible: \`${payload.decision.auto_resume_eligible ? "true" : "false"}\``,
    `- Live execution allowed: \`${payload.decision.live_execution_allowed ? "true" : "false"}\``,
    `- Semantic invariant status: \`${payload.decision.semantic_invariant_status || "unknown"}\``,
    `- Experiment intent violations: \`${payload.decision.experiment_intent_violation_count ?? "unknown"}\``,
    `- Next tool: \`${payload.decision.next_tool || "none"}\``,
    `- Blocked reason: \`${payload.decision.blocked_reason || "none"}\``,
    "",
    "## Boundary",
    "",
    "- This bundle validates only the replacement source presence protocol.",
    "- It does not upload, play, resume, aspirate, or dispense.",
    "- Live use still requires `live_liquid_recovery_gate` and explicit operator opt-in.",
    "",
  ];
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  requiredArg(args, "failed_source_key", "--failed-source-key");
  requiredArg(args, "pipette_name", "--pipette-name");
  requiredArg(args, "mount", "--mount");
  requiredArg(args, "tiprack_load_name", "--tiprack-load-name");
  requiredArg(args, "tiprack_slot", "--tiprack-slot");

  const outPath = resolveBundlePath(args);
  const markdownPath = args.markdown_out ? path.resolve(args.markdown_out) : null;
  const protocolPath = resolveProtocolPath(args);
  const server = await import(path.join(PLUGIN_ROOT, "servers", "opentrons-mcp", "index.js"));
  const liquidSubstitution = await import(path.join(
    PLUGIN_ROOT,
    "servers",
    "opentrons-mcp",
    "lib",
    "liquid-source-substitution.js",
  ));
  const resultLog = await import(path.join(PLUGIN_ROOT, "servers", "opentrons-mcp", "lib", "result-log.js"));

  const generationArgs = {
    session_id: args.session_id,
    failed_source_key: args.failed_source_key,
    failed_slot_name: args.failed_slot_name,
    failed_well_name: args.failed_well_name,
    preferred_source_key: args.preferred_source_key,
    pipette_name: args.pipette_name,
    mount: args.mount,
    tiprack_load_name: args.tiprack_load_name,
    tiprack_slot: args.tiprack_slot,
    output_path: protocolPath,
  };
  const generated = await server.TOOL_HANDLERS.generate_liquid_source_substitution_protocol(generationArgs);
  const liquidGuardAnalysis = generated.data.validation_protocol.liquid_guard_analysis || null;

  let simulation = null;
  let simulationParse = null;
  if (!args.skip_simulation) {
    simulation = await server.TOOL_HANDLERS.simulate_protocol({
      protocol_path: generated.data.generated_protocol_path,
      ...(args.python_executable ? { python_executable: args.python_executable } : {}),
      max_log_chars: 12000,
    });
    const parsed = await server.TOOL_HANDLERS.parse_simulation_output({
      simulation_output_json: JSON.stringify(simulation.data),
    });
    simulationParse = parsed.data;
  }

  const semanticInvariants = liquidSubstitution.validateLiquidSourceSubstitutionInvariants({
    plan: generated.data.plan,
    validationProtocol: generated.data.validation_protocol,
    simulationParse,
    liveGatePassed: false,
    operatorOptIn: false,
    liveExecutionAllowed: false,
    liveProtocolRunAllowed: false,
  });
  const status = buildStatus({
    generated,
    simulationParse,
    skipped: args.skip_simulation,
    semanticInvariants,
  });
  const decision = buildDecision({
    status,
    generated,
    simulationParse,
    skipped: args.skip_simulation,
    semanticInvariants,
  });
  const noRobotMotion = true;
  const logEntry = resultLog.appendResultLogEntry({
    session_id: args.session_id,
    run_id: null,
    tool_name: "validate_liquid_source_substitution_cli",
    event_kind: "liquid_source_substitution_validation_bundle",
    status,
    protocol_path: generated.data.generated_protocol_path,
    requires_attention: status !== "passed",
    summary:
      status === "passed"
        ? `Liquid source substitution validation bundle passed for ${generated.data.plan.failed_source_key} -> ${generated.data.plan.selected_source_key}.`
        : `Liquid source substitution validation bundle not ready: ${status}.`,
    data: {
      output_path: outPath,
      markdown_path: markdownPath,
      generated_protocol_path: generated.data.generated_protocol_path,
      failed_source_key: generated.data.plan.failed_source_key,
      selected_source_key: generated.data.plan.selected_source_key,
      candidate_count: generated.data.plan.candidate_count,
      no_robot_motion: noRobotMotion,
      no_aspirate_or_dispense: generated.data.validation_protocol.no_aspirate_or_dispense,
      liquid_guard_analysis: liquidGuardAnalysis,
      semantic_invariants: semanticInvariants,
      simulation_skipped: args.skip_simulation,
      simulation_ok: simulation?.data?.ok ?? null,
      simulation_status: simulationParse?.status || null,
      simulation_issue_count: simulationParse?.issue_count ?? null,
      decision,
      next_required_gates: [
        "live_liquid_recovery_gate",
        "run_protocol_only_after_operator_opt_in",
      ],
    },
  });

  const payload = {
    status,
    session_id: args.session_id,
    output_path: outPath,
    markdown_path: markdownPath,
    result_log_entry_id: logEntry.entry_id,
    result_log_entry: logEntry,
    failed_source_key: generated.data.plan.failed_source_key,
    selected_source_key: generated.data.plan.selected_source_key,
    generated_protocol_path: generated.data.generated_protocol_path,
    no_robot_motion: noRobotMotion,
    no_aspirate_or_dispense: generated.data.validation_protocol.no_aspirate_or_dispense,
    liquid_guard_analysis: liquidGuardAnalysis,
    semantic_invariants: semanticInvariants,
    decision,
    generation: generated.data,
    simulation: {
      skipped: args.skip_simulation,
      raw: simulation?.data || null,
      parsed: simulationParse,
    },
    next_required_gates: [
      "live_liquid_recovery_gate",
      "run_protocol_only_after_operator_opt_in",
    ],
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
    generated_protocol_path: generated.data.generated_protocol_path,
    result_log_entry_id: logEntry.entry_id,
    simulation_status: simulationParse?.status || null,
    simulation_ok: simulation?.data?.ok ?? null,
    decision,
    semantic_invariant_status: semanticInvariants.status,
    experiment_intent_violation_count: semanticInvariants.experiment_intent_violation_count,
    no_robot_motion: noRobotMotion,
    liquid_guard_status: liquidGuardAnalysis?.status || null,
  }, null, 2));

  process.exit(status === "blocked" ? 2 : 0);
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
