import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { TOOL_HANDLERS } from "../index.js";
import {
  buildLiquidSourceSubstitutionPlan,
  generateLiquidSourceSubstitutionValidationProtocol,
  validateLiquidSourceSubstitutionInvariants,
} from "../lib/liquid-source-substitution.js";
import { analyzeLiquidProtocolGuards } from "../lib/liquid-protocol-guards.js";

function buildSessionState(sources) {
  return {
    session_id: "liquid-substitution-test",
    state_revision: 7,
    liquid_tracking: { sources },
  };
}

test("buildLiquidSourceSubstitutionPlan plans water replacement from same-liquid expected-present sources", () => {
  const plan = buildLiquidSourceSubstitutionPlan({
    sessionState: buildSessionState({
      "D3.A1": {
        slot_name: "D3",
        well_name: "A1",
        liquid_name: "water",
        sample_id: "water-d3-a1",
        expected_presence: true,
      },
      "C3.A1": {
        slot_name: "C3",
        well_name: "A1",
        liquid_name: "water",
        sample_id: "water-c3-a1",
        expected_presence: true,
        observed_presence: true,
        observed_run_id: "probe-c3-a1",
        observed_source: "live_probe",
      },
      "D3.B1": {
        slot_name: "D3",
        well_name: "B1",
        liquid_name: "water",
        sample_id: "water-d3-b1",
        expected_presence: true,
      },
      "D3.C1": {
        slot_name: "D3",
        well_name: "C1",
        liquid_name: "buffer",
        sample_id: "buffer-c1",
        expected_presence: true,
      },
      "D3.D1": {
        slot_name: "D3",
        well_name: "D1",
        liquid_name: "water",
        sample_id: "empty-water-control",
        expected_presence: false,
      },
    }),
    failedSourceKey: "D3.A1",
    preferredSourceKey: "D3.B1",
  });

  assert.equal(plan.status, "planned");
  assert.equal(plan.ready_for_registered_executor, true);
  assert.equal(plan.auto_resume_eligible, false);
  assert.equal(plan.selected_source_key, "D3.B1");
  assert.deepEqual(plan.candidates.map(candidate => candidate.source_map_key), ["C3.A1", "D3.B1"]);
  assert.equal(plan.patch.recovery_type, "alternative_resource");
  assert.equal(plan.patch.resource_type, "liquid_source");
  assert.equal(plan.patch.sample_id_policy, "generic_reagent_sample_id_may_differ");
  assert.equal(plan.patch.executor, "liquid_source_substitution_continuation_protocol");
  assert.equal(plan.patch.playbook_id, "liquid_source_substitution_continuation_protocol");
  assert.equal(plan.semantic_invariants.experiment_intent_violation_count, 0);
  assert.ok(plan.semantic_invariants.missing_gates.includes("replacement_source_live_presence_observed"));
  assert.equal(
    plan.blocked_reason,
    "liquid_source_substitution_requires_validated_presence_before_auto_resume",
  );
  assert.equal(plan.required_next_step, "prepare_liquid_source_substitution_recovery");
  assert.equal(plan.no_robot_motion, true);
});

test("buildLiquidSourceSubstitutionPlan skips sources observed empty", () => {
  const sessionState = buildSessionState({
    "D3.H1": {
      slot_name: "D3",
      well_name: "H1",
      labware_load_name: "corning_96_wellplate_360ul_flat",
      liquid_name: "water",
      sample_id: "water-d3-h1",
      expected_presence: true,
    },
    "D3.G1": {
      slot_name: "D3",
      well_name: "G1",
      labware_load_name: "corning_96_wellplate_360ul_flat",
      liquid_name: "water",
      sample_id: "water-d3-g1",
      expected_presence: true,
      observed_presence: false,
    },
    "C3.A1": {
      slot_name: "C3",
      well_name: "A1",
      labware_load_name: "nest_12_reservoir_15ml",
      liquid_name: "water",
      sample_id: "water-c3-a1",
      expected_presence: true,
      observed_presence: true,
    },
  });

  const plan = buildLiquidSourceSubstitutionPlan({
    sessionState,
    failedSourceKey: "D3.H1",
  });

  assert.equal(plan.status, "planned");
  assert.equal(plan.auto_resume_eligible, true);
  assert.equal(plan.auto_resume_blocker, null);
  assert.equal(plan.selected_source_key, "C3.A1");
  assert.deepEqual(plan.candidates.map(candidate => candidate.source_map_key), ["C3.A1"]);
  assert.equal(plan.semantic_invariants.experiment_intent_violation_count, 0);
  assert.equal(
    plan.semantic_invariants.checks.find(check => check.name === "replacement_source_live_presence_observed").status,
    "pass",
  );
});

