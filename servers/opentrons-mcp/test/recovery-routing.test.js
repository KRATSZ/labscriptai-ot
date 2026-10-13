import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRecoveryRoutingGuidance,
  enrichRecoverySuggestion,
  resolveRecoveryChannel,
} from "../lib/recovery-routing.js";

test("resolveRecoveryChannel maps dashboard leaves", () => {
  assert.equal(resolveRecoveryChannel("DOOR_OPEN"), "dashboard");
  assert.equal(resolveRecoveryChannel("MODULE_NOT_READY"), "dashboard");
});

test("resolveRecoveryChannel maps vision and probe leaves", () => {
  assert.equal(resolveRecoveryChannel("LABWARE_MISMATCH"), "vision");
  assert.equal(resolveRecoveryChannel("INSUFFICIENT_VOLUME"), "probe");
  assert.equal(resolveRecoveryChannel("TIP_PHYSICALLY_MISSING"), "tip");
});

test("SESSION_NEEDS_RECONCILIATION recommends reconcile_state first", () => {
  assert.equal(resolveRecoveryChannel("SESSION_NEEDS_RECONCILIATION"), "reconcile");
  const guidance = buildRecoveryRoutingGuidance({
    errorLeaf: "SESSION_NEEDS_RECONCILIATION",
  });
  assert.equal(guidance.recovery_channel, "reconcile");
  assert.equal(guidance.recommended_next_tools[0], "reconcile_state");
  assert.ok(!guidance.recommended_next_tools[0].includes("camera"));
  assert.ok(!guidance.recommended_next_tools.includes("deck_vision_check"));
  assert.ok(!guidance.recommended_next_tools.includes("capture_preview_image"));
});

test("DECK_COLLISION is manual hard-stop, not vision", () => {
  assert.equal(resolveRecoveryChannel("DECK_COLLISION"), "manual");
  const guidance = buildRecoveryRoutingGuidance({ errorLeaf: "DECK_COLLISION" });
  assert.equal(guidance.recovery_channel, "manual");
  assert.equal(guidance.resume_allowed, false);
  assert.ok(!guidance.recommended_next_tools.includes("deck_vision_check"));
  assert.ok(!guidance.recommended_next_tools.includes("capture_preview_image"));
  assert.ok(
    guidance.recommended_next_tools.includes("live_readiness_check"),
    "collision operator_steps require live_readiness_check in recommended tools",
  );
  assert.ok(
    guidance.operator_steps.some(step => String(step).includes("live_readiness_check")),
  );
});

test("DESTINATION_OCCUPIED stays human slot confirm without camera primary", () => {
  assert.equal(resolveRecoveryChannel("DESTINATION_OCCUPIED"), "slot_confirm");
  const enriched = enrichRecoverySuggestion({
    error_leaf: "DESTINATION_OCCUPIED",
    action: "manual_only",
  });
  assert.equal(enriched.recovery_channel, "slot_confirm");
  assert.equal(enriched.default_next_step, "suggest_recovery_action");
  assert.ok(!enriched.recommended_next_tools.includes("deck_vision_check"));
  assert.ok(!enriched.recommended_next_tools.includes("capture_preview_image"));
  assert.ok(enriched.recommended_next_tools.includes("get_slot_occupation"));
});

test("enrichRecoverySuggestion adds routing metadata", () => {
  const enriched = enrichRecoverySuggestion({
    error_leaf: "INSUFFICIENT_VOLUME",
    action: "manual_only",
  });

  assert.equal(enriched.recovery_channel, "probe");
  assert.equal(enriched.recovery_channel_label, "手指");
  assert.ok(enriched.recommended_next_tools.includes("probe_wells"));
  assert.equal(enriched.default_next_step, "live_liquid_recovery_gate");
});

test("buildRecoveryRoutingGuidance labels dashboard channel in Chinese", () => {
  const guidance = buildRecoveryRoutingGuidance({ errorLeaf: "DOOR_OPEN" });
  assert.equal(guidance.recovery_channel, "dashboard");
  assert.equal(guidance.recovery_channel_label, "仪表盘");
  assert.ok(guidance.recommended_next_tools.includes("live_readiness_check"));
});
