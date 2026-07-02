import test from "node:test";
import assert from "node:assert/strict";

import {
  applyRecoveryPatchToSteps,
  evaluateSuffixSufficiency,
  hardStopViolationTypes,
} from "../lib/suffix-monitor.js";
import {
  setLiquidContainerState,
  validateVirtualLabStateSteps,
} from "../lib/state.js";

function buildSessionState() {
  return {
    session_id: "suffix-monitor-test",
    state_revision: 0,
    deck: { slots: {} },
    pipettes: { left: { tip_attached: true } },
    tip_tracking: { tipracks: {} },
    liquid_tracking: { containers: {}, sources: {} },
    state_history: [],
    cleanup: { pending_actions: [], auto_home_allowed: null },
  };
}

function buildSubstitutionSteps() {
  return [
    {
      id: "declare-a1",
      type: "declare_container",
      container_key: "D3.A1",
      role: "source",
      volume_ul: 100,
      capacity_ul: 200,
      dead_volume_ul: 0,
    },
    {
      id: "declare-a2",
      type: "declare_container",
      container_key: "D3.A2",
      role: "source",
      volume_ul: 100,
      capacity_ul: 200,
      dead_volume_ul: 0,
    },
    {
      id: "declare-target",
      type: "declare_container",
      container_key: "C3.A1",
      role: "destination",
      volume_ul: 0,
      capacity_ul: 200,
      dead_volume_ul: 0,
    },
    {
      id: "transfer-50",
      type: "transfer",
      source_key: "D3.A1",
      target_key: "C3.A1",
      volume_ul: 50,
      pipette_id: "left",
    },
    {
      id: "transfer-60",
      type: "transfer",
      source_key: "D3.A1",
      target_key: "C3.A1",
      volume_ul: 60,
      pipette_id: "left",
    },
  ];
}

function sessionStateAtErrorPoint({ a2VolumeUl = 100 } = {}) {
  const state = buildSessionState();
  setLiquidContainerState(state, {
    container_key: "D3.A1",
    role: "source",
    volume_ul: 50,
    capacity_ul: 200,
    dead_volume_ul: 0,
  });
  setLiquidContainerState(state, {
    container_key: "D3.A2",
    role: "source",
    volume_ul: a2VolumeUl,
    capacity_ul: 200,
    dead_volume_ul: 0,
  });
  setLiquidContainerState(state, {
    container_key: "C3.A1",
    role: "destination",
    volume_ul: 50,
    capacity_ul: 200,
    dead_volume_ul: 0,
  });
  return state;
}

test("hardStopViolationTypes exports collision stall hard_stop", () => {
  assert.deepEqual(hardStopViolationTypes, ["collision", "stall", "hard_stop"]);
});

test("applyRecoveryPatchToSteps replaces source_key references without mutating input", () => {
  const steps = [
    { type: "transfer", source_key: "D3.A1", target_key: "C3.A1", volume_ul: 60 },
    { type: "aspirate", source: "d3.a1", volume_ul: 10 },
    { type: "transfer", source_key: "D3.B1", target_key: "C3.A1", volume_ul: 5 },
  ];
  const patch = { type: "replace_source", from_key: "D3.A1", to_key: "D3.A2" };
  const patched = applyRecoveryPatchToSteps(steps, patch);

  assert.notEqual(patched, steps);
  assert.equal(patched[0].source_key, "D3.A2");
  assert.equal(patched[1].source, "D3.A2");
  assert.equal(patched[2].source_key, "D3.B1");
  assert.equal(steps[0].source_key, "D3.A1");
  assert.equal(steps[1].source, "d3.a1");
});

test("applyRecoveryPatchToSteps leaves suffix unchanged when patch matches no step", () => {
  const suffix = [
    { type: "transfer", source_key: "D3.A1", target_key: "C3.A1", volume_ul: 60 },
  ];
  const patch = { type: "replace_source", from_key: "D3.B1", to_key: "D3.C1" };
  const patched = applyRecoveryPatchToSteps(suffix, patch);

  assert.deepEqual(patched, suffix);
  assert.notEqual(patched, suffix);
});

test("evaluateSuffixSufficiency passes when patched suffix uses an alternative with enough volume", () => {
  const steps = buildSubstitutionSteps();
  const errorStepIndex = 4;
  const sessionState = sessionStateAtErrorPoint();
  const withoutPatch = evaluateSuffixSufficiency({
    sessionState,
    steps,
    errorStepIndex,
    patch: null,
  });

  assert.equal(withoutPatch.ok, false);
  assert.equal(withoutPatch.suffix_sufficient, false);
  assert.ok(withoutPatch.violations.some(violation => violation.code === "aspirate_exceeds_available_volume"));
  assert.equal(withoutPatch.violations[0].step_index, 0);
  assert.equal(withoutPatch.checkedFromIndex, errorStepIndex);

  const withPatch = evaluateSuffixSufficiency({
    sessionState,
    steps,
    errorStepIndex,
    patch: { type: "replace_source", from_key: "D3.A1", to_key: "D3.A2" },
  });

  assert.equal(withPatch.ok, true);
  assert.equal(withPatch.suffix_sufficient, true);
  assert.deepEqual(withPatch.violations, []);
  assert.equal(withPatch.patchedSuffix[0].source_key, "D3.A2");
  assert.equal(withPatch.plan.recovery_type, "alternative_resource");
  assert.equal(withPatch.plan.from_key, "D3.A1");
  assert.equal(withPatch.plan.to_key, "D3.A2");
});

test("evaluateSuffixSufficiency fails when patched suffix still exceeds available volume", () => {
  const steps = buildSubstitutionSteps();
  const sessionState = sessionStateAtErrorPoint({ a2VolumeUl: 40 });
  const result = evaluateSuffixSufficiency({
    sessionState,
    steps,
    errorStepIndex: 4,
    patch: { type: "replace_source", from_key: "D3.A1", to_key: "D3.A2" },
  });

  assert.equal(result.ok, false);
  assert.equal(result.suffix_sufficient, false);
  assert.ok(result.violations.some(violation => violation.code === "aspirate_exceeds_available_volume"));
  assert.equal(result.violations[0].step_index, 0);
});

test("evaluateSuffixSufficiency replays patched suffix against session state at error point", () => {
  const steps = buildSubstitutionSteps();
  const sessionState = sessionStateAtErrorPoint();
  const result = evaluateSuffixSufficiency({
    sessionState,
    steps,
    errorStepIndex: 4,
    patch: { type: "replace_source", from_key: "D3.A1", to_key: "D3.A2" },
  });
  const replay = validateVirtualLabStateSteps(sessionState, result.patchedSuffix);

  assert.equal(replay.ok, true);
  assert.equal(result.ok, replay.ok);
});
