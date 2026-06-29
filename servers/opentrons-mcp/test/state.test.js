import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import {
  applyStep,
  readSessionState,
  setLiquidContainerState,
  setLiquidSourceState,
  validateVirtualLabStateSteps,
  appendStateHistoryEntry,
  MAX_STATE_HISTORY_ENTRIES,
} from "../lib/state.js";

function buildState() {
  return {
    session_id: "virtual-lab-test",
    state_revision: 0,
    deck: { slots: {} },
    pipettes: {},
    tip_tracking: { tipracks: {} },
    liquid_tracking: { containers: {}, sources: {} },
    state_history: [],
    cleanup: { pending_actions: [], auto_home_allowed: null },
  };
}

test("readSessionState upgrades legacy liquid_tracking.sources into containers", () => {
  const originalSessionDir = process.env.OPENTRONS_SESSION_STATE_DIR;
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "virtual-lab-state-"));
  process.env.OPENTRONS_SESSION_STATE_DIR = sessionDir;

  try {
    fs.writeFileSync(
      path.join(sessionDir, "legacy-liquid.json"),
      `${JSON.stringify({
        session_id: "legacy-liquid",
        liquid_tracking: {
          sources: {
            "D3.A1": {
              slot_name: "D3",
              well_name: "A1",
              liquid_name: "water",
              volume_ul: 120,
              capacity_ul: 300,
              dead_volume_ul: 10,
              liquid_class: "aqueous",
              trust_level: "declared",
            },
          },
        },
      })}\n`,
    );

    const state = readSessionState("legacy-liquid");
    assert.equal(state.liquid_tracking.sources["D3.A1"].volume_ul, 120);
    assert.equal(state.liquid_tracking.containers["D3.A1"].role, "source");
    assert.equal(state.liquid_tracking.containers["D3.A1"].dead_volume_ul, 10);
    assert.equal(state.liquid_tracking.containers["D3.A1"].liquid_class, "aqueous");
  } finally {
    if (originalSessionDir === undefined) {
      delete process.env.OPENTRONS_SESSION_STATE_DIR;
    } else {
      process.env.OPENTRONS_SESSION_STATE_DIR = originalSessionDir;
    }
  }
});

test("setLiquidSourceState writes quant fields, trust level, containers mirror, and history", () => {
  const state = buildState();
  const entry = setLiquidSourceState(state, {
    slot_name: "d3",
    well_name: "a1",
    liquid_name: "water",
    sample_id: "sample-a",
    volume_ul: 80,
    capacity_ul: 200,
    dead_volume_ul: 5,
    liquid_class: "aqueous",
    trust_level: "observed",
  });

  assert.equal(entry.key, "D3.A1");
  assert.equal(state.liquid_tracking.containers["D3.A1"].volume_ul, 80);
  assert.equal(state.liquid_tracking.sources["D3.A1"].trust_level, "observed");
  assert.ok(
    state.state_history.some(history => history.field === "liquid_tracking.containers.D3.A1.volume_ul"),
  );
});

test("applyStep records valid simulated transfer volume changes in append-only history", () => {
  const state = buildState();
  state.pipettes.left = { tip_attached: true };
  setLiquidContainerState(state, {
    container_key: "D3.A1",
    role: "source",
    volume_ul: 100,
    capacity_ul: 200,
    dead_volume_ul: 10,
  });
  setLiquidContainerState(state, {
    container_key: "C3.A1",
    role: "destination",
    volume_ul: 0,
    capacity_ul: 100,
    dead_volume_ul: 0,
  });

  const result = applyStep(state, {
    id: "transfer-1",
    type: "transfer",
    source_key: "D3.A1",
    target_key: "C3.A1",
    volume_ul: 25,
    pipette_id: "left",
  });

  assert.deepEqual(result.violations, []);
  assert.equal(result.state.liquid_tracking.containers["D3.A1"].volume_ul, 75);
  assert.equal(result.state.liquid_tracking.containers["C3.A1"].volume_ul, 25);
  assert.ok(
    result.state.state_history.some(
      history =>
        history.step?.id === "transfer-1" &&
        history.field === "liquid_tracking.containers.D3.A1.volume_ul" &&
        history.old_value === 100 &&
        history.new_value === 75,
    ),
  );
});