test("buildLiquidSourceSubstitutionPlan requires sample identity compatibility for non-generic liquids", () => {
  const plan = buildLiquidSourceSubstitutionPlan({
    sessionState: buildSessionState({
      "D3.A1": {
        slot_name: "D3",
        well_name: "A1",
        liquid_name: "enzyme-a",
        sample_id: "sample-1",
        expected_presence: true,
      },
      "D3.B1": {
        slot_name: "D3",
        well_name: "B1",
        liquid_name: "enzyme-a",
        sample_id: "sample-2",
        expected_presence: true,
      },
      "D3.C1": {
        slot_name: "D3",
        well_name: "C1",
        liquid_name: "enzyme-a",
        sample_id: "sample-1",
        expected_presence: true,
      },
    }),
    failedSourceKey: "D3.A1",
  });

  assert.equal(plan.status, "planned");
  assert.deepEqual(plan.candidates.map(candidate => candidate.source_map_key), ["D3.C1"]);
  assert.equal(plan.selected_source_key, "D3.C1");
  assert.equal(plan.patch.sample_id_policy, "sample_id_must_match_or_be_unspecified");
});

test("buildLiquidSourceSubstitutionPlan blocks when source identity is generic placeholder", () => {
  const plan = buildLiquidSourceSubstitutionPlan({
    sessionState: buildSessionState({
      "D3.A1": {
        slot_name: "D3",
        well_name: "A1",
        liquid_name: "operator-confirmed-liquid",
        expected_presence: true,
      },
    }),
    failedSourceKey: "D3.A1",
  });

  assert.equal(plan.status, "blocked");
  assert.equal(plan.ready_for_registered_executor, false);
  assert.equal(plan.blocked_reason, "failed_source_liquid_identity_not_specific");
});

test("plan_liquid_source_substitution handler records a no-motion result log", async () => {
  await TOOL_HANDLERS.record_liquid_source_map({
    session_id: "liquid-substitution-handler",
    sources: [
      {
        slot_name: "D3",
        well_name: "A1",
        liquid_name: "water",
        sample_id: "water-d3-a1",
        expected_presence: true,
      },
      {
        slot_name: "C3",
        well_name: "A1",
        liquid_name: "water",
        sample_id: "water-c3-a1",
        expected_presence: true,
      },
    ],
  });

  const result = await TOOL_HANDLERS.plan_liquid_source_substitution({
    session_id: "liquid-substitution-handler",
    failed_source_key: "D3.A1",
  });

  assert.equal(result.data.status, "planned");
  assert.equal(result.data.selected_source_key, "C3.A1");
  assert.equal(result.data.no_robot_motion, true);

  const history = await TOOL_HANDLERS.experiment_history({
    session_id: "liquid-substitution-handler",
    tool_name: "plan_liquid_source_substitution",
    event_kind: "liquid_source_substitution_plan",
  });
  assert.equal(history.data.entries[0].tool_name, "plan_liquid_source_substitution");
  assert.equal(history.data.entries[0].data.selected_source_key, "C3.A1");
  assert.equal(history.data.entries[0].data.no_robot_motion, true);
});

