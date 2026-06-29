import test from "node:test";
import assert from "node:assert/strict";

import {
  applyObservedDeckToSessionState,
  buildActionSummary,
  buildHomeSafetyResult,
  buildObservedDeckState,
  buildReconciliationResult,
  buildRecoverySuggestion,
  classifyRecoveryError,
  getSlotOccupationSummary,
  isHardStopErrorCategory,
  listAvailableSlots,
  listTipCandidates,
  parseRuntimeError,
  suggestAlternativeSlots,
  suggestNextTipWell,
} from "../lib/decision.js";

function buildSessionState() {
  return {
    session_id: "test-session",
    state_revision: 0,
    robot_serial: "FLX-TEST",
    last_run_id: null,
    needs_reconciliation: false,
    deck: { slots: {} },
    pipettes: {},
    tip_tracking: { tipracks: {} },
    liquid_tracking: { sources: {} },
    cleanup: { pending_actions: [], auto_home_allowed: null },
    updated_at: "2026-03-24T00:00:00.000Z",
  };
}

test("buildObservedDeckState marks modules, trash, and run labware", () => {
  const observed = buildObservedDeckState({
    deckConfiguration: {
      data: {
        cutoutFixtures: [
          { cutoutFixtureId: "thermocyclerModuleV2Rear", cutoutId: "cutoutA1" },
          { cutoutFixtureId: "trashBinAdapter", cutoutId: "cutoutA3" },
          { cutoutFixtureId: "singleCenterSlot", cutoutId: "cutoutC2" },
        ],
      },
    },
    modules: {
      data: [{ serialNumber: "TC123", moduleModel: "thermocyclerModuleV2", moduleOffset: { slot: "A1" } }],
    },
    run: {
      data: {
        id: "run-1",
        labware: [
          {
            id: "tiprack-1",
            loadName: "opentrons_flex_96_tiprack_1000ul",
            location: { slotName: "C2" },
          },
        ],
      },
    },
  });

  assert.equal(observed.slots.A1.occupant_type, "module");
  assert.equal(observed.slots.A3.occupant_type, "trash_bin");
  assert.equal(observed.slots.C2.occupant_type, "labware");
});

test("getSlotOccupationSummary reports mismatched committed state", () => {
  const sessionState = buildSessionState();
  sessionState.deck.slots.C2 = {
    slot_name: "C2",
    observed_status: "occupied",
    occupant_type: "labware",
    occupant_name: "old_plate",
  };
  const observed = buildObservedDeckState({
    deckConfiguration: {
      data: { cutoutFixtures: [{ cutoutFixtureId: "singleCenterSlot", cutoutId: "cutoutC2" }] },
    },
    run: {
      data: {
        labware: [{ id: "plate-1", loadName: "new_plate", location: { slotName: "C2" } }],
      },
    },
  });

  const summary = getSlotOccupationSummary({
    slotName: "C2",
    observedDeckState: observed,
    sessionState,
  });

  assert.equal(summary.status, "mismatched");
  assert.equal(summary.mismatched_against_committed, true);
});

test("listTipCandidates follows column-major order and skips tracked wells", () => {
  const sessionState = buildSessionState();
  sessionState.tip_tracking.tipracks.C2 = {
    slot_name: "C2",
    load_name: "opentrons_flex_96_tiprack_1000ul",
    search_order: ["A1", "B1", "C1"],
    missing_wells: ["A1"],
    depleted_wells: ["B1"],
    unknown_blocked_wells: [],
  };

  const candidates = listTipCandidates({
    sessionState,
    tiprackSlots: ["C2"],
  });

  assert.equal(candidates.viable_candidates[0].well_name, "C1");
  assert.equal(candidates.blocked_candidates.length, 2);
});

test("suggestNextTipWell marks failed well and proposes next viable well", () => {
  const sessionState = buildSessionState();
  const suggestion = suggestNextTipWell({
    sessionState,
    tiprackSlots: ["C2"],
    tiprackSlot: "C2",
    failedWell: "A1",
  });

  assert.equal(suggestion.failed_well, "A1");
  assert.equal(suggestion.next_candidate.well_name, "B1");
  assert.deepEqual(sessionState.tip_tracking.tipracks.C2.missing_wells, ["A1"]);
});

test("buildHomeSafetyResult blocks home when tip attached or reconciliation pending", () => {
  const sessionState = buildSessionState();
  sessionState.needs_reconciliation = true;
  const result = buildHomeSafetyResult({
    sessionState,
    robotStatusSnapshot: {
      blockers: [],
      instruments_summary: [{ mount: "left", tip_detected: true }],
    },
  });

  assert.equal(result.auto_home_allowed, false);
  assert.deepEqual(result.minimum_cleanup_actions, ["drop_tip:left"]);
  assert.ok(result.blockers.includes("needs_reconciliation"));
});

