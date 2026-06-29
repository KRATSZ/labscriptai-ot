import test from "node:test";
import assert from "node:assert/strict";

import { TOOL_HANDLERS } from "../index.js";

function initialState() {
  return {
    session_id: "simulate-gate-test",
    state_revision: 1,
    deck: { slots: {} },
    pipettes: { left: { tip_attached: true } },
    tip_tracking: { tipracks: {} },
    liquid_tracking: {
      containers: {
        "D3.A1": {
          key: "D3.A1",
          container_key: "D3.A1",
          role: "source",
          slot_name: "D3",
          well_name: "A1",
          liquid_name: "water",
          volume_ul: 50,
          capacity_ul: 100,
          dead_volume_ul: 5,
          trust_level: "declared",
        },
        "C3.A1": {
          key: "C3.A1",
          container_key: "C3.A1",
          role: "destination",
          slot_name: "C3",
          well_name: "A1",
          volume_ul: 15,
          capacity_ul: 40,
          dead_volume_ul: 0,
          trust_level: "declared",
        },
      },
      sources: {},
    },
    state_history: [],
    cleanup: { pending_actions: [], auto_home_allowed: null },
  };
}

test("simulate_protocol gate blocks on overflow before spawning Python", async () => {
  const result = await TOOL_HANDLERS.simulate_protocol({
    protocol_path: "/tmp/ignored-because-gate-blocks.py",
    initial_state: initialState(),
    virtual_lab_steps: [
      {
        id: "intentional-overflow",
        type: "transfer",
        source_key: "D3.A1",
        target_key: "C3.A1",
        volume_ul: 30,
        pipette_id: "left",
      },
    ],
  });

  assert.equal(result.data.ok, false);
  assert.equal(result.data.blocked_by, "virtual_lab_state_validation");
  assert.equal(result.data.no_robot_motion, true);
  assert.equal(result.data.virtual_lab_validation.ok, false);
  const codes = result.data.virtual_lab_validation.violations.map(v => v.code);
  assert.ok(codes.includes("liquid_volume_exceeds_capacity"));
});

test("simulate_protocol gate blocks on source depletion before spawning Python", async () => {
  const result = await TOOL_HANDLERS.simulate_protocol({
    protocol_path: "/tmp/ignored-because-gate-blocks.py",
    initial_state: initialState(),
    virtual_lab_steps: [
      {
        id: "intentional-depletion",
        type: "transfer",
        source_key: "D3.A1",
        target_key: "C3.A1",
        volume_ul: 46,
        pipette_id: "left",
      },
    ],
  });

  assert.equal(result.data.blocked_by, "virtual_lab_state_validation");
  const codes = result.data.virtual_lab_validation.violations.map(v => v.code);
  assert.ok(codes.includes("aspirate_exceeds_available_volume"));
});

test("simulate_protocol gate lets valid steps pass through to the simulator", async () => {
  await assert.rejects(
    TOOL_HANDLERS.simulate_protocol({
      initial_state: initialState(),
      virtual_lab_steps: [
        {
          id: "valid-transfer",
          type: "transfer",
          source_key: "D3.A1",
          target_key: "C3.A1",
          volume_ul: 10,
          pipette_id: "left",
        },
      ],
    }),
    /protocol_path is required/,
  );
});

test("simulate_protocol gate is skipped when skip_virtual_lab_state_validation is true", async () => {
  await assert.rejects(
    TOOL_HANDLERS.simulate_protocol({
      skip_virtual_lab_state_validation: true,
      virtual_lab_steps: [
        {
          id: "would-block",
          type: "transfer",
          source_key: "D3.A1",
          target_key: "C3.A1",
          volume_ul: 999,
          pipette_id: "left",
        },
      ],
    }),
    /protocol_path is required/,
  );
});