test("generateLiquidSourceSubstitutionValidationProtocol renders a no-aspirate presence guard", () => {
  const result = generateLiquidSourceSubstitutionValidationProtocol({
    sessionState: buildSessionState({
      "D3.A1": {
        slot_name: "D3",
        well_name: "A1",
        labware_load_name: "corning_96_wellplate_360ul_flat",
        liquid_name: "water",
        sample_id: "water-d3-a1",
        expected_presence: true,
      },
      "C3.A1": {
        slot_name: "C3",
        well_name: "A1",
        labware_load_name: "nest_12_reservoir_15ml",
        liquid_name: "water",
        sample_id: "water-c3-a1",
        expected_presence: true,
      },
    }),
    failedSourceKey: "D3.A1",
    preferredSourceKey: "C3.A1",
    pipetteName: "flex_1channel_1000",
    mount: "left",
    tiprackLoadName: "opentrons_flex_96_tiprack_1000ul",
    tiprackSlot: "B2",
  });

  assert.equal(result.plan.selected_source_key, "C3.A1");
  assert.equal(result.validation_protocol.no_aspirate_or_dispense, true);
  assert.equal(result.validation_protocol.liquid_guard_analysis.status, "pass");
  assert.equal(result.validation_protocol.liquid_guard_analysis.require_liquid_presence_count, 1);
  assert.equal(result.validation_protocol.liquid_guard_analysis.aspirate_count, 0);
  assert.equal(result.validation_protocol.liquid_guard_analysis.dispense_count, 0);
  assert.equal(result.validation_protocol.liquid_guard_analysis.first_aspirate_guarded, true);
  assert.equal(result.validation_protocol.semantic_invariants.experiment_intent_violation_count, 0);
  assert.equal(
    result.validation_protocol.semantic_invariants.checks.find(
      check => check.name === "validation_protocol_has_no_aspirate_or_dispense",
    ).status,
    "pass",
  );
  assert.match(
    result.protocol_source,
    /replacement_labware = protocol\.load_labware\("nest_12_reservoir_15ml", "C3"/,
  );
  assert.match(result.protocol_source, /pipette\.require_liquid_presence\(target_well\)/);
  assert.match(result.protocol_source, /LIQUID_SOURCE_SUBSTITUTION_VALIDATED/);
  assert.doesNotMatch(result.protocol_source, /\.aspirate\(/);
  assert.doesNotMatch(result.protocol_source, /\.dispense\(/);
});

test("validateLiquidSourceSubstitutionInvariants catches sample identity changes for non-generic liquids", () => {
  const plan = buildLiquidSourceSubstitutionPlan({
    sessionState: buildSessionState({
      "D3.A1": {
        slot_name: "D3",
        well_name: "A1",
        liquid_name: "enzyme-a",
        sample_id: "sample-1",
        expected_presence: true,
      },
      "D3.B1": {
        slot_name: "D3",
        well_name: "B1",
        liquid_name: "enzyme-a",
        sample_id: null,
        expected_presence: true,
        observed_presence: true,
      },
    }),
    failedSourceKey: "D3.A1",
  });
  const unsafePlan = {
    ...plan,
    selected_source: {
      ...plan.selected_source,
      sample_id: "sample-2",
    },
  };
  const invariants = validateLiquidSourceSubstitutionInvariants({ plan: unsafePlan });

  assert.equal(invariants.status, "failed");
  assert.ok(invariants.failed_checks.includes("sample_id_policy_satisfied"));
  assert.equal(invariants.experiment_intent_violation_count, 1);
});

test("analyzeLiquidProtocolGuards blocks aspirate before liquid presence guard", () => {
  const unsafe = analyzeLiquidProtocolGuards(`
def run(protocol):
    pipette.aspirate(10, plate["A1"])
    pipette.require_liquid_presence(plate["A1"])
`);
  assert.equal(unsafe.status, "blocked");
  assert.equal(unsafe.first_aspirate_guarded, false);
  assert.equal(unsafe.blocked_reason, "first_aspirate_occurs_before_require_liquid_presence");

  const guarded = analyzeLiquidProtocolGuards(`
def run(protocol):
    pipette.require_liquid_presence(plate["A1"])
    pipette.aspirate(10, plate["A1"])
`);
  assert.equal(guarded.status, "pass");
  assert.equal(guarded.first_aspirate_guarded, true);
  assert.equal(guarded.no_aspirate_or_dispense, false);
});

test("generate_liquid_source_substitution_protocol handler writes a protocol artifact and result log", async () => {
  await TOOL_HANDLERS.record_liquid_source_map({
    session_id: "liquid-substitution-generate-handler",
    sources: [
      {
        slot_name: "D3",
        well_name: "A1",
        labware_load_name: "corning_96_wellplate_360ul_flat",
        liquid_name: "water",
        sample_id: "water-d3-a1",
        expected_presence: true,
      },
      {
        slot_name: "C3",
        well_name: "A1",
        labware_load_name: "nest_12_reservoir_15ml",
        liquid_name: "water",
        sample_id: "water-c3-a1",
        expected_presence: true,
        observed_presence: true,
        observed_run_id: "probe-c3-a1",
        observed_source: "live_probe",
      },
    ],
  });

  const result = await TOOL_HANDLERS.generate_liquid_source_substitution_protocol({
    session_id: "liquid-substitution-generate-handler",
    failed_source_key: "D3.A1",
    preferred_source_key: "C3.A1",
    pipette_name: "flex_1channel_1000",
    mount: "left",
    tiprack_load_name: "opentrons_flex_96_tiprack_1000ul",
    tiprack_slot: "B2",
  });

  assert.equal(result.data.plan.selected_source_key, "C3.A1");
  assert.equal(result.data.validation_protocol.no_aspirate_or_dispense, true);
  assert.match(result.data.generated_protocol_path, /liquid-source-substitution/);
  assert.match(result.data.protocol_source, /require_liquid_presence/);
  assert.equal(result.data.validation_protocol.liquid_guard_analysis.status, "pass");
  assert.equal(result.data.validation_protocol.liquid_guard_analysis.no_aspirate_or_dispense, true);
  assert.deepEqual(result.data.next_required_gates, [
    "simulate_protocol",
    "live_liquid_recovery_gate",
    "run_protocol_only_after_operator_opt_in",
  ]);

  const history = await TOOL_HANDLERS.experiment_history({
    session_id: "liquid-substitution-generate-handler",
    tool_name: "generate_liquid_source_substitution_protocol",
    event_kind: "liquid_source_substitution_protocol",
  });
  assert.equal(history.data.entries[0].tool_name, "generate_liquid_source_substitution_protocol");
  assert.equal(history.data.entries[0].data.selected_source_key, "C3.A1");
  assert.equal(history.data.entries[0].data.no_aspirate_or_dispense, true);
  assert.equal(history.data.entries[0].data.liquid_guard_analysis.status, "pass");
});

test("prepare_liquid_source_substitution_recovery writes a fixed no-motion recovery bundle", async () => {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "liquid-substitution-recovery-"));
  const bundlePath = path.join(artifactDir, "recovery-bundle.json");
  const protocolPath = path.join(artifactDir, "validation.py");
  await TOOL_HANDLERS.record_liquid_source_map({
    session_id: "liquid-substitution-recovery-handler",
    sources: [
      {
        slot_name: "D3",
        well_name: "A1",
        labware_load_name: "corning_96_wellplate_360ul_flat",
        liquid_name: "water",
        sample_id: "water-d3-a1",
        expected_presence: true,
      },
      {
        slot_name: "C3",
        well_name: "A1",
        labware_load_name: "nest_12_reservoir_15ml",
        liquid_name: "water",
        sample_id: "water-c3-a1",
        expected_presence: true,
        observed_presence: true,
        observed_run_id: "probe-c3-a1",
        observed_source: "live_probe",
      },
    ],
  });

  const result = await TOOL_HANDLERS.prepare_liquid_source_substitution_recovery({
    session_id: "liquid-substitution-recovery-handler",
    failed_source_key: "D3.A1",
    preferred_source_key: "C3.A1",
    pipette_name: "flex_1channel_1000",
    mount: "left",
    tiprack_load_name: "opentrons_flex_96_tiprack_1000ul",
    tiprack_slot: "B2",
    output_path: bundlePath,
    output_protocol_path: protocolPath,
    ...(process.env.OPENTRONS_PYTHON ? { python_executable: process.env.OPENTRONS_PYTHON } : {}),
  });

  assert.equal(result.data.status, "prepared");
  assert.equal(result.data.playbook, "liquid_source_substitution_continuation_protocol");
  assert.equal(result.data.failed_source_key, "D3.A1");
  assert.equal(result.data.selected_source_key, "C3.A1");
  assert.equal(result.data.no_robot_motion, true);
  assert.equal(result.data.no_aspirate_or_dispense, true);
  assert.equal(result.data.validation_protocol.liquid_guard_analysis.status, "pass");
  assert.equal(result.data.validation_protocol.liquid_guard_analysis.first_aspirate_guarded, true);
  assert.equal(result.data.simulation.status, "passed");
  assert.equal(result.data.execution.fixed_script_prepared, true);
  assert.equal(result.data.execution.auto_resume_eligible, true);
  assert.equal(result.data.execution.live_execution_allowed, false);
  assert.equal(result.data.execution.experiment_intent_violation_count, 0);
  assert.equal(result.data.execution.semantic_invariant_status, "blocked");
  assert.ok(result.data.semantic_invariants.missing_gates.includes("live_liquid_recovery_gate_passed"));
  assert.equal(result.data.execution.next_tool, "live_liquid_recovery_gate");
  assert.match(result.data.result_log_entry_id, /^[0-9a-f-]+$/);

  const bundle = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
  assert.equal(bundle.result_log_entry_id, result.data.result_log_entry_id);
  assert.equal(bundle.generated_protocol_path, protocolPath);
  assert.equal(bundle.execution.auto_resume_eligible, true);
  assert.equal(bundle.execution.live_protocol_run_allowed, false);
  assert.equal(bundle.execution.experiment_intent_violation_count, 0);
  assert.equal(bundle.validation_protocol.liquid_guard_analysis.status, "pass");
  assert.equal(bundle.validation_protocol.liquid_guard_analysis.no_aspirate_or_dispense, true);
  assert.equal(fs.readFileSync(protocolPath, "utf8").includes("require_liquid_presence"), true);

  const history = await TOOL_HANDLERS.experiment_history({
    session_id: "liquid-substitution-recovery-handler",
    tool_name: "prepare_liquid_source_substitution_recovery",
    event_kind: "liquid_source_substitution_recovery_bundle",
  });
  assert.equal(history.data.entries[0].tool_name, "prepare_liquid_source_substitution_recovery");
  assert.equal(history.data.entries[0].data.playbook, "liquid_source_substitution_continuation_protocol");
  assert.equal(history.data.entries[0].data.fixed_script_prepared, true);
  assert.equal(history.data.entries[0].data.auto_resume_eligible, true);
  assert.equal(history.data.entries[0].data.experiment_intent_violation_count, 0);
  assert.equal(history.data.entries[0].data.semantic_invariant_status, "blocked");
  assert.equal(history.data.entries[0].data.liquid_guard_analysis.status, "pass");
});
