const ESCALATION_UNCERTAINTIES = new Set([
  "low_confidence",
  "ambiguous_class",
  "invalid_vision_json",
  "vision_process_failed",
  "uncertain_slot",
]);

export function isPreflightVisionEnabled() {
  const flag = String(process.env.OPENTRONS_PREFLIGHT_VISION || "on").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(flag);
}

export function resolveVlmProvider({ provider = null } = {}) {
  const resolved = String(provider || process.env.OPENTRONS_VLM_PROVIDER || "ark")
    .trim()
    .toLowerCase();
  if (["off", "none", "false", "0"].includes(resolved)) {
    return "off";
  }
  if (resolved === "kimi") {
    return "kimi";
  }
  return "ark";
}

export function shouldEscalateToVlm(visionResult = {}, { force = false } = {}) {
  if (force) {
    return { escalate: true, reasons: ["forced_by_operator"] };
  }

  const reasons = [];
  const uncertainties = Array.isArray(visionResult.uncertainties) ? visionResult.uncertainties : [];
  for (const item of uncertainties) {
    const normalized = String(item || "").toLowerCase();
    if (
      ESCALATION_UNCERTAINTIES.has(normalized) ||
      normalized.includes("low_confidence") ||
      normalized.includes("ambiguous") ||
      normalized.includes("uncertain")
    ) {
      reasons.push(`uncertainty:${item}`);
    }
  }

  const mismatches = Array.isArray(visionResult.mismatches) ? visionResult.mismatches : [];
  if (mismatches.length > 0) {
    for (const mismatch of mismatches) {
      reasons.push(`mismatch:${mismatch.slot}:${mismatch.reason || "unknown"}`);
    }
  }

  if (visionResult.summary && String(visionResult.summary).toLowerCase().includes("failed")) {
    reasons.push("vision_summary_failed");
  }

  return {
    escalate: reasons.length > 0,
    reasons,
  };
}

export function summarizeDeckVisionConsensus({
  yoloResult = null,
  vlmResult = null,
  escalation = null,
  expectedLayout = null,
} = {}) {
  const mismatches = Array.isArray(yoloResult?.mismatches) ? yoloResult.mismatches : [];
  const vlmParsed = vlmResult?.parsed_result || null;
  const needsHumanReview = Boolean(vlmParsed?.needs_human_review);
  const possibleIssues = Array.isArray(vlmParsed?.possible_issues) ? vlmParsed.possible_issues : [];

  let status = "passed";
  if (mismatches.length > 0 || possibleIssues.length > 0) {
    status = needsHumanReview ? "blocked" : "needs_confirmation";
  } else if (escalation?.escalate) {
    status = vlmParsed ? "needs_confirmation" : "blocked";
  }

  return {
    status,
    yolo_mismatch_count: mismatches.length,
    vlm_escalated: Boolean(escalation?.escalate),
    vlm_escalate_reasons: escalation?.reasons || [],
    needs_human_review: needsHumanReview,
    summary:
      vlmParsed?.summary ||
      yoloResult?.summary ||
      (mismatches.length > 0
        ? `YOLO detected ${mismatches.length} deck mismatches against expected layout.`
        : "Deck vision check completed."),
    recommended_next_actions: [
      ...(Array.isArray(vlmParsed?.recommended_next_actions) ? vlmParsed.recommended_next_actions : []),
      ...(mismatches.length > 0 ? ["reconcile_state", "operator_confirm_deck_layout"] : ["continue_critical_probe"]),
    ],
    observation_only: true,
    deck_truth_requires_reconcile: mismatches.length > 0,
    expected_layout: expectedLayout || null,
  };
}

export function buildDeckVisionPreflightResult({
  imagePath,
  yoloResult,
  vlmResult = null,
  escalation = null,
  expectedLayout = null,
  provider = "ark",
} = {}) {
  const consensus = summarizeDeckVisionConsensus({
    yoloResult,
    vlmResult,
    escalation,
    expectedLayout,
  });

  return {
    image_path: imagePath,
    sensors_used: vlmResult ? ["vision_check", `analyze_image_with_${provider}`] : ["vision_check"],
    vlm_provider: vlmResult ? provider : null,
    vlm_used: Boolean(vlmResult),
    yolo: yoloResult,
    vlm: vlmResult,
    escalation,
    consensus,
    subphase: "deck_vision",
  };
}
