import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildAuthoringContext } from "../lib/authoring-context.js";
import { buildRobotStatusSnapshot, buildModuleStatusSnapshot } from "../lib/live-state.js";
import { TOOL_HANDLERS, TOOL_DEFINITIONS } from "../index.js";
import { rememberRobotAddress } from "../lib/robot-connection.js";
import { knownPipetteProtocolName } from "../lib/pipette-names.js";

function snapshot(overrides = {}) {
  return buildRobotStatusSnapshot({
    health: { robotModel: "OT-3 Standard", serialNumber: "FLX-TEST", systemVersion: "test-version" },
    instruments: { data: [
      { mount: "left", instrumentName: "p1000_multi_flex", ok: true },
      { mount: "right", instrumentName: "p50_single_flex", ok: true },
      { mount: "extension", instrumentName: "gripperV1", ok: true },
    ] },
    doorStatus: { data: { status: "closed" } },
    estopStatus: { data: { status: "disengaged" } },
    deckConfiguration: { data: { cutoutFixtures: [
      { cutoutId: "cutoutD3", cutoutFixtureId: "wasteChuteRightAdapterCovered" },
      { cutoutId: "cutoutD1", cutoutFixtureId: "heaterShakerModuleV1" },
    ] } },
    ...overrides,
  });
}

test("Flex authoring uses actual pipette names/mounts, modules and waste fixture without template defaults", () => {
  const robotStatus = snapshot();
  const moduleStatus = buildModuleStatusSnapshot({ data: [
    { id: "hs1", moduleModel: "heaterShakerModuleV1", moduleOffset: { slot: "D1" }, status: "idle" },
  ] });
  const context = buildAuthoringContext({ robotStatus, moduleStatus, robotIp: "http://robot.local:31950", observedAt: "2026-11-09T00:00:00.000Z" });
  assert.equal(context.robot_type, "Flex");
  assert.equal(context.robot_serial, "FLX-TEST");
  assert.equal(context.observed_at, "2026-11-09T00:00:00.000Z");
  assert.equal(context.source, "live_robot_api");
  assert.deepEqual(context.pipettes.map(p => [p.mount, p.protocol_load_name]), [
    ["left", "flex_8channel_1000"], ["right", "flex_1channel_50"],
  ]);
  assert.equal(context.grippers.length, 1);
  assert.equal(context.modules[0].slot, "D1");
  assert.deepEqual(context.deck.fixtures, robotStatus.deck_configuration.cutout_fixtures);
  assert.equal(context.deck.fixtures_checked, true);
  assert.ok(context.deck.fixtures.every(fixture => fixture.cutoutId !== "cutoutA3"));
  assert.deepEqual(context.hardware_questions, []);
  assert.equal(context.motion_performed, false);
  assert.equal(context.refresh_before_run, true);
  assert.ok(context.not_observable.includes("ordinary_labware_load_names_and_positions"));
  assert.ok(context.not_observable.includes("remaining_clean_tips"));
});

test("OT-2 stays OT-2 and keeps its actual pipette mount and numeric module slot", () => {
  const robotStatus = snapshot({
    health: { robot_model: "OT-2 Standard", robot_serial: "OT2-TEST" },
    instruments: { data: [{ mount: "right", instrumentName: "p300_single_gen2", ok: true }] },
    deckConfiguration: { data: { deckType: "ot2_standard" } },
  });
  const moduleStatus = buildModuleStatusSnapshot({ data: [
    { id: "temp1", moduleModel: "temperatureModuleV2", location: { slotName: "1" }, status: "idle" },
  ] });
  const context = buildAuthoringContext({ robotStatus, moduleStatus });
  assert.equal(context.robot_type, "OT-2");
  assert.equal(context.pipettes[0].protocol_load_name, "p300_single_gen2");
  assert.equal(context.pipettes[0].mount, "right");
  assert.equal(context.modules[0].slot, "1");
  assert.ok(context.hardware_questions.includes("deck_fixtures_not_reported"));
});

test("reported 96-channel and EM names map to real public names while invented lookalikes stay unknown", () => {
  assert.equal(knownPipetteProtocolName("p1000_96"), "flex_96channel_1000");
  assert.equal(knownPipetteProtocolName("p200_96"), "flex_96channel_200");
  assert.equal(knownPipetteProtocolName("p1000_multi_em_flex"), "flex_8channel_1000_em");
  for (const name of ["p20_single", "p1000_multi_gen2", "flex_96channel_50", "p1000_single_v3.4"]) {
    assert.equal(knownPipetteProtocolName(name), null, name);
  }
});

test("unknown model, hardware names and missing locations require confirmation rather than guessing", () => {
  const context = buildAuthoringContext({
    robotStatus: snapshot({
      health: { name: "My Flex", robot_model: "unrecognized future model" },
      instruments: { data: [{ instrumentName: "future-pipette-v9.1", model: "p1000_single_v9" }] },
      deckConfiguration: {},
    }),
    moduleStatus: buildModuleStatusSnapshot({ data: [{ id: "mod1", model: "temperatureModuleV2" }] }),
  });
  assert.equal(context.robot_type, null);
  assert.equal(context.pipettes[0].protocol_load_name, null);
  assert.equal(context.pipettes[0].mount, null);
  assert.equal(context.modules[0].slot, null);
  for (const field of ["robot_type_unknown", "pipette_load_name:unknown", "pipette_mount:unknown", "module_location:mod1", "deck_fixtures_not_reported"]) {
    assert.ok(context.hardware_questions.includes(field), field);
  }
});

