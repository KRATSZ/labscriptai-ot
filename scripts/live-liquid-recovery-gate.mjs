#!/usr/bin/env node
/**
 * Read-only gate before live liquid runtime-recovery tests.
 *
 * This script intentionally does not create runs, enqueue commands, home axes,
 * or move the robot. It verifies the local recovery logic and live physical
 * blockers that must be cleared before liquid watcher/probe re-runs.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(process.env.OPENTRONS_PLUGIN_ROOT || path.join(__dirname, ".."));
const DEFAULT_OUT_DIR = path.join(PLUGIN_ROOT, "runs", "self-recovery", "artifacts");
const DEFAULT_SESSION_ID = "self-recovery-liquid";
const KNOWN_SOURCE_PLANS = new Set(["c3_d3_liquid_recovery"]);

function parseExpectedPresence(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["true", "present", "yes", "1"].includes(normalized)) {
    return { value: true, valid: true };
  }
  if (["false", "absent", "no", "0"].includes(normalized)) {
    return { value: false, valid: true };
  }
  return { value: null, valid: false };
}

function parseRequiredSource(value) {
  const [location, expectedRaw] = String(value || "").split("=");
  const [slotName, wellName] = String(location || "").split(".");
  const expectedPresence = expectedRaw === undefined
    ? { value: null, valid: true }
    : parseExpectedPresence(expectedRaw);
  return {
    slot_name: slotName || null,
    well_name: wellName || null,
    expected_presence: expectedPresence.value,
    invalid_reason: expectedPresence.valid
      ? null
      : `Unsupported expected_presence value: ${expectedRaw}`,
  };
}

function parseArgs(argv) {
  const args = {
    robot_ip: process.env.OPENTRONS_HOST || "192.168.66.102",
    session_id: process.env.OPENTRONS_SESSION_ID || DEFAULT_SESSION_ID,
    source_plan: null,
    required_sources: [],
    out: null,
    operator_request_json_out: null,
    operator_request_md_out: null,
    allow_observed_mismatch_reprobe: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--robot-ip") {
      args.robot_ip = argv[index + 1];
      index += 1;
    } else if (item === "--session-id") {
      args.session_id = argv[index + 1];
      index += 1;
    } else if (item === "--source-plan") {
      args.source_plan = argv[index + 1];
      index += 1;
    } else if (item === "--required-source") {
      args.required_sources.push(parseRequiredSource(argv[index + 1]));
      index += 1;
    } else if (item === "--out") {
      args.out = argv[index + 1];
      index += 1;
    } else if (item === "--operator-request-json-out") {
      args.operator_request_json_out = argv[index + 1];
      index += 1;
    } else if (item === "--operator-request-md-out") {
      args.operator_request_md_out = argv[index + 1];
      index += 1;
    } else if (item === "--allow-observed-mismatch-reprobe") {
      args.allow_observed_mismatch_reprobe = true;
    }
  }

  return args;
}

function check(name, status, summary, extra = {}) {
  return {
    name,
    status,
    summary,
    ...extra,
  };
}

function summarizeRuntimeSelfTestCoverage(selfTestData = {}) {
  return {
    expected_absent_source: {
      source_map_key: selfTestData.action_summary?.params?.source_map_key || null,
      source_map_expected_presence:
        selfTestData.action_summary?.params?.source_map_expected_presence ?? null,
      observed_liquid_presence:
        selfTestData.action_summary?.params?.observed_liquid_presence ?? null,
      manual_only: selfTestData.action_summary?.do_what === "manual_only",
      then_resume: selfTestData.action_summary?.then_resume ?? null,
    },
    expected_present_source: {
      source_map_key: selfTestData.expected_present_case?.action_summary?.params?.source_map_key || null,
      source_map_expected_presence:
        selfTestData.expected_present_case?.action_summary?.params?.source_map_expected_presence ?? null,
      observed_liquid_presence:
        selfTestData.expected_present_case?.action_summary?.params?.observed_liquid_presence ?? null,
      manual_only: selfTestData.expected_present_case?.action_summary?.do_what === "manual_only",
      then_resume: selfTestData.expected_present_case?.action_summary?.then_resume ?? null,
    },
  };
}

function summarizeRobot(robotStatus) {
  const data = robotStatus?.data || {};
  const attachedTips = (data.instruments_summary || [])
    .filter(instrument => instrument.mount && instrument.mount !== "extension" && instrument.tip_detected === true)
    .map(instrument => ({
      mount: instrument.mount,
      instrument_name: instrument.instrument_name || null,
      model: instrument.model || null,
      serial: instrument.serial || null,
    }));

  return {
    robot_reachable: data.robot_reachable === true,
    health_summary: data.health_summary || {},
    door: data.door || {},
    estop: data.estop || {},
    blockers: data.blockers || [],
    attached_tips: attachedTips,
  };
}

function normalizeLiquidGateSourceRequirement(source = {}) {
  const slotName = source.slot_name || source.slotName;
  const wellName = source.well_name || source.wellName;
  const slot = slotName ? String(slotName).trim().toUpperCase() : null;
  const well = wellName ? String(wellName).trim().toUpperCase() : null;
  return {
    slot_name: slot,
    well_name: well,
    key: slot && well ? `${slot}.${well}` : null,
    expected_presence: source.expected_presence ?? source.expectedPresence ?? null,
    invalid_reason: source.invalid_reason || source.invalidReason || null,
  };
}

function expandLiquidGateSourcePlan(sourcePlan = null) {
  if (!sourcePlan) {
    return [];
  }

  switch (String(sourcePlan)) {
    case "c3_d3_liquid_recovery":
      return [
        { slot_name: "C3", well_name: "A1", expected_presence: true },
        ...["A", "B", "C", "D", "E", "F", "G", "H"].map(row => ({
          slot_name: "D3",
          well_name: `${row}1`,
          expected_presence: true,
        })),
        { slot_name: "D3", well_name: "A12", expected_presence: false },
      ];
    default:
      return [];
  }
}

function resolveRequiredSources({ sourcePlan = null, requiredSources = [] } = {}) {
  const normalizedPlan = sourcePlan ? String(sourcePlan) : null;
  const invalidSourcePlan = normalizedPlan && !KNOWN_SOURCE_PLANS.has(normalizedPlan) ? normalizedPlan : null;
  return {
    requiredSources: invalidSourcePlan
      ? [...requiredSources]
      : [...expandLiquidGateSourcePlan(normalizedPlan), ...requiredSources],
    invalidSourcePlan,
  };
}

function buildSourceMapCheck(sessionState = {}, requiredSources = [], { allowObservedMismatchReprobe = false } = {}) {
  const requirements = requiredSources.map(normalizeLiquidGateSourceRequirement);
  const sources = sessionState?.liquid_tracking?.sources || {};
  const details = requirements.map(requirement => {
    const entry = requirement.key ? sources[requirement.key] || null : null;
    const expectedPresenceMatches =
      requirement.expected_presence === null ||
      (entry && entry.expected_presence === requirement.expected_presence);
    const observedPresenceMatches =
      requirement.expected_presence === null ||
      !entry ||
      entry.observed_presence !== false ||
      requirement.expected_presence === false;
    return {
      ...requirement,
      present_in_source_map: Boolean(entry),
      expected_presence_matches: Boolean(entry && expectedPresenceMatches),
      observed_presence_matches: Boolean(entry && observedPresenceMatches),
      liquid_name: entry?.liquid_name || null,
      sample_id: entry?.sample_id || null,
      actual_expected_presence: entry?.expected_presence ?? null,
      observed_presence: entry?.observed_presence ?? null,
      observed_run_id: entry?.observed_run_id || null,
    };
  });
  const invalidRequirements = details.filter(detail => !detail.key || detail.invalid_reason);
  const missingSources = details.filter(detail => detail.key && !detail.present_in_source_map);
  const mismatchedPresence = details.filter(
    detail => detail.present_in_source_map && detail.expected_presence_matches === false,
  );
  const observedPresenceMismatches = details.filter(
    detail => detail.present_in_source_map && detail.observed_presence_matches === false,
  );
  const observedMismatchReprobeAllowed =
    allowObservedMismatchReprobe &&
    observedPresenceMismatches.length > 0 &&
    invalidRequirements.length === 0 &&
    missingSources.length === 0 &&
    mismatchedPresence.length === 0;
  const failures = [
    ...invalidRequirements,
    ...missingSources,
    ...mismatchedPresence,
    ...(observedMismatchReprobeAllowed ? [] : observedPresenceMismatches),
  ];

  if (requirements.length === 0) {
    return check("source_map_requirements", "pass", "No source-map requirements were requested for this gate.", {
      required_sources: [],
    });
  }

  return check(
    "source_map_requirements",
    failures.length === 0 ? (observedMismatchReprobeAllowed ? "warn" : "pass") : "fail",
    failures.length === 0
      ? observedMismatchReprobeAllowed
        ? "Requested source-map entries are present, but live observations disagree; only targeted no-aspirate re-probe is allowed."
        : "All requested liquid source-map entries are present and match expected presence."
      : "One or more requested liquid source-map entries are missing or do not match expected presence.",
    {
      required_sources: details,
      missing_source_keys: missingSources.map(detail => detail.key),
      mismatched_presence_keys: mismatchedPresence.map(detail => detail.key),
      observed_presence_mismatch_keys: observedPresenceMismatches.map(detail => detail.key),
      observed_mismatch_reprobe_allowed: observedMismatchReprobeAllowed,
      allowed_probe_targets: observedMismatchReprobeAllowed
        ? observedPresenceMismatches.map(detail => detail.key)
        : [],
      invalid_requirements: invalidRequirements,
    },
  );
}

function buildSourceIdentityOperatorGuidance(sessionId = DEFAULT_SESSION_ID) {
  return {
    draft_markdown_path: "runs/self-recovery/artifacts/liquid-source-identity-draft.md",
    draft_json_path: "runs/self-recovery/artifacts/liquid-source-identity-draft.json",
    draft_tsv_path: "runs/self-recovery/artifacts/liquid-source-identity-draft.tsv",
    validation_report_path: "runs/self-recovery/artifacts/liquid-source-identity-md-validation-latest.json",
    generate_draft_command: [
      "node scripts/summarize-liquid-source-map.mjs",
      `--session-id ${sessionId}`,
      "--out runs/self-recovery/artifacts/liquid-source-map-summary-with-md-latest.json",
      "--template-json-out runs/self-recovery/artifacts/liquid-source-identity-draft.json",
      "--template-tsv-out runs/self-recovery/artifacts/liquid-source-identity-draft.tsv",
      "--template-md-out runs/self-recovery/artifacts/liquid-source-identity-draft.md",
    ].join(" "),
    validate_markdown_command: [
      "node scripts/summarize-liquid-source-map.mjs",
      `--session-id ${sessionId}`,
      "--validate-template-md runs/self-recovery/artifacts/liquid-source-identity-draft.md",
      "--report-out runs/self-recovery/artifacts/liquid-source-identity-md-validation-latest.json",
    ].join(" "),
    apply_markdown_command: [
      "node scripts/summarize-liquid-source-map.mjs",
      "--apply-template-md runs/self-recovery/artifacts/liquid-source-identity-draft.md",
      "--report-out runs/self-recovery/artifacts/liquid-source-identity-md-apply-latest.json",
    ].join(" "),
  };
}

function buildSourceIdentityMetadataCheck(sourceMapCheck = {}, { sessionId = DEFAULT_SESSION_ID } = {}) {
  const requiredSources = Array.isArray(sourceMapCheck.required_sources)
    ? sourceMapCheck.required_sources
    : [];
  const checkedSources = requiredSources.filter(
    source =>
      source.present_in_source_map &&
      source.expected_presence_matches !== false &&
      source.expected_presence === true,
  );
  const incompleteSources = checkedSources
    .map(source => {
      const missing = [];
      if (!source.liquid_name) {
        missing.push("liquid_name");
      } else if (source.liquid_name === "operator-confirmed-liquid") {
        missing.push("specific_liquid_name");
      }
      if (!source.sample_id) {
        missing.push("sample_id");
      }
      return missing.length > 0 ? { ...source, missing_identity_fields: missing } : null;
    })
    .filter(Boolean);

  return check(
    "source_identity_metadata",
    incompleteSources.length > 0 ? "warn" : "pass",
    incompleteSources.length > 0
      ? "Some expected-present liquid sources have incomplete liquid/sample identity metadata."
      : "Expected-present liquid sources include liquid and sample identity metadata.",
    {
      checked_source_count: checkedSources.length,
      incomplete_source_count: incompleteSources.length,
      incomplete_sources: incompleteSources,
      operator_guidance: incompleteSources.length > 0
        ? buildSourceIdentityOperatorGuidance(sessionId)
        : null,
    },
  );
}

function buildSourcePlanCheck(sourcePlan = null, invalidSourcePlan = null) {
  return check(
    "source_plan",
    invalidSourcePlan ? "fail" : "pass",
    invalidSourcePlan
      ? "Unknown source plan; refusing to treat it as an empty source requirement set."
      : "Source plan is recognized or not requested.",
    {
      requested_source_plan: sourcePlan || null,
      supported_source_plans: [...KNOWN_SOURCE_PLANS],
    },
  );
}

function buildNextAction({ failedCheckNames = [], warningCheckNames = [], manualGateNames = [] } = {}) {
  const failed = new Set(failedCheckNames);
  const warned = new Set(warningCheckNames);
  const manual = new Set(manualGateNames);

  if (failed.has("local_runtime_recovery_self_test")) {
    return {
      recommended_next_action: "reload_or_reinstall_mcp_runtime",
      allowed_next_tools: ["health_check", "runtime_recovery_self_test"],
      human_required: true,
      reason: "local_runtime_recovery_self_test_failed",
    };
  }
  if (failed.has("robot_readonly_connectivity")) {
    return {
      recommended_next_action: "restore_robot_connectivity",
      allowed_next_tools: ["health_check", "robot_status", "module_status"],
      human_required: true,
      reason: "robot_readonly_connectivity_failed",
    };
  }
  if (failed.has("door_and_estop")) {
    return {
      recommended_next_action: "resolve_door_or_estop",
      allowed_next_tools: ["robot_status"],
      human_required: true,
      reason: "door_or_estop_not_safe",
    };
  }
  if (failed.has("source_plan")) {
    return {
      recommended_next_action: "correct_gate_source_plan",
      allowed_next_tools: ["live_liquid_recovery_gate"],
      human_required: true,
      reason: "unknown_liquid_source_plan",
    };
  }
  if (failed.has("source_map_requirements")) {
    return {
      recommended_next_action: "record_or_correct_liquid_source_map",
      allowed_next_tools: ["record_liquid_source_map", "get_liquid_source_map", "live_liquid_recovery_gate"],
      human_required: true,
      reason: "required_liquid_sources_missing_or_mismatched",
    };
  }
  if (failed.has("no_attached_tip_before_liquid_probe_rerun")) {
    return {
      recommended_next_action: "clear_attached_tip_before_liquid_rerun",
      allowed_next_tools: ["robot_status", "live_liquid_recovery_gate", "experiment_history"],
      human_required: true,
      reason: "attached_tip_blocks_liquid_probe_rerun",
    };
  }
  if (warned.has("source_identity_metadata")) {
    return {
      recommended_next_action: "confirm_liquid_source_identity_before_semantic_recovery",
      allowed_next_tools: ["record_liquid_source_map", "get_liquid_source_map", "live_liquid_recovery_gate"],
      human_required: true,
      reason: "liquid_source_identity_metadata_incomplete",
    };
  }
  if (warned.has("source_map_requirements")) {
    return {
      recommended_next_action: "run_observed_mismatch_reprobe",
      allowed_next_tools: ["probe_wells", "apply_liquid_probe_results", "live_liquid_recovery_gate"],
      human_required: false,
      reason: "observed_presence_mismatch_reprobe_allowed",
    };
  }
  if (warned.has("module_blockers")) {
    return {
      recommended_next_action: "wait_or_resolve_module_blockers",
      allowed_next_tools: ["module_status", "live_liquid_recovery_gate"],
      human_required: false,
      reason: "module_blockers_reported",
    };
  }
  if (manual.has("mcp_client_reload")) {
    return {
      recommended_next_action: "verify_loaded_mcp_runtime",
      allowed_next_tools: ["health_check", "runtime_recovery_self_test", "live_liquid_recovery_gate"],
      human_required: true,
      reason: "standalone_gate_requires_loaded_mcp_client_confirmation",
    };
  }
  return {
    recommended_next_action: "run_live_liquid_recovery_tests",
    allowed_next_tools: ["runtime_watch_poll", "probe_wells", "run_protocol", "experiment_history"],
    human_required: false,
    reason: "live_liquid_recovery_gate_passed",
  };
}

function buildResolutionPlan({
  failedCheckNames = [],
  warningCheckNames = [],
  manualGateNames = [],
  checks = [],
  sessionId = DEFAULT_SESSION_ID,
} = {}) {
  const failed = new Set(failedCheckNames);
  const warned = new Set(warningCheckNames);
  const manual = new Set(manualGateNames);
  const checksByName = new Map(checks.map(item => [item.name, item]));
  const plan = [];
  const add = item => {
    plan.push({
      order: plan.length + 1,
      no_robot_motion: true,
      ...item,
    });
  };

  if (failed.has("local_runtime_recovery_self_test")) {
    add({
      check_name: "local_runtime_recovery_self_test",
      severity: "blocker",
      action: "reload_or_reinstall_mcp_runtime",
      human_required: true,
      allowed_next_tools: ["health_check", "runtime_recovery_self_test"],
      acceptance_criteria: [
        "Local runtime_recovery_self_test returns status=pass.",
        "health_check reports mcp_server.entrypoint under the expected labscriptai-ot clone root.",
        "health_check reports mcp_server.capabilities.runtime_build=liquid-source-map-v2.",
        "health_check reports mcp_server.required_runtime_tools.all_present=true.",
      ],
    });
  }
  if (failed.has("robot_readonly_connectivity")) {
    add({
      check_name: "robot_readonly_connectivity",
      severity: "blocker",
      action: "restore_robot_connectivity",
      human_required: true,
      allowed_next_tools: ["health_check", "robot_status", "module_status"],
      acceptance_criteria: ["robot_status can read 192.168.66.102 and reports robot_reachable=true."],
    });
  }
  if (failed.has("door_and_estop")) {
    add({
      check_name: "door_and_estop",
      severity: "blocker",
      action: "resolve_door_or_estop",
      human_required: true,
      allowed_next_tools: ["robot_status"],
      acceptance_criteria: ["Door is closed and estop is disengaged in robot_status."],
    });
  }
  if (failed.has("source_plan")) {
    add({
      check_name: "source_plan",
      severity: "blocker",
      action: "correct_gate_source_plan",
      human_required: true,
      allowed_next_tools: ["live_liquid_recovery_gate"],
      acceptance_criteria: [`source_plan is one of: ${[...KNOWN_SOURCE_PLANS].join(", ")}.`],
    });
  }
  if (failed.has("source_map_requirements")) {
    add({
      check_name: "source_map_requirements",
      severity: "blocker",
      action: "record_or_correct_liquid_source_map",
      human_required: true,
      allowed_next_tools: ["record_liquid_source_map", "get_liquid_source_map", "live_liquid_recovery_gate"],
      acceptance_criteria: [
        "All required source-map entries exist.",
        "Each required entry expected_presence matches the gate requirement.",
        "No required expected-present source has observed_presence=false from a live probe.",
      ],
    });
  }
  if (warned.has("source_map_requirements")) {
    const sourceMapCheck = checksByName.get("source_map_requirements") || {};
    add({
      check_name: "source_map_requirements",
      severity: "warning",
      action: "run_observed_mismatch_reprobe",
      human_required: false,
      allowed_next_tools: ["probe_wells", "apply_liquid_probe_results", "live_liquid_recovery_gate"],
      acceptance_criteria: [
        "Only probe wells listed in allowed_probe_targets.",
        "The probe protocol uses require_liquid_presence or detect_presence only.",
        "The probe protocol has no aspirate or dispense commands.",
        "Apply the probe result back to source-map observed_presence before any resume.",
      ],
      allowed_probe_targets: sourceMapCheck.allowed_probe_targets || [],
      caution: "This warning permits evidence collection only; it does not permit runtime_watch, run_protocol resume, aspirate, or dispense.",
    });
  }
  if (failed.has("no_attached_tip_before_liquid_probe_rerun")) {
    add({
      check_name: "no_attached_tip_before_liquid_probe_rerun",
      severity: "blocker",
      action: "clear_attached_tip_before_liquid_rerun",
      human_required: true,
      allowed_next_tools: ["robot_status", "live_liquid_recovery_gate", "experiment_history"],
      acceptance_criteria: ["robot_status reports no pipette with tip_detected=true."],
      caution: "Do not auto-home or run liquid tests while a tip remains attached after Stall/Collision.",
    });
  }
  if (warned.has("source_identity_metadata")) {
    const identityCheck = checksByName.get("source_identity_metadata");
    add({
      check_name: "source_identity_metadata",
      severity: "warning",
      action: "confirm_liquid_source_identity_before_semantic_recovery",
      human_required: true,
      allowed_next_tools: ["record_liquid_source_map", "get_liquid_source_map", "live_liquid_recovery_gate"],
      acceptance_criteria: [
        "C3.A1 and D3.A1-H1 expected-present sources have specific liquid_name.",
        "C3.A1 and D3.A1-H1 expected-present sources have sample_id.",
        "validate-template-md report has status=pass before apply.",
      ],
      operator_guidance:
        identityCheck?.operator_guidance || buildSourceIdentityOperatorGuidance(sessionId),
      inputs_needed: (identityCheck?.incomplete_sources || []).map(source => ({
        key: source.key || `${source.slot_name}.${source.well_name}`,
        slot_name: source.slot_name || null,
        well_name: source.well_name || null,
        current_liquid_name: source.liquid_name || null,
        current_sample_id: source.sample_id || null,
        missing_identity_fields: source.missing_identity_fields || [],
      })),
    });
  }
  if (warned.has("module_blockers")) {
    add({
      check_name: "module_blockers",
      severity: "warning",
      action: "wait_or_resolve_module_blockers",
      human_required: false,
      allowed_next_tools: ["module_status", "live_liquid_recovery_gate"],
      acceptance_criteria: ["module_status reports no blockers."],
    });
  }
  if (manual.has("mcp_client_reload")) {
    add({
      check_name: "mcp_client_reload",
      severity: "manual_gate",
      action: "verify_loaded_mcp_runtime",
      human_required: true,
      allowed_next_tools: ["health_check", "runtime_recovery_self_test", "live_liquid_recovery_gate"],
      acceptance_criteria: [
        "Actual MCP health_check exposes mcp_server.entrypoint under the expected labscriptai-ot clone root.",
        "Actual MCP health_check exposes mcp_server.capabilities.runtime_build=liquid-source-map-v2.",
        "Actual MCP health_check exposes mcp_server.required_runtime_tools.all_present=true.",
        "Actual MCP runtime_recovery_self_test returns status=pass.",
      ],
    });
  }

  if (plan.length === 0) {
    add({
      check_name: "live_liquid_recovery_gate",
      severity: "ready",
      action: "run_live_liquid_recovery_tests",
      human_required: false,
      no_robot_motion: false,
      allowed_next_tools: ["runtime_watch_poll", "probe_wells", "run_protocol", "experiment_history"],
      acceptance_criteria: [
        "D3 A12 empty-source watcher stops before aspirate and returns needs_user.",
        "C3.A1 and D3.A1-H1 positive liquid probes detect liquid as expected.",
      ],
    });
  }

  return plan;
}

function buildOperatorRequest(resolutionPlan = []) {
  const humanSteps = resolutionPlan.filter(step => step?.human_required === true);
  const requests = humanSteps.map(step => {
    const request = {
      order: step.order,
      check_name: step.check_name,
      severity: step.severity,
      action: step.action,
      no_robot_motion: step.no_robot_motion !== false,
      prompt: `Please resolve ${step.action}.`,
      prompt_zh: `请处理：${step.action}。`,
      allowed_next_tools: step.allowed_next_tools || [],
      acceptance_criteria: step.acceptance_criteria || [],
    };
    if (step.check_name === "no_attached_tip_before_liquid_probe_rerun") {
      request.request_type = "physical_state";
      request.prompt =
        "Please clear or confirm the left attached-tip state, then let the agent verify with robot_status.";
      request.prompt_zh =
        "请先清除或确认左侧移液器仍挂着的枪头状态；之后让我用 robot_status 只读复查。";
      request.safety_note = step.caution || null;
      request.safety_note_zh =
        "上一次清理遇到 Stall/Collision 后，不要自动 home，也不要继续跑液体测试。";
    } else if (step.check_name === "source_identity_metadata") {
      request.request_type = "liquid_identity";
      request.prompt =
        "Please fill exact liquid_name and sample_id for C3.A1 and D3.A1-H1 before semantic liquid recovery.";
      request.prompt_zh =
        "请补全 C3.A1 和 D3.A1-H1 的具体 liquid_name 与 sample_id；否则只能判断有液体，不能判断是不是正确液体。";
      request.artifacts = {
        draft_markdown_path: step.operator_guidance?.draft_markdown_path || null,
        validation_report_path: step.operator_guidance?.validation_report_path || null,
      };
      request.inputs_needed = Array.isArray(step.inputs_needed) ? step.inputs_needed : [];
      request.commands = {
        generate_draft_command: step.operator_guidance?.generate_draft_command || null,
        validate_markdown_command: step.operator_guidance?.validate_markdown_command || null,
        apply_markdown_command: step.operator_guidance?.apply_markdown_command || null,
      };
    } else if (step.check_name === "mcp_client_reload") {
      request.request_type = "runtime_reload";
      request.prompt =
        "Please reload the MCP client/plugin process, then verify health_check entrypoint, runtime_build, required_runtime_tools, and runtime_recovery_self_test in the actual client.";
      request.prompt_zh =
        "请重载 MCP 客户端或插件进程；之后我会在真实客户端里检查 health_check 的 entrypoint、runtime_build、required_runtime_tools，以及 runtime_recovery_self_test。";
    } else {
      request.request_type = "operator_action";
    }
    return request;
  });

  return {
    human_required: requests.length > 0,
    request_count: requests.length,
    summary:
      requests.length > 0
        ? "Human input is required before live liquid watcher/probe tests can continue."
        : "No operator input is required by the current gate result.",
    summary_zh:
      requests.length > 0
        ? "继续真机液体 watcher/probe 测试前，需要人先处理下面这些事项。"
        : "当前 gate 结果不需要人额外处理。",
    requests,
  };
}

function markdownCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function renderMissingIdentityFields(fields = []) {
  const labels = {
    liquid_name: "liquid_name",
    specific_liquid_name: "specific liquid_name",
    sample_id: "sample_id",
  };
  return fields.map(field => labels[field] || field).join(", ");
}

function renderOperatorRequestMarkdown({
  operatorRequest = {},
  gate = {},
  outputPath = null,
} = {}) {
  const requests = Array.isArray(operatorRequest.requests) ? operatorRequest.requests : [];
  const lines = [
    "# 真机液体自恢复操作请求",
    "",
    `Status: \`${gate.status || "unknown"}\``,
    `Session: \`${gate.session_id || DEFAULT_SESSION_ID}\``,
    `Robot: \`${gate.robot_ip || "unknown"}\``,
    `Source plan: \`${gate.source_plan || "none"}\``,
    `Result log entry: \`${gate.result_log_entry_id || "pending"}\``,
    "",
    operatorRequest.summary_zh || "没有可用的中文操作摘要。",
    "",
    operatorRequest.summary || "No operator request summary available.",
    "",
  ];

  if (requests.length === 0) {
    lines.push("当前 gate 结果不需要人工动作。", "");
  } else {
    lines.push("| 顺序 | 类型 | 严重性 | 需要人做什么 | 禁止机器运动 | 验收标准 |");
    lines.push("|---:|---|---|---|---:|---|");
    for (const request of requests) {
      lines.push(`| ${[
        request.order ?? "",
        request.request_type || "operator_action",
        request.severity || "",
        request.prompt_zh || request.prompt || request.action || "",
        request.no_robot_motion === false ? "否" : "是",
        (request.acceptance_criteria || []).join("<br>"),
      ].map(markdownCell).join(" | ")} |`);
    }
    lines.push("");
  }

  const liquidRequest = requests.find(request => request.request_type === "liquid_identity");
  if (Array.isArray(liquidRequest?.inputs_needed) && liquidRequest.inputs_needed.length > 0) {
    lines.push("## 需要补全的液体身份", "");
    lines.push("| Slot | Well | Current liquid_name | Current sample_id | Missing fields |");
    lines.push("|---|---|---|---|---|");
    for (const source of liquidRequest.inputs_needed) {
      lines.push(`| ${[
        source.slot_name || "",
        source.well_name || "",
        source.current_liquid_name || "",
        source.current_sample_id || "",
        renderMissingIdentityFields(source.missing_identity_fields || []),
      ].map(markdownCell).join(" | ")} |`);
    }
    lines.push("");
  }

  if (liquidRequest?.artifacts || liquidRequest?.commands) {
    lines.push("## 液体身份文件", "");
    if (liquidRequest.artifacts?.draft_markdown_path) {
      lines.push(`- 待填写草稿: \`${liquidRequest.artifacts.draft_markdown_path}\``);
    }
    if (liquidRequest.artifacts?.validation_report_path) {
      lines.push(`- 校验报告: \`${liquidRequest.artifacts.validation_report_path}\``);
    }
    if (liquidRequest.commands?.validate_markdown_command) {
      lines.push(`- 先校验: \`${liquidRequest.commands.validate_markdown_command}\``);
    }
    if (liquidRequest.commands?.apply_markdown_command) {
      lines.push(`- 校验通过后写入状态: \`${liquidRequest.commands.apply_markdown_command}\``);
    }
    lines.push("");
  }

  lines.push("## 安全边界", "");
  lines.push("- blocker 没处理并复查前，不跑真机液体 watcher/probe。");
  lines.push("- 表格里“禁止机器运动=是”的请求，不允许自动 home，也不允许移动机器人。");
  lines.push("- 液体身份没补全前，只能做“有无液体”的判断，不能做自动换源或样本相关续跑。");
  if (outputPath) {
    lines.push(`- 本请求文件: \`${outputPath}\``);
  }
  lines.push("");
  return lines.join("\n");
}

function buildGate({
  robotIp,
  sessionId,
  sourcePlan,
  invalidSourcePlan,
  requiredSources,
  selfTest,
  robotStatus,
  moduleStatus,
  sessionState,
  errors,
  allowObservedMismatchReprobe = false,
}) {
  const robot = summarizeRobot(robotStatus);
  const moduleBlockers = moduleStatus?.data?.blockers || [];
  const checks = [];

  checks.push(
    check(
      "local_runtime_recovery_self_test",
      selfTest?.data?.status === "pass" ? "pass" : "fail",
      selfTest?.data?.status === "pass"
        ? "Local recovery logic classifies empty-source liquid errors as manual-only."
        : "Local recovery self-test failed.",
      {
        runtime_build: selfTest?.data?.runtime_build || null,
        failed_checks: selfTest?.data?.failed_checks || [],
        coverage: summarizeRuntimeSelfTestCoverage(selfTest?.data || {}),
      },
    ),
  );

  checks.push(buildSourcePlanCheck(sourcePlan, invalidSourcePlan));
  const sourceMapCheck = buildSourceMapCheck(sessionState, requiredSources, {
    allowObservedMismatchReprobe,
  });
  checks.push(sourceMapCheck);
  checks.push(buildSourceIdentityMetadataCheck(sourceMapCheck, { sessionId }));

  checks.push(
    check(
      "robot_readonly_connectivity",
      robot.robot_reachable ? "pass" : "fail",
      robot.robot_reachable ? "Robot read-only status endpoints are reachable." : "Robot read-only status failed.",
      {
        robot_ip: robotIp,
        health_summary: robot.health_summary,
        error: errors.robot_status || null,
      },
    ),
  );

  checks.push(
    check(
      "door_and_estop",
      robot.door?.open === false && robot.estop?.engaged === false ? "pass" : "fail",
      "Door must be closed and estop disengaged before any live liquid test.",
      {
        door: robot.door,
        estop: robot.estop,
      },
    ),
  );

  checks.push(
    check(
      "no_attached_tip_before_liquid_probe_rerun",
      robot.attached_tips.length === 0 ? "pass" : "fail",
      robot.attached_tips.length === 0
        ? "No pipette reports an attached tip."
        : "At least one pipette still reports an attached tip; clear or explicitly accept this state before live liquid watcher re-run.",
      {
        attached_tips: robot.attached_tips,
      },
    ),
  );

  checks.push(
    check(
      "module_blockers",
      moduleBlockers.length === 0 ? "pass" : "warn",
      moduleBlockers.length === 0
        ? "No module blockers were reported."
        : "One or more module blockers were reported.",
      {
        blockers: moduleBlockers,
        error: errors.module_status || null,
      },
    ),
  );

  checks.push(
    check(
      "mcp_client_reload",
      "manual_required",
      "Run MCP health_check in the actual client and require mcp_server.capabilities.runtime_build=liquid-source-map-v2 plus runtime_recovery_self_test.status=pass before trusting live watcher behavior.",
    ),
  );

  const blocking = checks.filter(item => item.status === "fail");
  const warnings = checks.filter(item => item.status === "warn");
  const manualGates = checks.filter(item => item.status === "manual_required");
  const failedCheckNames = blocking.map(item => item.name);
  const warningCheckNames = warnings.map(item => item.name);
  const manualGateNames = manualGates.map(item => item.name);
  const nextAction = buildNextAction({
    failedCheckNames,
    warningCheckNames,
    manualGateNames,
  });
  const resolutionPlan = buildResolutionPlan({
    failedCheckNames,
    warningCheckNames,
    manualGateNames,
    checks,
    sessionId,
  });
  const operatorRequest = buildOperatorRequest(resolutionPlan);

  return {
    timestamp: new Date().toISOString(),
    robot_ip: robotIp,
    session_id: sessionId,
    source_plan: sourcePlan || null,
    allow_observed_mismatch_reprobe: allowObservedMismatchReprobe,
    ok_for_live_liquid_rerun: blocking.length === 0 && manualGates.length === 0,
    status: blocking.length > 0 ? "blocked" : manualGates.length > 0 ? "needs_manual_gate" : warnings.length > 0 ? "warn" : "pass",
    checks,
    failed_checks: failedCheckNames,
    warning_checks: warningCheckNames,
    manual_gates: manualGateNames,
    ...nextAction,
    resolution_plan: resolutionPlan,
    operator_request: operatorRequest,
    next_steps: [
      failedCheckNames.includes("source_plan")
        ? `Use a supported source plan: ${[...KNOWN_SOURCE_PLANS].join(", ")}.`
        : null,
      failedCheckNames.includes("source_map_requirements")
        ? "Record or correct required liquid source-map entries before repeating liquid handling."
        : null,
      warningCheckNames.includes("source_map_requirements")
        ? "Only targeted no-aspirate re-probe is allowed for source-map/live-observation mismatches."
        : null,
      warningCheckNames.includes("source_identity_metadata")
        ? "Fill and validate runs/self-recovery/artifacts/liquid-source-identity-draft.md before semantic liquid recovery or source substitution."
        : null,
      robot.attached_tips.length > 0
        ? "Clear the attached pipette tip state before any liquid watcher/probe re-run."
        : null,
      "Reload the MCP client/plugin process.",
      "In the actual MCP client, verify health_check exposes entrypoint under the expected labscriptai-ot clone root.",
      "In the actual MCP client, verify health_check exposes runtime_build=liquid-source-map-v2.",
      "In the actual MCP client, verify health_check exposes required_runtime_tools.all_present=true.",
      "In the actual MCP client, run runtime_recovery_self_test and require status=pass.",
      "Only then re-run D3 A12 empty-source watcher and C3/D3 positive liquid probes.",
    ].filter(Boolean),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const server = await import(path.join(PLUGIN_ROOT, "servers", "opentrons-mcp", "index.js"));
  const { TOOL_HANDLERS } = server;
  const resultLog = await import(path.join(PLUGIN_ROOT, "servers", "opentrons-mcp", "lib", "result-log.js"));
  const errors = {};
  let selfTest = null;
  let robotStatus = null;
  let moduleStatus = null;
  let sessionState = null;
  const sourceRequirementResolution = resolveRequiredSources({
    sourcePlan: args.source_plan,
    requiredSources: args.required_sources,
  });
  const { requiredSources, invalidSourcePlan } = sourceRequirementResolution;

  try {
    selfTest = await TOOL_HANDLERS.runtime_recovery_self_test({});
  } catch (error) {
    errors.runtime_recovery_self_test = error?.message || String(error);
  }

  try {
    robotStatus = await TOOL_HANDLERS.robot_status({ robot_ip: args.robot_ip });
  } catch (error) {
    errors.robot_status = error?.message || String(error);
  }

  try {
    moduleStatus = await TOOL_HANDLERS.module_status({ robot_ip: args.robot_ip });
  } catch (error) {
    errors.module_status = error?.message || String(error);
  }

  try {
    const stateModule = await import(path.join(PLUGIN_ROOT, "servers", "opentrons-mcp", "lib", "state.js"));
    sessionState = stateModule.readSessionState(args.session_id);
  } catch (error) {
    errors.session_state = error?.message || String(error);
  }

  const gate = buildGate({
    robotIp: args.robot_ip,
    sessionId: args.session_id,
    sourcePlan: args.source_plan,
    invalidSourcePlan,
    requiredSources,
    selfTest,
    robotStatus,
    moduleStatus,
    sessionState,
    errors,
    allowObservedMismatchReprobe: args.allow_observed_mismatch_reprobe === true,
  });

  const outPath =
    args.out ||
    path.join(
      DEFAULT_OUT_DIR,
      `live-liquid-recovery-gate-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    );
  const operatorRequestJsonPath = args.operator_request_json_out
    ? path.resolve(args.operator_request_json_out)
    : null;
  const operatorRequestMdPath = args.operator_request_md_out
    ? path.resolve(args.operator_request_md_out)
    : null;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const logEntry = resultLog.appendResultLogEntry({
    session_id: args.session_id,
    run_id: null,
    tool_name: "live_liquid_recovery_gate_cli",
    event_kind: "live_readiness",
    status: gate.status,
    summary: gate.ok_for_live_liquid_rerun
      ? "Standalone live liquid recovery gate passed."
      : `Standalone live liquid recovery gate blocked: ${gate.failed_checks.join(", ") || gate.status}.`,
    robot_ip: args.robot_ip,
    state_revision: sessionState?.state_revision || 0,
    requires_attention: gate.ok_for_live_liquid_rerun === false || gate.human_required === true,
    data: {
      output_path: outPath,
      operator_request_json_path: operatorRequestJsonPath,
      operator_request_md_path: operatorRequestMdPath,
      ok_for_live_liquid_rerun: gate.ok_for_live_liquid_rerun,
      source_plan: gate.source_plan,
      failed_checks: gate.failed_checks,
      warning_checks: gate.warning_checks,
      manual_gates: gate.manual_gates,
      recommended_next_action: gate.recommended_next_action,
      allowed_next_tools: gate.allowed_next_tools,
      human_required: gate.human_required,
      resolution_plan: gate.resolution_plan,
      operator_request: gate.operator_request,
      next_steps: gate.next_steps,
      self_test_coverage:
        gate.checks.find(item => item.name === "local_runtime_recovery_self_test")?.coverage || null,
      source_map_requirements:
        gate.checks.find(item => item.name === "source_map_requirements")?.required_sources || [],
      source_identity_metadata:
        gate.checks.find(item => item.name === "source_identity_metadata") || null,
    },
  });
  const gateWithTrace = {
    ...gate,
    result_log_entry_id: logEntry.entry_id,
    result_log_entry: logEntry,
  };
  if (operatorRequestJsonPath) {
    fs.mkdirSync(path.dirname(operatorRequestJsonPath), { recursive: true });
    fs.writeFileSync(
      operatorRequestJsonPath,
      `${JSON.stringify({
        status: gateWithTrace.status,
        robot_ip: gateWithTrace.robot_ip,
        session_id: gateWithTrace.session_id,
        source_plan: gateWithTrace.source_plan,
        result_log_entry_id: gateWithTrace.result_log_entry_id,
        operator_request: gateWithTrace.operator_request,
      }, null, 2)}\n`,
    );
  }
  if (operatorRequestMdPath) {
    fs.mkdirSync(path.dirname(operatorRequestMdPath), { recursive: true });
    fs.writeFileSync(
      operatorRequestMdPath,
      renderOperatorRequestMarkdown({
        operatorRequest: gateWithTrace.operator_request,
        gate: gateWithTrace,
        outputPath: operatorRequestMdPath,
      }),
    );
  }
  fs.writeFileSync(outPath, `${JSON.stringify(gateWithTrace, null, 2)}\n`);

  console.log(JSON.stringify({
    status: gate.status,
    ok_for_live_liquid_rerun: gate.ok_for_live_liquid_rerun,
    output_path: outPath,
    result_log_entry_id: logEntry.entry_id,
    source_plan: gate.source_plan,
    failed_checks: gate.failed_checks,
    warning_checks: gate.warning_checks,
    manual_gates: gate.manual_gates,
    recommended_next_action: gate.recommended_next_action,
    allowed_next_tools: gate.allowed_next_tools,
    human_required: gate.human_required,
    resolution_plan: gate.resolution_plan,
    operator_request: gate.operator_request,
    operator_request_json_path: operatorRequestJsonPath,
    operator_request_md_path: operatorRequestMdPath,
    next_steps: gate.next_steps,
  }, null, 2));

  process.exit(gate.status === "pass" ? 0 : 2);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