test("validateVirtualLabStateSteps blocks overflow and source depletion before simulation", () => {
  const state = buildState();
  state.pipettes.left = { tip_attached: true };
  setLiquidContainerState(state, {
    container_key: "D3.A1",
    role: "source",
    volume_ul: 50,
    capacity_ul: 100,
    dead_volume_ul: 5,
  });
  setLiquidContainerState(state, {
    container_key: "C3.A1",
    role: "destination",
    volume_ul: 15,
    capacity_ul: 40,
    dead_volume_ul: 0,
  });

  const result = validateVirtualLabStateSteps(state, [
    {
      id: "intentional-overflow",
      type: "transfer",
      source_key: "D3.A1",
      target_key: "C3.A1",
      volume_ul: 30,
      pipette_id: "left",
    },
    {
      id: "intentional-source-depletion",
      type: "transfer",
      source_key: "D3.A1",
      target_key: "C3.A1",
      volume_ul: 46,
      pipette_id: "left",
    },
  ]);

  const codes = result.violations.map(violation => violation.code);
  assert.equal(result.ok, false);
  assert.ok(codes.includes("liquid_volume_exceeds_capacity"));
  assert.ok(codes.includes("aspirate_exceeds_available_volume"));
  assert.equal(result.state.liquid_tracking.containers["D3.A1"].volume_ul, 50);
  assert.equal(result.state.liquid_tracking.containers["C3.A1"].volume_ul, 15);
});

test("applyStep blocks single-use tip reuse", () => {
  const state = buildState();
  state.tip_tracking.tipracks.C2 = {
    slot_name: "C2",
    load_name: "opentrons_flex_96_tiprack_1000ul",
    search_order: ["A1"],
    missing_wells: [],
    depleted_wells: ["A1"],
    unknown_blocked_wells: [],
  };

  const result = applyStep(state, {
    id: "reuse-tip",
    type: "pick_up_tip",
    pipette_id: "left",
    tiprack_slot: "C2",
    well_name: "A1",
  });

  assert.equal(result.violations[0].code, "tip_reuse_violation");
  assert.equal(result.state.pipettes.left, undefined);
});

test("appendStateHistoryEntry caps state_history to MAX_STATE_HISTORY_ENTRIES keeping the newest", () => {
  const state = buildState();
  for (let index = 0; index < MAX_STATE_HISTORY_ENTRIES + 50; index += 1) {
    appendStateHistoryEntry(state, {
      step: { id: `step-${index}` },
      field: `counter.${index}`,
      oldValue: index,
      newValue: index + 1,
      why: "cap-test",
    });
  }
  assert.equal(state.state_history.length, MAX_STATE_HISTORY_ENTRIES);
  assert.equal(state.state_history[0].field, `counter.${50}`);
  assert.equal(
    state.state_history[state.state_history.length - 1].field,
    `counter.${MAX_STATE_HISTORY_ENTRIES + 49}`,
  );
});

test("applyStep mix validates tip and available volume without changing net volume", () => {
  const state = buildState();
  state.pipettes.left = { tip_attached: true };
  setLiquidContainerState(state, {
    container_key: "D3.A1",
    role: "source",
    volume_ul: 20,
    capacity_ul: 200,
    dead_volume_ul: 5,
  });

  const ok = applyStep(state, {
    id: "mix-ok",
    type: "mix",
    source_key: "D3.A1",
    volume_ul: 10,
    pipette_id: "left",
  });
  assert.deepEqual(ok.violations, []);
  assert.equal(ok.state.liquid_tracking.containers["D3.A1"].volume_ul, 20);

  const tooMuch = applyStep(state, {
    id: "mix-too-much",
    type: "mix",
    source_key: "D3.A1",
    volume_ul: 20,
    pipette_id: "left",
  });
  assert.ok(tooMuch.violations.some(v => v.code === "aspirate_exceeds_available_volume"));
  assert.equal(tooMuch.state.liquid_tracking.containers["D3.A1"].volume_ul, 20);
});