test("buildHomeSafetyResult keeps a clear safe-home matrix with deduped cleanup actions", () => {
  const sessionState = buildSessionState();
  sessionState.cleanup.pending_actions = ["drop_tip:left", "move_to_maintenance_position", "drop_tip:left"];
  const result = buildHomeSafetyResult({
    sessionState,
    robotStatusSnapshot: {
      blockers: ["door_open"],
      instruments_summary: [{ mount: "left", tip_detected: true }],
    },
  });

  assert.equal(result.auto_home_allowed, false);
  assert.ok(result.blockers.includes("door_open"));
  assert.ok(result.blockers.includes("tip_attached:left"));
  assert.deepEqual(result.minimum_cleanup_actions, ["drop_tip:left", "move_to_maintenance_position"]);
});

test("buildReconciliationResult reports tip mismatch and can apply observed state", () => {
  const sessionState = buildSessionState();
  sessionState.pipettes.left = { tip_attached: true };

  const observedDeckState = buildObservedDeckState({
    deckConfiguration: {
      data: {
        cutoutFixtures: [
          { cutoutFixtureId: "singleCenterSlot", cutoutId: "cutoutC2" },
          { cutoutFixtureId: "trashBinAdapter", cutoutId: "cutoutA3" },
        ],
      },
    },
    run: {
      data: {
        id: "run-2",
        labware: [
          {
            id: "tiprack-1",
            loadName: "opentrons_flex_96_tiprack_1000ul",
            location: { slotName: "C2" },
          },
        ],
      },
    },
  });

  const reconciliation = buildReconciliationResult({
    sessionState,
    robotStatusSnapshot: {
      health_summary: { robot_serial: "FLX-TEST" },
      instruments_summary: [{ mount: "left", instrument_name: "p1000_single_flex", tip_detected: false }],
    },
    moduleStatusSnapshot: { blockers: [] },
    observedDeckState,
    run: { data: { id: "run-2" } },
  });

  assert.equal(reconciliation.confidence, "high");
  assert.ok(reconciliation.diffs.some(diff => diff.type === "tip_attachment_mismatch"));

  applyObservedDeckToSessionState(sessionState, reconciliation.proposed_commit);
  assert.equal(sessionState.pipettes.left.tip_attached, false);
  assert.equal(sessionState.deck.slots.C2.occupant_name, "opentrons_flex_96_tiprack_1000ul");
});

test("buildReconciliationResult compares liquid volume and trust level when observed liquid state is supplied", () => {
  const sessionState = buildSessionState();
  sessionState.liquid_tracking = {
    containers: {
      "D3.A1": {
        container_key: "D3.A1",
        slot_name: "D3",
        well_name: "A1",
        role: "source",
        volume_ul: 100,
        capacity_ul: 200,
        dead_volume_ul: 10,
        trust_level: "declared",
      },
    },
    sources: {},
  };

  const reconciliation = buildReconciliationResult({
    sessionState,
    robotStatusSnapshot: {
      health_summary: { robot_serial: "FLX-TEST" },
      instruments_summary: [],
    },
    moduleStatusSnapshot: { blockers: [] },
    observedDeckState: buildObservedDeckState({}),
    observedLiquidTracking: {
      containers: {
        "D3.A1": {
          container_key: "D3.A1",
          slot_name: "D3",
          well_name: "A1",
          role: "source",
          volume_ul: 80,
          capacity_ul: 200,
          dead_volume_ul: 10,
          trust_level: "observed",
        },
      },
    },
    run: { data: { id: "run-liquid-reconcile" } },
  });

  assert.ok(reconciliation.diffs.some(diff => diff.type === "liquid_volume_mismatch"));
  assert.ok(reconciliation.diffs.some(diff => diff.type === "liquid_trust_mismatch"));
  applyObservedDeckToSessionState(sessionState, reconciliation.proposed_commit);
  assert.equal(sessionState.liquid_tracking.containers["D3.A1"].volume_ul, 80);
  assert.equal(sessionState.liquid_tracking.sources["D3.A1"].trust_level, "observed");
  assert.ok(
    sessionState.state_history.some(
      history => history.field === "liquid_tracking.containers.D3.A1.volume_ul",
    ),
  );
});

test("classifyRecoveryError and buildRecoverySuggestion handle tip recovery", () => {
  const classification = classifyRecoveryError({
    run: {
      data: {
        id: "run-3",
        status: "awaiting-recovery",
      },
    },
    commands: {
      data: [
        {
          commandType: "pickUpTip",
          status: "failed",
          error: { detail: "No Tip Detected" },
          params: { wellName: "A1" },
        },
      ],
    },
    moduleStatusSnapshot: { blockers: [] },
    robotStatusSnapshot: { blockers: [] },
  });

  const suggestion = buildRecoverySuggestion({
    errorCategory: classification.error_category,
    run: { data: { status: "awaiting-recovery" } },
    commands: {
      data: [
        {
          commandType: "pickUpTip",
          status: "failed",
          params: { wellName: "A1" },
        },
      ],
    },
    robotStatusSnapshot: { blockers: [] },
    moduleStatusSnapshot: { blockers: [] },
    nextTipSuggestion: {
      next_candidate: {
        tiprack_slot: "C2",
        well_name: "B1",
      },
    },
    reconciliation: { diffs: [] },
    tipBindingMode: "auto",
    tipBindingClassification: { mode: "auto", reason: "test" },
  });

  assert.equal(classification.error_category, "TIP_PHYSICALLY_MISSING");
  assert.equal(suggestion.action, "retry_pick_up_tip_with_next_candidate");
  assert.equal(suggestion.intent, "fixit");
  assert.equal(suggestion.route, "fixit");
  assert.equal(suggestion.tip_binding_mode, "auto");
  assert.equal(suggestion.suggested_tip.well_name, "B1");
});

