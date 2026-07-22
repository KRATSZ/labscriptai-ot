import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDeckVisionPreflightResult,
  isPreflightVisionEnabled,
  runVlmSecondOpinion,
  shouldEscalateToVlm,
  summarizeDeckVisionConsensus,
} from "../lib/deck-vision-preflight.js";

const PHASE3B_FORBIDDEN_GO_LIVE_STATUS = "needs_confirmation";

test("shouldEscalateToVlm triggers on mismatches", () => {
  const result = shouldEscalateToVlm({
    mismatches: [{ slot: "D3", reason: "expected_occupied_but_empty" }],
    uncertainties: [],
  });

  assert.equal(result.escalate, true);
  assert.ok(result.reasons.some(reason => reason.includes("D3")));
});

test("shouldEscalateToVlm stays false on clean YOLO output", () => {
  const result = shouldEscalateToVlm({
    mismatches: [],
    uncertainties: [],
    summary: "Deck vision check completed.",
  });

  assert.equal(result.escalate, false);
});

test("shouldEscalateToVlm triggers on YOLO needs_human_review alone", () => {
  const result = shouldEscalateToVlm({
    mismatches: [],
    uncertainties: [],
    needs_human_review: true,
    summary: "review recommended",
  });

  assert.equal(result.escalate, true);
  assert.ok(result.reasons.includes("yolo_needs_human_review"));
});

test("summarizeDeckVisionConsensus mismatch → auto_fixable + reconcile_state first", () => {
  const consensus = summarizeDeckVisionConsensus({
    yoloResult: {
      mismatches: [{ slot: "C2", reason: "label_mismatch" }],
      summary: "mismatch",
    },
    vlmResult: {
      parsed_result: {
        summary: "possible empty C2",
        possible_issues: [],
        needs_human_review: false,
        recommended_next_actions: ["operator_confirm_deck_layout", "reconcile_state"],
      },
    },
    escalation: { escalate: true, reasons: ["mismatch:C2:label_mismatch"] },
  });

  assert.equal(consensus.status, "auto_fixable");
  assert.notEqual(consensus.status, PHASE3B_FORBIDDEN_GO_LIVE_STATUS);
  assert.equal(consensus.yolo_mismatch_count, 1);
  assert.equal(consensus.recommended_next_actions[0], "reconcile_state");
  assert.ok(!consensus.recommended_next_actions.includes("operator_confirm_deck_layout"));
  assert.equal(consensus.deck_truth_requires_reconcile, true);
});

test("YOLO low_confidence + VLM clean agree → passed (not needs_confirmation)", () => {
  const consensus = summarizeDeckVisionConsensus({
    yoloResult: {
      mismatches: [],
      uncertainties: ["low_confidence"],
      summary: "low confidence on D3",
    },
    vlmResult: {
      parsed_result: {
        summary: "96-well plate present on D3",
        possible_issues: [],
        needs_human_review: false,
        recommended_next_actions: ["continue_critical_probe"],
      },
    },
    escalation: {
      escalate: true,
      reasons: ["uncertainty:low_confidence"],
    },
    expectedLayout: { D3: "corning_96_wellplate_360ul_flat" },
  });

  assert.equal(consensus.status, "passed");
  assert.equal(consensus.vlm_escalated, true);
  assert.equal(consensus.needs_human_review, false);
  assert.equal(consensus.layout_consistent_with_expected, true);
  assert.notEqual(consensus.status, PHASE3B_FORBIDDEN_GO_LIVE_STATUS);
});

test("VLM possible_issues + needs_human_review=false must not yield needs_confirmation", () => {
  const consensus = summarizeDeckVisionConsensus({
    yoloResult: {
      mismatches: [],
      uncertainties: [],
      summary: "ok",
    },
    vlmResult: {
      parsed_result: {
        summary: "minor glare on tip rack label",
        possible_issues: ["glare_on_tip_rack_label"],
        needs_human_review: false,
        recommended_next_actions: ["continue_critical_probe"],
      },
    },
    escalation: { escalate: true, reasons: ["forced_by_operator"] },
  });

  assert.notEqual(consensus.status, PHASE3B_FORBIDDEN_GO_LIVE_STATUS);
  assert.ok(
    consensus.status === "auto_fixable" || consensus.status === "passed",
    `expected auto_fixable or passed, got ${consensus.status}`,
  );
  assert.equal(consensus.needs_human_review, false);
  assert.equal(consensus.recommended_next_actions[0], "reconcile_state");
});

