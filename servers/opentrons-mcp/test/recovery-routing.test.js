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