test("buildRecoverySuggestion routes explicit tip protocols to continuation instead of same-run fixit", () => {
  const suggestion = buildRecoverySuggestion({
    errorCategory: "TIP_PHYSICALLY_MISSING",
    errorLeaf: "TIP_PHYSICALLY_MISSING",
    run: { data: { status: "awaiting-recovery" } },
    commands: {
      data: [
        {
          commandType: "pickUpTip",
          status: "failed",
          params: { wellName: "A1" },
        },
      ],
    },
    robotStatusSnapshot: { blockers: [] },
    moduleStatusSnapshot: { blockers: [] },
    nextTipSuggestion: {
      next_candidate: { tiprack_slot: "C2", well_name: "B1" },
    },
    reconciliation: { diffs: [] },
    tipBindingMode: "explicit",
    tipBindingClassification: { mode: "explicit", reason: "test" },
  });

  assert.equal(suggestion.actionability, "protocol_edit_required");
  assert.equal(suggestion.auto_executable, false);
  assert.equal(suggestion.action, "protocol_edit_required");
  assert.equal(suggestion.route, "replan");
  assert.equal(suggestion.recommended_manual_action, "generate_continuation_protocol");
  assert.equal(suggestion.suggested_starting_tip.well_name, "B1");
});

test("buildRecoverySuggestion gates tip recovery when binding mode is unknown", () => {
  const suggestion = buildRecoverySuggestion({
    errorCategory: "TIP_PHYSICALLY_MISSING",
    errorLeaf: "TIP_PHYSICALLY_MISSING",
    run: { data: { status: "awaiting-recovery" } },
    commands: {
      data: [
        {
          commandType: "pickUpTip",
          status: "failed",
          params: { wellName: "A1" },
        },
      ],
    },
    robotStatusSnapshot: { blockers: [] },
    moduleStatusSnapshot: { blockers: [] },
    nextTipSuggestion: {
      next_candidate: { tiprack_slot: "C2", well_name: "B1" },
    },
    reconciliation: { diffs: [] },
  });

  assert.equal(suggestion.action, "manual_only");
  assert.equal(suggestion.auto_executable, false);
  assert.equal(suggestion.route, "human");
  assert.equal(suggestion.rationale, "tip_binding_mode_unknown");
});

test("classifyRecoveryError prioritizes run-level protocol setup errors", () => {
  const classification = classifyRecoveryError({
    run: {
      data: {
        id: "run-4",
        status: "failed",
        errors: [{ detail: "NoTrashDefinedError: No trash container has been defined in this protocol." }],
      },
    },
    commands: {
      data: [
        {
          commandType: "pickUpTip",
          status: "failed",
          error: { detail: "No Tip Detected" },
        },
      ],
    },
    moduleStatusSnapshot: { blockers: [] },
    robotStatusSnapshot: { blockers: [] },
  });

  assert.equal(classification.error_category, "PROTOCOL_SETUP_ERROR");
  assert.equal(classification.error_leaf, "MISSING_TRASH_OR_SETUP");
});

test("parseRuntimeError extracts move destination and escalation", () => {
  const parsed = parseRuntimeError({
    run: {
      data: {
        id: "run-occupied",
        status: "failed",
      },
    },
    commands: {
      data: [
        {
          id: "cmd-move-1",
          commandType: "moveLabware",
          status: "failed",
          params: {
            labwareId: "labware-1",
            newLocation: { slotName: "B1" },
          },
          error: {
            errorType: "LocationIsOccupiedError",
            detail: "LocationIsOccupiedError: destination occupied",
          },
        },
      ],
    },
    moduleStatusSnapshot: { blockers: [] },
    robotStatusSnapshot: { blockers: [] },
  });

  assert.equal(parsed.error_category, "DESTINATION_OCCUPIED");
  assert.equal(parsed.error_leaf, "DESTINATION_OCCUPIED");
  assert.equal(parsed.target_slot, "B1");
  assert.equal(parsed.source_labware_id, "labware-1");
  assert.equal(parsed.escalate_to_human, true);
  assert.equal(parsed.hard_stop, false);
  assert.equal(parsed.actionability, "manual_only");
  assert.equal(parsed.auto_executable, false);
});

