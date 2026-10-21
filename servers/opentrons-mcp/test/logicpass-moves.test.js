import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "../../..");
const python = process.env.OPENTRONS_PYTHON || path.join(pluginRoot, ".venv/bin/python");
const bridge = path.join(pluginRoot, "servers/opentrons-mcp/scripts/logicpass_check.py");
const fixture = path.join(here, "fixtures/logicpass/static_transfer_min.json");

function loadFixture() {
  return JSON.parse(fs.readFileSync(fixture, "utf8"));
}

function insertAfter(payload, afterId, commands) {
  const index = payload.commands.findIndex((command) => command.id === afterId);
  assert.notEqual(index, -1, `missing fixture command ${afterId}`);
  payload.commands.splice(index + 1, 0, ...commands);
}

function moveCommand(overrides = {}) {
  return {
    id: "cmd-move-labware",
    commandType: "moveLabware",
    status: "succeeded",
    params: {
      labwareId: "labware-plate",
      newLocation: { slotName: "C2" },
      strategy: "usingGripper",
    },
    ...overrides,
  };
}

function runAnalyze(mutate) {
  const payload = loadFixture();
  mutate(payload);
  const file = path.join(os.tmpdir(), `logicpass-moves-${crypto.randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify(payload));
  try {
    const run = spawnSync(python, [bridge, file, "true"], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout);
  } finally {
    fs.rmSync(file, { force: true });
  }
}

function assertUnevaluable(verdict, reason, commandType) {
  assert.equal(verdict.outcome, "unevaluable");
  assert.equal(verdict.logic_pass, false);
  assert.equal(verdict.final_pass_v2, false);
  assert.equal(verdict.unevaluable, true);
  const issue = verdict.issues.find((candidate) => candidate.code === "LP-L5");
  assert.ok(issue, `expected LP-L5 issue, got ${JSON.stringify(verdict.issues)}`);
  assert.match(issue.detail_text, new RegExp(`reason=${reason}`));
  if (commandType) {
    assert.match(issue.detail_text, new RegExp(`command_type=${commandType}`));
  }
}

test("moveLabware: clean aspirate -> move -> dispense passes", () => {
  const verdict = runAnalyze((payload) => {
    insertAfter(payload, "cmd-aspirate", [moveCommand()]);
  });
  assert.equal(verdict.outcome, "pass");
  assert.equal(verdict.logic_pass, true);
  assert.equal(verdict.final_pass_v2, true);
  assert.equal(verdict.unevaluable, false);
  assert.equal(verdict.issues.some((issue) => issue.code === "LP-L5"), false);
});

test("moveLabware: moving the source keeps dry-source identity and LP-L1 fails", () => {
  const verdict = runAnalyze((payload) => {
    const loadLiquid = payload.commands.find((command) => command.id === "cmd-load-liquid");
    loadLiquid.params.volumeByWell.A1 = 0;
    insertAfter(payload, "cmd-load-liquid", [
      moveCommand({ id: "cmd-move-source", params: { labwareId: "labware-res", newLocation: { slotName: "D3" }, strategy: "usingGripper" } }),
    ]);
  });
  assert.equal(verdict.outcome, "fail");
  assert.equal(verdict.final_pass_v2, false);
  assert.ok(
    verdict.issues.some(
      (issue) => issue.code === "LP-L1" && issue.step_index != null && /empty/.test(issue.detail_text),
    ),
  );
});

test("moveLabware: moving the destination keeps overflow LP-L4 failing", () => {
  const verdict = runAnalyze((payload) => {
    const aspirate = payload.commands.find((command) => command.id === "cmd-aspirate");
    const dispense = payload.commands.find((command) => command.id === "cmd-dispense");
    aspirate.params.volume = 500;
    dispense.params.volume = 500;
    insertAfter(payload, "cmd-aspirate", [
      moveCommand({ id: "cmd-move-destination", params: { labwareId: "labware-plate", newLocation: { slotName: "C2" }, strategy: "usingGripper" } }),
    ]);
  });
  assert.equal(verdict.outcome, "fail");
  assert.equal(verdict.final_pass_v2, false);
  assert.ok(verdict.issues.some((issue) => issue.code === "LP-L4" && /500/.test(issue.detail_text)));
});

test("moveLabware: failed and missing status remain unevaluable", () => {
  const failed = runAnalyze((payload) => {
    insertAfter(payload, "cmd-aspirate", [moveCommand({ status: "failed" })]);
  });
  assertUnevaluable(failed, "status_not_succeeded", "moveLabware");

  const missing = runAnalyze((payload) => {
    const move = moveCommand();
    delete move.status;
    insertAfter(payload, "cmd-aspirate", [move]);
  });
  assertUnevaluable(missing, "missing_status", "moveLabware");
});

test("unknown and explicitly unsupported liquid commands remain unevaluable", () => {
  const unknown = runAnalyze((payload) => {
    insertAfter(payload, "cmd-aspirate", [
      { id: "cmd-unknown-liquid", commandType: "mysteryLiquidTransfer", status: "succeeded", params: {} },
    ]);
  });
  assertUnevaluable(unknown, "unknown_commandType", "mysteryLiquidTransfer");

  const unsupported = runAnalyze((payload) => {
    insertAfter(payload, "cmd-aspirate", [
      {
        id: "cmd-aspirate-in-place",
        commandType: "aspirateInPlace",
        status: "succeeded",
        params: { pipetteId: "pipette-left", volume: 10, flowRate: 716 },
      },
    ]);
  });
  assertUnevaluable(unsupported, "unsupported_liquid_affecting", "aspirateInPlace");
});

test("thermocycler: all installed non-transfer control types pass", () => {
  const moduleId = "thermocycler-1";
  const controls = [
    ["thermocycler/closeLid", { moduleId }],
    ["thermocycler/setTargetBlockTemperature", { moduleId, celsius: 95, blockMaxVolumeUl: 50 }],
    ["thermocycler/waitForBlockTemperature", { moduleId, celsius: 95 }],
    ["thermocycler/setTargetLidTemperature", { moduleId, celsius: 105 }],
    ["thermocycler/waitForLidTemperature", { moduleId, celsius: 105 }],
    ["thermocycler/runProfile", { moduleId, profile: [{ celsius: 95, holdSeconds: 30 }, { celsius: 60, holdSeconds: 30 }], blockMaxVolumeUl: 50 }],
    ["thermocycler/runExtendedProfile", { moduleId, profile: [{ celsius: 95, holdSeconds: 30 }], blockMaxVolumeUl: 50 }],
    ["thermocycler/startRunExtendedProfile", { moduleId, profile: [{ celsius: 95, holdSeconds: 30 }], blockMaxVolumeUl: 50 }],
    ["thermocycler/awaitProfileComplete", { moduleId }],
    ["thermocycler/deactivateBlock", { moduleId }],
    ["thermocycler/deactivateLid", { moduleId }],
    ["thermocycler/openLid", { moduleId }],
  ];
  assert.equal(new Set(controls.map(([commandType]) => commandType)).size, 12);

  const verdict = runAnalyze((payload) => {
    insertAfter(
      payload,
      "cmd-load-liquid",
      controls.map(([commandType, params], index) => ({
        id: `cmd-tc-${index}`,
        commandType,
        status: "succeeded",
        params,
      })),
    );
  });
  assert.equal(verdict.outcome, "pass");
  assert.equal(verdict.logic_pass, true);
  assert.equal(verdict.final_pass_v2, true);
  assert.equal(verdict.issues.some((issue) => issue.code === "LP-L5"), false);
});