test("Phase 3b consensus never uses needs_confirmation for mismatch/uncertainty cases", () => {
  const cases = [
    summarizeDeckVisionConsensus({
      yoloResult: { mismatches: [{ slot: "A1", reason: "empty" }], summary: "mismatch" },
      escalation: { escalate: true, reasons: ["mismatch:A1:empty"] },
    }),
    summarizeDeckVisionConsensus({
      yoloResult: { mismatches: [], uncertainties: ["ambiguous_class"], summary: "uncertain" },
      vlmResult: {
        parsed_result: {
          summary: "unclear tip rack",
          possible_issues: ["ambiguous_tip_rack"],
          needs_human_review: false,
          recommended_next_actions: ["continue_critical_probe"],
        },
      },
      escalation: { escalate: true, reasons: ["uncertainty:ambiguous_class"] },
    }),
    summarizeDeckVisionConsensus({
      yoloResult: { mismatches: [], uncertainties: ["low_confidence"], summary: "low conf" },
      vlmResult: {
        parsed_result: {
          summary: "still uncertain",
          possible_issues: [],
          needs_human_review: false,
          recommended_next_actions: ["reconcile_state"],
        },
      },
      escalation: { escalate: true, reasons: ["uncertainty:low_confidence"] },
      expectedLayout: { B2: "opentrons_96_tiprack_300ul" },
    }),
    summarizeDeckVisionConsensus({
      yoloResult: { mismatches: [], uncertainties: ["vision_process_failed"], summary: "failed" },
      escalation: { escalate: true, reasons: ["uncertainty:vision_process_failed"] },
    }),
  ];

  for (const consensus of cases) {
    assert.notEqual(
      consensus.status,
      PHASE3B_FORBIDDEN_GO_LIVE_STATUS,
      `Phase 3b must not return needs_confirmation; got status=${consensus.status} summary=${consensus.summary}`,
    );
  }
});

test("needs_human_review true → needs_operator_physical_action (not needs_confirmation)", () => {
  const consensus = summarizeDeckVisionConsensus({
    yoloResult: { mismatches: [], summary: "ok" },
    vlmResult: {
      parsed_result: {
        summary: "labware looks shifted; rearrange required",
        possible_issues: ["labware_shifted"],
        needs_human_review: true,
        recommended_next_actions: ["operator_confirm_deck_layout"],
      },
    },
    escalation: { escalate: true, reasons: ["forced_by_operator"] },
  });

  assert.equal(consensus.status, "needs_operator_physical_action");
  assert.notEqual(consensus.status, PHASE3B_FORBIDDEN_GO_LIVE_STATUS);
  assert.equal(consensus.recommended_next_actions[0], "reconcile_state");
});

test("YOLO needs_human_review without VLM never silently passes", () => {
  const consensus = summarizeDeckVisionConsensus({
    yoloResult: {
      mismatches: [],
      uncertainties: [],
      needs_human_review: true,
      summary: "review recommended with empty mismatch list",
    },
    escalation: { escalate: true, reasons: ["yolo_needs_human_review"] },
  });

  assert.notEqual(consensus.status, "passed");
  assert.notEqual(consensus.status, PHASE3B_FORBIDDEN_GO_LIVE_STATUS);
  assert.equal(consensus.status, "auto_fixable");
  assert.equal(consensus.yolo_needs_human_review, true);
  assert.equal(consensus.needs_human_review, true);
  assert.equal(consensus.recommended_next_actions[0], "reconcile_state");
  assert.equal(consensus.deck_truth_requires_reconcile, true);
});