test("parseRuntimeError classifies liquidNotFound as manual-only insufficient volume", () => {
  const parsed = parseRuntimeError({
    run: {
      data: {
        id: "run-liquid-empty",
        status: "awaiting-recovery",
      },
    },
    commands: {
      data: [
        {
          id: "cmd-liquid-1",
          commandType: "liquidProbe",
          status: "failed",
          params: {
            labwareId: "plate-1",
            wellName: "A12",
          },
          error: {
            errorType: "liquidNotFound",
            detail: "Liquid Not Found",
            wrappedErrors: [
              {
                errorType: "PipetteLiquidNotFoundError",
                detail: "Liquid not found during probe.",
              },
            ],
          },
        },
      ],
    },
    moduleStatusSnapshot: { blockers: [] },
    robotStatusSnapshot: { blockers: [] },
  });

  assert.equal(parsed.error_category, "INSUFFICIENT_VOLUME");
  assert.equal(parsed.error_leaf, "INSUFFICIENT_VOLUME");
  assert.equal(parsed.failed_well, "A12");
  assert.equal(parsed.source_labware_id, "plate-1");
  assert.equal(parsed.actionability, "manual_only");
  assert.equal(parsed.auto_executable, false);
  assert.equal(parsed.requires_human_review, true);
  assert.equal(parsed.escalate_to_human, false);
  assert.equal(parsed.hard_stop, false);
});

test("listAvailableSlots groups slots by availability", () => {
  const sessionState = buildSessionState();
  const observed = buildObservedDeckState({
    deckConfiguration: {
      data: {
        cutoutFixtures: [
          { cutoutFixtureId: "thermocyclerModuleV2Rear", cutoutId: "cutoutA1" },
          { cutoutFixtureId: "singleCenterSlot", cutoutId: "cutoutA2" },
          { cutoutFixtureId: "singleCenterSlot", cutoutId: "cutoutB2" },
          { cutoutFixtureId: "trashBinAdapter", cutoutId: "cutoutA3" },
        ],
      },
    },
    modules: {
      data: [{ serialNumber: "TC123", moduleModel: "thermocyclerModuleV2", moduleOffset: { slot: "A1" } }],
    },
    run: {
      data: {
        labware: [
          { id: "plate-1", loadName: "plate_96", location: { slotName: "A2" } },
        ],
      },
    },
  });

  const result = listAvailableSlots({ observedDeckState: observed, sessionState, filter: "all" });

  assert.equal(result.all_slots.length, 12);
  assert.equal(result.occupied_slots.length, 3);
  assert.equal(result.empty_slots.length, 0);
  assert.equal(result.unknown_slots.length, 9);
  assert.ok(result.by_slot.A1.occupant_type === "module");
  assert.ok(result.by_slot.A2.occupant_type === "labware");
  assert.ok(result.by_slot.A3.occupant_type === "trash_bin");
});

test("listAvailableSlots with empty filter returns unoccupied slots including unknown", () => {
  const sessionState = buildSessionState();
  const observed = buildObservedDeckState({
    deckConfiguration: {
      data: {
        cutoutFixtures: [
          { cutoutFixtureId: "singleCenterSlot", cutoutId: "cutoutA2" },
          { cutoutFixtureId: "singleCenterSlot", cutoutId: "cutoutB2" },
        ],
      },
    },
    run: {
      data: {
        labware: [{ id: "plate-1", loadName: "plate_96", location: { slotName: "A2" } }],
      },
    },
  });

  const result = listAvailableSlots({ observedDeckState: observed, sessionState, filter: "empty" });

  // empty filter returns both unknown and empty slots (all non-occupied)
  assert.equal(result.length, 11);
  assert.ok(result.every(slot => slot.observed_status !== "occupied"));
});

test("buildActionSummary extracts actionable parameters from recovery", () => {
  const recoverySuggestion = {
    error_category: "TIP_PHYSICALLY_MISSING",
    action: "retry_pick_up_tip_with_next_candidate",
    escalate_to_human: false,
    rationale: "run_is_awaiting_recovery",
    suggested_tip: { well_name: "B1", tiprack_slot: "C2" },
    intent: "fixit",
    should_resume_run: true,
  };

  const summary = buildActionSummary({
    recoverySuggestion,
    nextTipSuggestion: {
      next_candidate: { well_name: "B1", tiprack_slot: "C2" },
    },
  });

  assert.equal(summary.do_what, "retry_pick_up_tip_with_next_candidate");
  assert.equal(summary.params.well, "B1");
  assert.equal(summary.params.tiprack_slot, "C2");
  assert.equal(summary.params.intent, "fixit");
  assert.equal(summary.then_resume, true);
  assert.equal(summary.if_fails, "escalate_tip_search_exhausted");
  assert.equal(summary.escalate_to_human, false);
});

test("buildActionSummary includes candidate slots for destination recovery", () => {
  const recoverySuggestion = {
    error_category: "DESTINATION_OCCUPIED",
    action: "suggest_new_destination_slot",
    escalate_to_human: true,
    rationale: "protocol_context_destination_occupied",
    slot_occupation: {
      slot_name: "B1",
    },
    candidate_destination_slots: [
      { slot_name: "C2", confidence: "high" },
      { slot_name: "D2", confidence: "low" },
    ],
  };

  const summary = buildActionSummary({
    recoverySuggestion,
  });

  assert.equal(summary.do_what, "suggest_new_destination_slot");
  assert.equal(summary.params.target_slot, "B1");
  assert.equal(summary.params.candidate_destination_slots[0].slot_name, "C2");
  assert.equal(summary.then_resume, true);
  assert.equal(summary.if_fails, "human_choose_destination_slot");
});