test("conflicting reported robot types and cross-platform pipettes remain visible", () => {
  const mixed = buildAuthoringContext({ robotStatus: snapshot({
    health: { robot_model: "OT-2 Standard" }, deckConfiguration: { data: { deckType: "ot3_standard" } },
  }) });
  assert.equal(mixed.robot_type, null);
  assert.ok(mixed.hardware_questions.includes("robot_type_conflict"));
  const mismatch = buildAuthoringContext({ robotStatus: snapshot({ health: { robot_model: "OT-2 Standard" } }) });
  assert.ok(mismatch.hardware_questions.includes("pipette_robot_mismatch:left"));
});

test("unchecked modules and missing pipettes do not become assumed hardware", () => {
  const context = buildAuthoringContext({ robotStatus: snapshot({ instruments: { data: [] } }) });
  assert.deepEqual(context.pipettes, []);
  assert.equal(context.modules_checked, false);
  assert.ok(context.hardware_questions.includes("no_pipette_reported"));
  assert.ok(context.hardware_questions.includes("modules_not_checked"));
});

test("conflicting module API and fixture locations are surfaced before layout selection", () => {
  const context = buildAuthoringContext({
    robotStatus: snapshot({ deckConfiguration: { data: { cutoutFixtures: [
      { cutoutId: "cutoutD1", cutoutFixtureId: "heaterShakerModuleV1", opentronsModuleSerialNumber: "HS-TEST" },
    ] } } }),
    moduleStatus: buildModuleStatusSnapshot({ data: [
      { id: "hs1", serialNumber: "HS-TEST", model: "heaterShakerModuleV1", moduleOffset: { slot: "C1" } },
    ] }),
  });
  assert.equal(context.modules[0].slot, "C1");
  assert.deepEqual(context.modules[0].fixture_slots, ["D1"]);
  assert.ok(context.hardware_questions.includes("module_location_conflict:hs1"));
});

test("readiness faults are carried forward without claiming motion is authorized or performed", () => {
  const context = buildAuthoringContext({
    robotStatus: snapshot({ doorStatus: { data: { status: "open" } } }),
    moduleStatus: buildModuleStatusSnapshot({ data: [{ id: "hs1", model: "heaterShakerModuleV1", status: "error" }] }),
  });
  assert.ok(context.live_action_blockers.includes("door_open"));
  assert.ok(context.live_action_blockers.includes("module_not_ready:hs1"));
  assert.equal(context.motion_performed, false);
});

test("robot_status returns authoring context from the saved robot using only existing GET endpoints", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "authoring-status-"));
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;
  try {
    process.env.OPENTRONS_CONNECTION_FILE = path.join(dir, "connection.json");
    delete process.env.OPENTRONS_HOST;
    rememberRobotAddress("192.168.1.80");
    const payloads = {
      "/health": { robotModel: "OT-3 Standard", serialNumber: "FLX-LIVE" },
      "/instruments": { data: [{ mount: "right", instrumentName: "p50_single_flex", ok: true }] },
      "/robot/door/status": { data: { status: "closed" } },
      "/robot/control/estopStatus": { data: { status: "disengaged" } },
      "/deck_configuration": { data: { cutoutFixtures: [{ cutoutId: "cutoutC3", cutoutFixtureId: "trashBinAdapter" }] } },
      "/modules": { data: [] },
    };
    const seen = [];
    global.fetch = async (url, options) => {
      const parsed = new URL(url);
      assert.equal(parsed.origin, "http://192.168.1.80:31950");
      assert.equal(options.method, "GET");
      assert.ok(Object.hasOwn(payloads, parsed.pathname), parsed.pathname);
      seen.push(parsed.pathname);
      return new Response(JSON.stringify(payloads[parsed.pathname]), { headers: { "content-type": "application/json" } });
    };
    const result = await TOOL_HANDLERS.robot_status({ include_modules: true });
    const context = result.data.authoring_context;
    assert.equal(context.robot_ip, "http://192.168.1.80:31950");
    assert.equal(context.robot_serial, "FLX-LIVE");
    assert.deepEqual(context.pipettes.map(p => [p.mount, p.protocol_load_name]), [["right", "flex_1channel_50"]]);
    assert.equal(context.deck.fixtures[0].cutoutId, "cutoutC3");
    assert.equal(context.modules_checked, true);
    assert.deepEqual([...seen].sort(), Object.keys(payloads).sort());
    assert.deepEqual(result.hardwareSnapshot.deck_configuration, payloads["/deck_configuration"]);
    assert.match(TOOL_DEFINITIONS.find(t => t.name === "robot_status").description, /Before writing a protocol/);
  } finally {
    global.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
