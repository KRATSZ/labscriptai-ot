import test from "node:test";
import assert from "node:assert/strict";

import {
  buildLiquidTrackingSnapshot,
  buildModuleStatusSnapshot,
  buildRobotStatusSnapshot,
  buildRunHistorySnapshot,
} from "../lib/live-state.js";

test("buildRobotStatusSnapshot derives blockers and readiness", () => {
  const snapshot = buildRobotStatusSnapshot({
    health: { name: "Flex", api_version: "4", robot_model: "Flex" },
    instruments: {
      data: [{ mount: "left", instrumentName: "flex_1channel_50", ok: true }],
    },
    doorStatus: { data: { status: "closed" } },
    estopStatus: { data: { status: "disengaged" } },
    deckConfiguration: { data: { cutoutFixtures: [] } },
  });

  assert.equal(snapshot.ready_for_physical_action, true);
  assert.equal(snapshot.blockers.length, 0);
  assert.equal(snapshot.instruments_summary[0].instrument_name, "flex_1channel_50");
});

test("missing or unfamiliar door/estop readings stay unknown without inventing faults", () => {
  for (const status of [null, "unknown", "future-status"]) {
    const snapshot = buildRobotStatusSnapshot({
      health: {}, instruments: { data: [] },
      doorStatus: { data: { status } }, estopStatus: { data: { status } },
    });
    assert.equal(snapshot.door.open, null);
    assert.equal(snapshot.estop.engaged, null);
    assert.deepEqual(snapshot.not_checked, ["door", "estop"]);
    assert.equal(snapshot.ready_for_physical_action, null);
    assert.deepEqual(snapshot.blockers, []);
  }
});

test("official physical and logical estop states still block", () => {
  for (const status of ["physicallyEngaged", "logicallyEngaged", "engaged"]) {
    const snapshot = buildRobotStatusSnapshot({
      doorStatus: { data: { status: "closed" } }, estopStatus: { data: { status } },
    });
    assert.equal(snapshot.estop.engaged, true);
    assert.equal(snapshot.estop.checked, true);
    assert.equal(snapshot.ready_for_physical_action, false);
    assert.deepEqual(snapshot.blockers, ["estop_engaged"]);
  }
});

test("missing instrument readiness stays unknown; an explicit failed instrument blocks", () => {
  const args = { doorStatus: { data: { status: "closed" } }, estopStatus: { data: { status: "disengaged" } } };
  const unknown = buildRobotStatusSnapshot({ ...args, instruments: { data: [{ mount: "left" }] } });
  assert.equal(unknown.instruments_summary[0].ok, null);
  assert.equal(unknown.ready_for_physical_action, null);
  assert.deepEqual(unknown.not_checked, ["instrument:left"]);
  assert.deepEqual(unknown.blockers, []);
  const failed = buildRobotStatusSnapshot({ ...args, instruments: { data: [{ mount: "left", ok: false }] } });
  assert.equal(failed.ready_for_physical_action, false);
  assert.deepEqual(failed.blockers, ["instrument_not_ready"]);
});

test("missing module status or target measurements are unknown, not ready or an observed fault", () => {
  const snapshot = buildModuleStatusSnapshot({ data: [
    { id: "missing", moduleModel: "temperatureModuleV2" },
    { id: "unmeasured", status: "idle", targetTemperature: 37 },
    { id: "faulted", status: "error" },
  ] });
  assert.deepEqual(snapshot.modules.map(item => item.ready), [null, null, false]);
  assert.deepEqual(snapshot.not_checked, ["module:missing", "module:unmeasured"]);
  assert.equal(snapshot.ready_module_count, 0);
  assert.deepEqual(snapshot.blockers, ["module_not_ready:faulted"]);
});

test("invalid temperature and speed readings remain unknown instead of reporting a fault", () => {
  for (const value of ["unknown", "", true, NaN, Infinity]) {
    for (const data of [
      { currentTemperature: value, targetTemperature: 37 },
      { currentTemperature: 37, targetTemperature: value },
      { currentSpeed: value, targetSpeed: 500 },
      { currentSpeed: 500, targetSpeed: value },
    ]) {
      const snapshot = buildModuleStatusSnapshot({ data: [{ id: "mod", status: "idle", ...data }] });
      assert.equal(snapshot.modules[0].ready, null);
      assert.deepEqual(snapshot.blockers, []);
      assert.deepEqual(snapshot.not_checked, ["module:mod"]);
    }
  }
});