test("YOLO needs_human_review + VLM clean agree can pass", () => {
  const consensus = summarizeDeckVisionConsensus({
    yoloResult: {
      mismatches: [],
      uncertainties: [],
      needs_human_review: true,
      summary: "review recommended",
    },
    vlmResult: {
      parsed_result: {
        summary: "deck looks correct",
        possible_issues: [],
        needs_human_review: false,
        recommended_next_actions: ["continue_critical_probe"],
      },
    },
    escalation: { escalate: true, reasons: ["yolo_needs_human_review"] },
  });

  assert.equal(consensus.status, "passed");
  assert.equal(consensus.needs_human_review, false);
  assert.notEqual(consensus.status, PHASE3B_FORBIDDEN_GO_LIVE_STATUS);
});

test("runVlmSecondOpinion swallows Ark/API failures and returns null result", async () => {
  const { vlmResult, vlmError } = await runVlmSecondOpinion({
    escalate: true,
    provider: "ark",
    imagePath: "/tmp/deck.jpg",
    analyzeArk: async () => {
      throw new Error("Ark API key is required. Pass api_key or set ARK_API_KEY.");
    },
  });

  assert.equal(vlmResult, null);
  assert.equal(vlmError.provider, "ark");
  assert.equal(vlmError.recoverable, true);
  assert.match(vlmError.message, /ARK_API_KEY/);
});

test("VLM failure metadata still yields auto_fixable consensus path", async () => {
  const { vlmResult, vlmError } = await runVlmSecondOpinion({
    escalate: true,
    provider: "ark",
    imagePath: "/tmp/deck.jpg",
    analyzeArk: async () => {
      throw new Error("Ark request failed: 401 Unauthorized");
    },
  });
  const result = buildDeckVisionPreflightResult({
    imagePath: "/tmp/deck.jpg",
    yoloResult: {
      mismatches: [{ slot: "D3", reason: "expected_occupied_but_empty" }],
      summary: "mismatch",
    },
    vlmResult,
    vlmError,
    escalation: { escalate: true, reasons: ["mismatch:D3:expected_occupied_but_empty"] },
    provider: "ark",
  });

  assert.equal(result.vlm_used, false);
  assert.equal(result.vlm_error.recoverable, true);
  assert.equal(result.vlm_provider, "ark");
  assert.equal(result.consensus.status, "auto_fixable");
  assert.equal(result.consensus.recommended_next_actions[0], "reconcile_state");
  assert.notEqual(result.consensus.status, PHASE3B_FORBIDDEN_GO_LIVE_STATUS);
});

test("buildDeckVisionPreflightResult records vlm escalation", () => {
  const result = buildDeckVisionPreflightResult({
    imagePath: "/tmp/deck.jpg",
    yoloResult: { summary: "ok", mismatches: [{ slot: "D3" }] },
    vlmResult: { parsed_result: { summary: "plate present" } },
    escalation: { escalate: true, reasons: ["mismatch:D3:unknown"] },
    provider: "ark",
  });

  assert.equal(result.vlm_used, true);
  assert.equal(result.sensors_used[1], "analyze_image_with_ark");
  assert.equal(result.subphase, "deck_vision");
  assert.equal(result.consensus.status, "auto_fixable");
  assert.notEqual(result.consensus.status, PHASE3B_FORBIDDEN_GO_LIVE_STATUS);
  assert.equal(result.consensus.recommended_next_actions[0], "reconcile_state");
});

test("isPreflightVisionEnabled respects OPENTRONS_PREFLIGHT_VISION=off", () => {
  const original = process.env.OPENTRONS_PREFLIGHT_VISION;
  process.env.OPENTRONS_PREFLIGHT_VISION = "off";
  try {
    assert.equal(isPreflightVisionEnabled(), false);
  } finally {
    if (original === undefined) {
      delete process.env.OPENTRONS_PREFLIGHT_VISION;
    } else {
      process.env.OPENTRONS_PREFLIGHT_VISION = original;
    }
  }
});