test("suggestAlternativeSlots returns addressable non-occupied slots with confidence", () => {
  const sessionState = buildSessionState();
  const observed = buildObservedDeckState({
    deckConfiguration: {
      data: {
        cutoutFixtures: [
          { cutoutFixtureId: "singleCenterSlot", cutoutId: "cutoutA1" },
          { cutoutFixtureId: "singleCenterSlot", cutoutId: "cutoutA2" },
          { cutoutFixtureId: "singleCenterSlot", cutoutId: "cutoutB1" },
        ],
      },
    },
    run: {
      data: {
        labware: [{ id: "plate-1", loadName: "plate_96", location: { slotName: "A1" } }],
      },
    },
  });

  const alternatives = suggestAlternativeSlots({
    observedDeckState: observed,
    sessionState,
    targetSlot: "A1",
  });

  assert.equal(alternatives[0].slot_name, "A2");
  assert.equal(alternatives[0].confidence, "low");
  assert.ok(alternatives.every(slot => slot.slot_name !== "A1"));
});

test("buildRecoverySuggestion recommends alternative destination slots when available", () => {
  const suggestion = buildRecoverySuggestion({
    errorCategory: "DESTINATION_OCCUPIED",
    errorLeaf: "DESTINATION_OCCUPIED",
    run: { data: { status: "running" } },
    commands: { data: [] },
    robotStatusSnapshot: { blockers: [] },
    moduleStatusSnapshot: { blockers: [] },
    slotOccupation: {
      slot_name: "B1",
      status: "occupied",
      occupant_type: "labware",
      occupant_name: "plate_96",
    },
    reconciliation: { diffs: [] },
    alternativeSlots: [
      { slot_name: "C2", status: "empty", addressable: true, confidence: "high" },
      { slot_name: "D2", status: "unknown", addressable: true, confidence: "low" },
    ],
  });

  assert.equal(suggestion.action, "manual_only");
  assert.equal(suggestion.actionability, "manual_only");
  assert.equal(suggestion.auto_executable, false);
  assert.equal(suggestion.requires_confirmation, true);
  assert.equal(suggestion.required_inputs[0], "destination_slot");
  assert.equal(suggestion.recommended_manual_action, "suggest_new_destination_slot");
  assert.equal(suggestion.escalate_to_human, true);
  assert.equal(suggestion.candidate_destination_slots[0].slot_name, "C2");
  assert.equal(suggestion.hard_stop, false);
});

test("buildRecoverySuggestion keeps protocol destination recovery human-reviewed even with confident slot", () => {
  const suggestion = buildRecoverySuggestion({
    errorCategory: "DESTINATION_OCCUPIED",
    errorLeaf: "DESTINATION_OCCUPIED",
    run: { data: { status: "awaiting-recovery", currentlyRecoveringFrom: "cmd-1" } },
    commands: { data: [] },
    robotStatusSnapshot: { blockers: [] },
    moduleStatusSnapshot: { blockers: [] },
    slotOccupation: {
      slot_name: "B1",
      status: "occupied",
      occupant_type: "labware",
      occupant_name: "plate_96",
    },
    reconciliation: { diffs: [] },
    alternativeSlots: [{ slot_name: "C2", status: "empty", addressable: true, confidence: "high" }],
  });

  assert.equal(suggestion.action, "suggest_new_destination_slot");
  assert.equal(suggestion.actionability, "manual_confirmation_required");
  assert.equal(suggestion.auto_executable, true);
  assert.equal(suggestion.requires_confirmation, true);
  assert.equal(suggestion.escalate_to_human, true);
  assert.equal(suggestion.rationale, "protocol_context_destination_occupied");
  assert.equal(suggestion.hard_stop, false);
});

test("buildRecoverySuggestion escalates when destination recovery has no candidates", () => {
  const suggestion = buildRecoverySuggestion({
    errorCategory: "DESTINATION_OCCUPIED",
    errorLeaf: "DESTINATION_OCCUPIED",
    run: { data: { status: "running" } },
    commands: { data: [] },
    robotStatusSnapshot: { blockers: [] },
    moduleStatusSnapshot: { blockers: [] },
    slotOccupation: {
      slot_name: "B1",
      status: "occupied",
      occupant_type: "labware",
      occupant_name: "plate_96",
    },
    reconciliation: { diffs: [] },
    alternativeSlots: [],
  });

  assert.equal(suggestion.action, "manual_only");
  assert.equal(suggestion.actionability, "manual_only");
  assert.equal(suggestion.recommended_manual_action, "choose_new_slot_or_escalate");
  assert.equal(suggestion.escalate_to_human, true);
  assert.equal(suggestion.hard_stop, false);
});