test("buildModuleStatusSnapshot flags modules that are not ready", () => {
  const snapshot = buildModuleStatusSnapshot({
    data: [
      {
        id: "tempmod-1",
        moduleModel: "temperatureModuleV2",
        location: { slotName: "D1" },
        currentTemperature: 25,
        targetTemperature: 37,
        status: "heating",
      },
    ],
  });

  assert.equal(snapshot.module_count, 1);
  assert.equal(snapshot.modules[0].ready, false);
  assert.equal(snapshot.blockers[0], "module_not_ready:tempmod-1");
});

test("buildRobotStatusSnapshot reads real instrument tipDetected shape", () => {
  const snapshot = buildRobotStatusSnapshot({
    health: { name: "Flex", api_version: "8.8.1", robot_model: "OT-3 Standard" },
    instruments: {
      data: [
        {
          mount: "left",
          instrumentName: "p1000_single_flex",
          ok: true,
          state: { tipDetected: true },
        },
      ],
    },
    doorStatus: { data: { status: "closed" } },
    estopStatus: { data: { status: "disengaged" } },
    deckConfiguration: { data: { cutoutFixtures: [] } },
  });

  assert.equal(snapshot.instruments_summary[0].tip_detected, true);
});

test("buildModuleStatusSnapshot reads real moduleOffset slot", () => {
  const snapshot = buildModuleStatusSnapshot({
    data: [
      {
        id: "thermocycler-1",
        moduleModel: "thermocyclerModuleV2",
        moduleOffset: { slot: "B1" },
        data: {
          status: "holding at target",
          currentTemperature: 95.02,
          targetTemperature: 95.0,
        },
      },
    ],
  });

  assert.equal(snapshot.modules[0].slot, "B1");
  assert.equal(snapshot.modules[0].ready, true);
});

test("buildRunHistorySnapshot summarizes failed commands and recovery", () => {
  const snapshot = buildRunHistorySnapshot(
    {
      data: {
        id: "run-123",
        protocolId: "protocol-1",
        status: "awaiting-recovery",
        currentlyRecoveringFrom: "command-2",
        commandErrors: [{ id: "err-1", detail: "No Tip Detected" }],
      },
    },
    {
      data: [
        { id: "command-1", commandType: "pickUpTip", status: "succeeded" },
        {
          id: "command-2",
          commandType: "pickUpTip",
          status: "failed",
          error: { detail: "No Tip Detected" },
        },
      ],
    },
  );

  assert.equal(snapshot.awaiting_recovery, true);
  assert.equal(snapshot.command_counts.failed, 1);
  assert.equal(snapshot.latest_failed_command.id, "command-2");
  assert.equal(snapshot.command_errors[0].detail, "No Tip Detected");
});

test("buildRunHistorySnapshot reads live run errors array", () => {
  const snapshot = buildRunHistorySnapshot(
    {
      data: {
        id: "run-live-1",
        protocolId: "protocol-live-1",
        status: "failed",
        errors: [{ id: "err-live-1", detail: "No trash container has been defined" }],
      },
    },
    {
      data: [],
    },
  );

  assert.equal(snapshot.command_errors[0].detail, "No trash container has been defined");
});

test("buildLiquidTrackingSnapshot summarizes quantitated containers and trust levels", () => {
  const snapshot = buildLiquidTrackingSnapshot({
    liquid_tracking: {
      sources: {
        "D3.A1": {
          slot_name: "D3",
          well_name: "A1",
          role: "source",
          volume_ul: 120,
          capacity_ul: 100,
          dead_volume_ul: 10,
          trust_level: "observed",
        },
      },
      containers: {
        "C3.A1": {
          container_key: "C3.A1",
          role: "destination",
          volume_ul: 20,
          capacity_ul: 200,
          dead_volume_ul: 0,
          trust_level: "simulated",
        },
      },
    },
    state_history: [{ field: "liquid_tracking.containers.D3.A1.volume_ul" }],
  });

  assert.equal(snapshot.container_count, 2);
  assert.equal(snapshot.source_count, 1);
  assert.equal(snapshot.over_capacity_count, 1);
  assert.deepEqual(snapshot.over_capacity_containers, ["D3.A1"]);
  assert.equal(snapshot.by_trust_level.observed, 1);
  assert.equal(snapshot.by_trust_level.simulated, 1);
  assert.equal(snapshot.state_history_count, 1);
});
