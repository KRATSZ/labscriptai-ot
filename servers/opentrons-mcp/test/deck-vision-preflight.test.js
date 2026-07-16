import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDeckVisionPreflightResult,
  isPreflightVisionEnabled,
  shouldEscalateToVlm,
  summarizeDeckVisionConsensus,
} from "../lib/deck-vision-preflight.js";

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

test("summarizeDeckVisionConsensus marks needs_confirmation when mismatches exist", () => {
  const consensus = summarizeDeckVisionConsensus({
    yoloResult: {
      mismatches: [{ slot: "C2", reason: "label_mismatch" }],
      summary: "mismatch",
    },
  });

  assert.equal(consensus.status, "needs_confirmation");
  assert.equal(consensus.yolo_mismatch_count, 1);
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
