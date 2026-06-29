import test from "node:test";
import assert from "node:assert/strict";

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import {
  classifyTipBindingMode,
  classifyTipBindingModeDetail,
  decideTipRecoveryRoute,
} from "../lib/protocol-tips.js";
import { computeStartingTip } from "../lib/state.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("classifyTipBindingMode detects automatic pick_up_tip calls", () => {
  const source = `
def run(protocol):
    tiprack = protocol.load_labware("opentrons_flex_96_tiprack_1000ul", "C2")
    pipette = protocol.load_instrument("flex_1channel_1000", "left", tip_racks=[tiprack])
    pipette.pick_up_tip()
`;

  const detail = classifyTipBindingModeDetail(source);

  assert.equal(detail.mode, "auto");
  assert.equal(detail.auto_pick_up_tip_calls, 1);
  assert.equal(classifyTipBindingMode(source), "auto");
});

test("classifyTipBindingMode ignores comments and string literals", () => {
  const source = `
# pipette.pick_up_tip(tiprack["A1"])
"""
pipette.pick_up_tip(tiprack["B1"])
starting_tip = tiprack["C1"]
"""
def run(protocol):
    protocol.comment("pipette.pick_up_tip(tiprack['D1'])")
    pipette.pick_up_tip()
`;

  const detail = classifyTipBindingModeDetail(source);

  assert.equal(detail.mode, "auto");
  assert.equal(detail.auto_pick_up_tip_calls, 1);
});

test("classifyTipBindingMode detects explicit tip location calls", () => {
  const source = fs.readFileSync(
    path.join(REPO_ROOT, "skills/opentrons-protocol-author/assets/archive/flex_tip_recovery_reference.py"),
    "utf8",
  );

  const detail = classifyTipBindingModeDetail(source);

  assert.equal(detail.mode, "explicit");
  assert.equal(detail.explicit_pick_up_tip_calls, 1);
});

test("classifyTipBindingMode detects starting_tip state", () => {
  const source = fs.readFileSync(
    path.join(REPO_ROOT, "bundled-library/protocols/76c562/76c562.ot2.apiv2.py"),
    "utf8",
  );

  const detail = classifyTipBindingModeDetail(source);

  assert.equal(detail.mode, "starting_tip");
  assert.equal(detail.starting_tip_detected, true);
});

test("decideTipRecoveryRoute branches missing tips by binding mode", () => {
  assert.equal(
    decideTipRecoveryRoute({
      errorLeaf: "TIP_PHYSICALLY_MISSING",
      tipBindingMode: "auto",
    }),
    "fixit",
  );
  assert.equal(
    decideTipRecoveryRoute({
      errorLeaf: "TIP_PHYSICALLY_MISSING",
      tipBindingMode: "explicit",
    }),
    "replan",
  );
  assert.equal(
    decideTipRecoveryRoute({
      errorLeaf: "TIP_PHYSICALLY_MISSING",
      tipBindingMode: "starting_tip",
    }),
    "replan",
  );
  assert.equal(
    decideTipRecoveryRoute({
      errorLeaf: "OUT_OF_TIPS",
      tipBindingMode: "auto",
    }),
    "human",
  );
});

test("computeStartingTip skips missing, depleted, and unknown blocked wells", () => {
  const startingTip = computeStartingTip({
    search_order: ["A1", "B1", "C1", "D1"],
    missing_wells: ["A1"],
    depleted_wells: ["B1"],
    unknown_blocked_wells: [],
  });

  assert.equal(startingTip, "C1");
});