test("applyStep blow_out adds residual volume to the target and checks capacity", () => {
  const state = buildState();
  state.pipettes.left = { tip_attached: true };
  setLiquidContainerState(state, {
    container_key: "C3.A1",
    role: "destination",
    volume_ul: 35,
    capacity_ul: 40,
    dead_volume_ul: 0,
  });

  const ok = applyStep(state, {
    id: "blow-out-ok",
    type: "blow_out",
    target_key: "C3.A1",
    volume_ul: 3,
    pipette_id: "left",
  });
  assert.deepEqual(ok.violations, []);
  assert.equal(ok.state.liquid_tracking.containers["C3.A1"].volume_ul, 38);

  const overflow = applyStep(state, {
    id: "blow-out-overflow",
    type: "blow_out",
    target_key: "C3.A1",
    volume_ul: 6,
    pipette_id: "left",
  });
  assert.ok(overflow.violations.some(v => v.code === "liquid_volume_exceeds_capacity"));
});

test("applyStep load_labware and load_pipette declare deck/pipette state", () => {
  const state = buildState();

  const labware = applyStep(state, {
    id: "load-rack",
    type: "load_labware",
    slot_name: "C2",
    load_name: "opentrons_flex_96_tiprack_1000ul",
  });
  assert.deepEqual(labware.violations, []);
  assert.equal(labware.state.deck.slots.C2.occupant_name, "opentrons_flex_96_tiprack_1000ul");

  const pipette = applyStep(state, {
    id: "load-pipette",
    type: "load_pipette",
    pipette_id: "left",
    pipette_name: "flex_1channel_1000",
  });
  assert.deepEqual(pipette.violations, []);
  assert.equal(pipette.state.pipettes.left.instrument_name, "flex_1channel_1000");
});

test("applyStep treats no-op step types as valid without state changes", () => {
  const state = buildState();
  state.pipettes.left = { tip_attached: true };

  const comment = applyStep(state, { id: "note", type: "comment", message: "cycle 1" });
  assert.deepEqual(comment.violations, []);

  const airGap = applyStep(state, { id: "gap", type: "air_gap", volume_ul: 5, pipette_id: "left" });
  assert.deepEqual(airGap.violations, []);

  const module = applyStep(state, { id: "temp", type: "set_temperature", module_id: "thermocycler" });
  assert.deepEqual(module.violations, []);
});

test("applyStep auto_declare creates missing containers and skips unknown-volume checks", () => {
  const state = buildState();
  state.pipettes.left = { tip_attached: true };
  state.auto_declare_containers = true;

  const result = applyStep(state, {
    id: "auto-declared-transfer",
    type: "transfer",
    source_key: "D3.A1",
    target_key: "C3.A1",
    volume_ul: 25,
    pipette_id: "left",
  });

  assert.deepEqual(result.violations, []);
  assert.ok(result.state.liquid_tracking.containers["D3.A1"]);
  assert.ok(result.state.liquid_tracking.containers["C3.A1"]);
  assert.equal(result.state.liquid_tracking.containers["D3.A1"].volume_ul, null);
  assert.equal(result.state.liquid_tracking.containers["D3.A1"].trust_level, "declared");
});

test("applyStep strict_volumes re-enables the missing-volume prerequisite error", () => {
  const state = buildState();
  state.pipettes.left = { tip_attached: true };
  setLiquidContainerState(state, {
    container_key: "D3.A1",
    role: "source",
    volume_ul: null,
    capacity_ul: 200,
  });

  const strict = applyStep(state, {
    id: "strict-transfer",
    type: "aspirate",
    source_key: "D3.A1",
    volume_ul: 10,
    pipette_id: "left",
    strict_volumes: true,
  });
  assert.ok(strict.violations.some(v => v.code === "missing_required_prerequisite"));

  const permissive = applyStep(state, {
    id: "permissive-transfer",
    type: "aspirate",
    source_key: "D3.A1",
    volume_ul: 10,
    pipette_id: "left",
  });
  assert.deepEqual(permissive.violations, []);
});