test("buildRecoverySuggestion keeps liquid issues manual-only when no supported fixit exists", () => {
  const suggestion = buildRecoverySuggestion({
    errorCategory: "INSUFFICIENT_VOLUME",
    errorLeaf: "INSUFFICIENT_VOLUME",
    run: {
      data: {
        status: "awaiting-recovery",
        labware: [
          {
            id: "plate-1",
            loadName: "corning_96_wellplate_360ul_flat",
            location: { slotName: "D3" },
          },
        ],
      },
    },
    commands: {
      data: [
        {
          id: "cmd-liquid-empty",
          commandType: "liquidProbe",
          status: "failed",
          params: {
            labwareId: "plate-1",
            wellName: "A12",
          },
          error: {
            errorType: "liquidNotFound",
            detail: "Liquid Not Found",
          },
        },
      ],
    },
    robotStatusSnapshot: {
      blockers: [],
      instruments_summary: [
        { mount: "left", instrument_name: "p1000_single_flex", tip_detected: true },
      ],
    },
    moduleStatusSnapshot: { blockers: [] },
    reconciliation: { diffs: [] },
    sessionState: {
      ...buildSessionState(),
      liquid_tracking: {
        sources: {
          "D3.A12": {
            slot_name: "D3",
            well_name: "A12",
            labware_load_name: "corning_96_wellplate_360ul_flat",
            liquid_name: "water",
            sample_id: "empty-control",
            expected_presence: false,
          },
        },
      },
    },
  });

  assert.equal(suggestion.action, "manual_only");
  assert.equal(suggestion.actionability, "manual_only");
  assert.equal(suggestion.auto_executable, false);
  assert.equal(suggestion.recommended_manual_action, "probe_or_reduce_volume_then_retry");
  assert.equal(suggestion.failed_well, "A12");
  assert.equal(suggestion.source_labware_id, "plate-1");
  assert.equal(suggestion.source_slot, "D3");
  assert.equal(suggestion.source_map_key, "D3.A12");
  assert.equal(suggestion.liquid_source.sample_id, "empty-control");
  assert.equal(suggestion.source_map_expected_presence, false);
  assert.equal(suggestion.observed_liquid_presence, false);
  assert.equal(suggestion.source_map_expectation_mismatch, true);
  assert.equal(suggestion.failed_command_id, "cmd-liquid-empty");
  assert.equal(suggestion.failed_command_type, "liquidProbe");
  assert.equal(
    suggestion.blocked_auto_recovery_reason,
    "liquid_source_change_requires_human_confirmation",
  );
  assert.deepEqual(suggestion.cleanup_required, ["drop_tip:left"]);
  assert.ok(suggestion.operator_steps.some(step => step.includes("A12")));
  assert.ok(suggestion.operator_steps.some(step => step.includes("empty-control")));
  assert.ok(suggestion.operator_steps.some(step => step.includes("expected to be empty")));
  assert.ok(suggestion.operator_steps.some(step => step.includes("confirmed source map")));
});

test("buildRecoverySuggestion flags expected-present liquid source that probes as empty", () => {
  const suggestion = buildRecoverySuggestion({
    errorCategory: "INSUFFICIENT_VOLUME",
    errorLeaf: "INSUFFICIENT_VOLUME",
    run: {
      data: {
        status: "awaiting-recovery",
        labware: [
          {
            id: "plate-1",
            loadName: "corning_96_wellplate_360ul_flat",
            location: { slotName: "D3" },
          },
        ],
      },
    },
    commands: {
      data: [
        {
          id: "cmd-liquid-air",
          commandType: "liquidProbe",
          status: "failed",
          params: {
            labwareId: "plate-1",
            wellName: "A1",
          },
          error: {
            errorType: "liquidNotFound",
            detail: "Liquid Not Found",
          },
        },
      ],
    },
    robotStatusSnapshot: {
      blockers: [],
      instruments_summary: [
        { mount: "left", instrument_name: "p1000_single_flex", tip_detected: true },
      ],
    },
    moduleStatusSnapshot: { blockers: [] },
    reconciliation: { diffs: [] },
    sessionState: {
      ...buildSessionState(),
      liquid_tracking: {
        sources: {
          "D3.A1": {
            slot_name: "D3",
            well_name: "A1",
            labware_load_name: "corning_96_wellplate_360ul_flat",
            liquid_name: "operator-confirmed-liquid",
            sample_id: "sample-a1",
            expected_presence: true,
          },
        },
      },
    },
  });

  assert.equal(suggestion.action, "manual_only");
  assert.equal(suggestion.auto_executable, false);
  assert.equal(suggestion.failed_well, "A1");
  assert.equal(suggestion.source_map_key, "D3.A1");
  assert.equal(suggestion.liquid_source.sample_id, "sample-a1");
  assert.equal(suggestion.source_map_expected_presence, true);
  assert.equal(suggestion.observed_liquid_presence, false);
  assert.equal(suggestion.source_map_expectation_mismatch, true);
  assert.equal(
    suggestion.blocked_auto_recovery_reason,
    "liquid_source_change_requires_human_confirmation",
  );
  assert.deepEqual(suggestion.cleanup_required, ["drop_tip:left"]);
  assert.ok(suggestion.operator_steps.some(step => step.includes("should contain liquid")));
  assert.ok(suggestion.operator_steps.some(step => step.includes("did not find liquid")));
  assert.ok(suggestion.operator_steps.some(step => step.includes("fill height")));
  assert.ok(suggestion.operator_steps.some(step => step.includes("sample sample-a1")));
});

