const DASHBOARD_LEAVES = new Set([
  "DOOR_OPEN",
  "ESTOP_ENGAGED",
  "MODULE_NOT_READY",
  "INSTRUMENT_NOT_READY",
  "ROBOT_UNREACHABLE",
]);

const VISION_LEAVES = new Set([
  "LABWARE_MISMATCH",
  "DECK_COLLISION",
  "SESSION_NEEDS_RECONCILIATION",
  "DESTINATION_OCCUPIED",
  "DESTINATION_UNAVAILABLE",
  "SLOT_NOT_ADDRESSABLE",
  "STATE_MISMATCH",
]);

const PROBE_LEAVES = new Set([
  "INSUFFICIENT_VOLUME",
  "AIR_BUBBLE",
  "LIQUID_PROPERTY_ERROR",
  "TIP_CLOG",
]);

const TIP_LEAVES = new Set(["TIP_PHYSICALLY_MISSING"]);

const CHANNEL_TOOLS = Object.freeze({
  dashboard: [
    "robot_status",
    "module_status",
    "live_readiness_check",
    "safe_next_action",
    "is_home_safe",
  ],
  vision: [
    "camera_status",
    "capture_preview_image",
    "deck_vision_check",
    "vision_check",
    "analyze_image_with_ark",
    "reconcile_state",
  ],
  probe: [
    "live_liquid_recovery_gate",
    "list_critical_probe_targets",
    "probe_wells",
    "apply_liquid_probe_results",
    "get_liquid_source_map",
  ],
  tip: ["recover_tip_pickup", "suggest_next_tip_well", "list_tip_candidates"],
  manual: ["safe_next_action", "parse_error", "experiment_history"],
});

export function resolveRecoveryChannel(errorLeaf = null) {
  const leaf = String(errorLeaf || "UNKNOWN_NEEDS_HUMAN").trim().toUpperCase();
  if (DASHBOARD_LEAVES.has(leaf)) {
    return "dashboard";
  }
  if (VISION_LEAVES.has(leaf)) {
    return "vision";
  }
  if (PROBE_LEAVES.has(leaf)) {
    return "probe";
  }
  if (TIP_LEAVES.has(leaf)) {
    return "tip";
  }
  return "manual";
}

export function buildRecoveryRoutingGuidance({
  errorLeaf = null,
  recoverySuggestion = null,
} = {}) {
  const leaf =
    errorLeaf ||
    recoverySuggestion?.error_leaf ||
    recoverySuggestion?.error_category ||
    "UNKNOWN_NEEDS_HUMAN";
  const channel = resolveRecoveryChannel(leaf);
  const recommendedNextTools = [...(CHANNEL_TOOLS[channel] || CHANNEL_TOOLS.manual)];

  const guidance = {
    recovery_channel: channel,
    recovery_channel_label:
      channel === "dashboard"
        ? "仪表盘"
        : channel === "vision"
          ? "眼睛"
          : channel === "probe"
            ? "手指"
            : channel === "tip"
              ? "手指(tip)"
              : "人工",
    recommended_next_tools: recommendedNextTools,
    channel_rationale:
      channel === "dashboard"
        ? "门/急停/模块/锁状态先用 HTTP 仪表盘确认，不用相机。"
        : channel === "vision"
          ? "台面移位或 labware 不一致时拍照 + YOLO/VLM 第二意见，再 reconcile。"
          : channel === "probe"
            ? "液体空/气泡等问题用 targeted probe_wells，不用 VLM。"
            : channel === "tip"
              ? "缺 tip 走 tip 恢复分支。"
              : "无安全自动分支，停止并人工判断。",
  };

  if (recoverySuggestion?.hard_stop) {
    guidance.resume_allowed = false;
    guidance.operator_steps = [
      "停止自动恢复。",
      "按 recovery_channel 完成物理检查。",
      "重新走 live_readiness_check 后再决定是否 resume。",
    ];
  }

  return guidance;
}

export function enrichRecoverySuggestion(recoverySuggestion = {}) {
  const routing = buildRecoveryRoutingGuidance({ recoverySuggestion });
  return {
    ...recoverySuggestion,
    ...routing,
    default_next_step: routing.recommended_next_tools[0] || "safe_next_action",
  };
}
