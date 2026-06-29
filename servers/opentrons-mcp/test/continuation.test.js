import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTipContinuationLedger,
  generateTipContinuationProtocol,
} from "../lib/continuation.js";

function buildRun() {
  return {
    data: {
      id: "run-explicit",
      protocolId: "protocol-explicit",
      pipettes: [
        {
          pipetteName: "p1000_single_flex",
          mount: "left",
        },
      ],
      labware: [
        {
          loadName: "opentrons_flex_96_tiprack_1000ul",
          location: { slotName: "A2" },
        },
      ],
    },
  };
}

const analysisCommands = [
  { commandType: "home", status: "succeeded", params: {} },
  {
    commandType: "loadLabware",
    status: "succeeded",
    params: {
      loadName: "opentrons_flex_96_tiprack_1000ul",
      location: { slotName: "A2" },
    },
  },
  {
    commandType: "loadPipette",
    status: "succeeded",
    params: { pipetteName: "p1000_single_flex", mount: "left" },
  },
  { commandType: "pickUpTip", status: "succeeded", params: { wellName: "A1" } },
  { commandType: "comment", status: "succeeded", params: { message: "explicit_pick_A1_ok" } },
  { commandType: "moveToAddressableAreaForDropTip", status: "succeeded", params: {} },
  { commandType: "dropTipInPlace", status: "succeeded", params: {} },
  { commandType: "pickUpTip", status: "succeeded", params: { wellName: "B1" } },
  { commandType: "comment", status: "succeeded", params: { message: "explicit_pick_B1_ok" } },
  { commandType: "moveToAddressableAreaForDropTip", status: "succeeded", params: {} },
  { commandType: "dropTipInPlace", status: "succeeded", params: {} },
  { commandType: "pickUpTip", status: "succeeded", params: { wellName: "C1" } },
  { commandType: "comment", status: "succeeded", params: { message: "explicit_pick_C1_ok" } },
  { commandType: "moveToAddressableAreaForDropTip", status: "succeeded", params: {} },
  { commandType: "dropTipInPlace", status: "succeeded", params: {} },
];

const runCommands = [
  { commandType: "pickUpTip", status: "failed", params: { wellName: "A1" }, error: { detail: "No Tip Detected" } },
  { commandType: "pickUpTip", status: "succeeded", intent: "fixit", params: { wellName: "B1" } },
  { commandType: "comment", status: "succeeded", params: { message: "explicit_pick_A1_ok" } },
  { commandType: "moveToAddressableAreaForDropTip", status: "succeeded", params: {} },
  { commandType: "dropTipInPlace", status: "succeeded", params: {} },
  { commandType: "pickUpTip", status: "failed", params: { wellName: "B1" }, error: { detail: "No Tip Detected" } },
];

test("buildTipContinuationLedger starts after missing A1 and depleted B1", () => {
  const ledger = buildTipContinuationLedger({
    run: buildRun(),
    commands: runCommands,
  });

  assert.equal(ledger.tiprack_slot, "A2");
  assert.equal(ledger.completed_cycles, 1);
  assert.deepEqual(ledger.missing_wells, ["A1"]);
  assert.ok(ledger.depleted_wells.includes("B1"));
  assert.equal(ledger.starting_tip, "C1");
});

test("generateTipContinuationProtocol renders C1-starting continuation for remaining cycles", () => {
  const result = generateTipContinuationProtocol({
    run: buildRun(),
    runCommands,
    analysisCommands,
  });

  assert.equal(result.starting_tip, "C1");
  assert.equal(result.remaining_cycles, 2);
  assert.deepEqual(
    result.operations.map(operation => operation.continuation_well),
    ["C1", "D1"],
  );
  assert.match(result.protocol_source, /pipette\.starting_tip = tiprack\["C1"\]/);
  assert.match(result.protocol_source, /protocol\.load_instrument\("flex_1channel_1000", "left"/);
  assert.match(result.protocol_source, /for index in range\(2\):/);
  assert.match(result.protocol_source, /explicit_pick_B1_ok/);
  assert.match(result.protocol_source, /explicit_pick_C1_ok/);
});

test("generateTipContinuationProtocol refuses liquid commands", () => {
  assert.throws(
    () =>
      generateTipContinuationProtocol({
        run: buildRun(),
        runCommands,
        analysisCommands: [
          ...analysisCommands,
          { commandType: "aspirate", status: "succeeded", params: {} },
        ],
      }),
    /only supports tip-only protocols/,
  );
});