test("buildRecoverySuggestion lists same-liquid water alternatives without pretending auto resume exists", () => {
  const suggestion = buildRecoverySuggestion({
    errorCategory: "INSUFFICIENT_VOLUME",
    errorLeaf: "INSUFFICIENT_VOLUME",
    run: {
      data: {
        status: "awaiting-recovery",
        labware: [
          {
            id: "plate-1",
            loadName: "corning_96_wellplate_360ul_flat",
            location: { slotName: "D3" },
          },
        ],
      },
    },
    commands: {
      data: [
        {
          id: "cmd-liquid-air",
          commandType: "liquidProbe",
          status: "failed",
          params: {
            labwareId: "plate-1",
            wellName: "A1",
          },
          error: {
            errorType: "liquidNotFound",
            detail: "Liquid Not Found",
          },
        },
      ],
    },
    robotStatusSnapshot: {
      blockers: ["attached_tip:left"],
      instruments_summary: [
        { mount: "left", instrument_name: "p1000_single_flex", tip_detected: true },
      ],
    },
    moduleStatusSnapshot: { blockers: [] },
    reconciliation: { diffs: [] },
    sessionState: {
      ...buildSessionState(),
      liquid_tracking: {
        sources: {
          "D3.A1": {
            slot_name: "D3",
            well_name: "A1",
            labware_load_name: "corning_96_wellplate_360ul_flat",
            liquid_name: "water",
            sample_id: "water-d3-a1",
            expected_presence: true,
          },
          "D3.B1": {
            slot_name: "D3",
            well_name: "B1",
            labware_load_name: "corning_96_wellplate_360ul_flat",
            liquid_name: "water",
            sample_id: "water-d3-b1",
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
          "D3.C1": {
            slot_name: "D3",
            well_name: "C1",
            labware_load_name: "corning_96_wellplate_360ul_flat",
            liquid_name: "buffer",
            sample_id: "buffer-c1",
            expected_presence: true,
          },
          "D3.D1": {
            slot_name: "D3",
            well_name: "D1",
            labware_load_name: "corning_96_wellplate_360ul_flat",
            liquid_name: "water",
            sample_id: "empty-water-control",
            expected_presence: false,
          },
        },
      },
    },
  });

  assert.equal(suggestion.action, "manual_only");
  assert.equal(suggestion.auto_executable, false);
  assert.equal(suggestion.source_map_key, "D3.A1");
  assert.equal(suggestion.same_liquid_source_candidate_count, 2);
  assert.deepEqual(
    suggestion.same_liquid_source_candidates.map(source => source.source_map_key),
    ["D3.B1", "C3.A1"],
  );
  assert.equal(suggestion.same_liquid_source_substitution_allowed, true);
  assert.equal(
    suggestion.same_liquid_source_substitution_next_tool,
    "prepare_liquid_source_substitution_recovery",
  );
  assert.equal(
    suggestion.same_liquid_source_substitution_playbook,
    "liquid_source_substitution_continuation_protocol",
  );
  assert.deepEqual(suggestion.same_liquid_source_substitution_required_gates, [
    "live_liquid_recovery_gate",
    "run_protocol_only_after_operator_opt_in",
  ]);
  assert.equal(suggestion.same_liquid_auto_resume_eligible, false);
  assert.deepEqual(suggestion.blockers, ["attached_tip:left"]);
  assert.deepEqual(suggestion.cleanup_required, ["drop_tip:left"]);
  assert.equal(
    suggestion.same_liquid_auto_resume_blocker,
    "live_gate_and_operator_opt_in_required_before_any_robot_motion",
  );
  assert.equal(
    suggestion.blocked_auto_recovery_reason,
    "same_liquid_source_substitution_requires_prepared_recovery_bundle_and_live_gate",
  );
  assert.ok(suggestion.operator_steps.some(step => step.includes("Same-liquid alternatives")));

  const summary = buildActionSummary({ recoverySuggestion: suggestion });
  assert.equal(summary.do_what, "manual_only");
  assert.equal(summary.then_resume, false);
  assert.equal(summary.params.same_liquid_source_candidate_count, 2);
  assert.equal(summary.params.same_liquid_source_substitution_allowed, true);
  assert.equal(
    summary.params.same_liquid_source_substitution_next_tool,
    "prepare_liquid_source_substitution_recovery",
  );
  assert.equal(
    summary.params.same_liquid_source_substitution_playbook,
    "liquid_source_substitution_continuation_protocol",
  );
  assert.deepEqual(summary.params.same_liquid_source_substitution_required_gates, [
    "live_liquid_recovery_gate",
    "run_protocol_only_after_operator_opt_in",
  ]);
  assert.equal(summary.params.same_liquid_auto_resume_eligible, false);
  assert.deepEqual(summary.params.blockers, ["attached_tip:left"]);
  assert.deepEqual(summary.params.cleanup_required, ["drop_tip:left"]);
  assert.equal(summary.params.same_liquid_source_candidates[0].source_map_key, "D3.B1");
});

test("buildActionSummary carries liquid manual-recovery context", () => {
  const recoverySuggestion = {
    action: "manual_only",
    error_category: "INSUFFICIENT_VOLUME",
    error_leaf: "INSUFFICIENT_VOLUME",
    actionability: "manual_only",
    auto_executable: false,
    requires_confirmation: false,
    required_inputs: [],
    escalate_to_human: true,
    rationale: "runtime_volume_issue_detected",
    recommended_manual_action: "probe_or_reduce_volume_then_retry",
    failed_well: "A12",
    source_labware_id: "plate-1",
    source_slot: "D3",
    source_map_key: "D3.A12",
    liquid_source: {
      slot_name: "D3",
      well_name: "A12",
      liquid_name: "water",
      sample_id: "empty-control",
    },
    source_map_expected_presence: false,
    observed_liquid_presence: false,
    source_map_expectation_mismatch: true,
    failed_command_id: "cmd-liquid-empty",
    failed_command_type: "liquidProbe",
    blocked_auto_recovery_reason: "liquid_source_change_requires_human_confirmation",
    cleanup_required: ["drop_tip:left"],
    operator_steps: [
      "Verify or refill the intended source well A12.",
      "Do not change source wells unless the operator provides a confirmed source map.",
    ],
  };

  const summary = buildActionSummary({ recoverySuggestion });

  assert.equal(summary.do_what, "manual_only");
  assert.equal(summary.then_resume, false);
  assert.equal(summary.if_fails, "manual_intervention");
  assert.equal(summary.params.failed_well, "A12");
  assert.equal(summary.params.source_labware_id, "plate-1");
  assert.equal(summary.params.source_slot, "D3");
  assert.equal(summary.params.source_map_key, "D3.A12");
  assert.equal(summary.params.liquid_source.sample_id, "empty-control");
  assert.equal(summary.params.source_map_expected_presence, false);
  assert.equal(summary.params.observed_liquid_presence, false);
  assert.equal(summary.params.source_map_expectation_mismatch, true);
  assert.equal(summary.params.failed_command_id, "cmd-liquid-empty");
  assert.equal(summary.params.failed_command_type, "liquidProbe");
  assert.equal(
    summary.params.blocked_auto_recovery_reason,
    "liquid_source_change_requires_human_confirmation",
  );
  assert.deepEqual(summary.params.cleanup_required, ["drop_tip:left"]);
  assert.ok(summary.params.operator_steps.some(step => step.includes("confirmed source map")));
});

test("collision and unknown classes are explicit hard stops", () => {
  const collisionSuggestion = buildRecoverySuggestion({
    errorCategory: "DECK_COLLISION",
    run: { data: { status: "failed" } },
    commands: { data: [] },
    robotStatusSnapshot: { blockers: [] },
    moduleStatusSnapshot: { blockers: [] },
    reconciliation: { diffs: [] },
  });
  const unknownSuggestion = buildRecoverySuggestion({
    errorCategory: "UNKNOWN",
    run: { data: { status: "failed" } },
    commands: { data: [] },
    robotStatusSnapshot: { blockers: [] },
    moduleStatusSnapshot: { blockers: [] },
    reconciliation: { diffs: [] },
  });

  assert.equal(isHardStopErrorCategory("DECK_COLLISION"), true);
  assert.equal(isHardStopErrorCategory("UNKNOWN"), true);
  assert.equal(isHardStopErrorCategory("DESTINATION_OCCUPIED"), false);
  assert.equal(collisionSuggestion.hard_stop, true);
  assert.equal(collisionSuggestion.escalate_to_human, true);
  assert.equal(unknownSuggestion.hard_stop, true);
  assert.equal(unknownSuggestion.escalate_to_human, true);
});

test("parseRuntimeError marks collision-class failures as hard stops", () => {
  const parsed = parseRuntimeError({
    run: { data: { id: "run-collision", status: "failed" } },
    commands: {
      data: [
        {
          id: "cmd-collision-1",
          commandType: "moveLabware",
          status: "failed",
          error: {
            errorType: "StallOrCollisionError",
            detail: "stallOrCollision while moving labware",
          },
        },
      ],
    },
    moduleStatusSnapshot: { blockers: [] },
    robotStatusSnapshot: { blockers: [] },
  });

  assert.equal(parsed.error_category, "DECK_COLLISION");
  assert.equal(parsed.hard_stop, true);
  assert.equal(parsed.escalate_to_human, true);
});
