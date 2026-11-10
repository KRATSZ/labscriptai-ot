import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { hardwareCachePath, readHardwareContext, saveHardwareContext } from "../lib/hardware-cache.js";
import { buildAuthoringContext } from "../lib/authoring-context.js";
import { rememberRobotAddress } from "../lib/robot-connection.js";
import { TOOL_HANDLERS, TOOL_DEFINITIONS } from "../index.js";

function context(robotIp = "http://robot.local:31950") {
  return buildAuthoringContext({
    robotIp,
    observedAt: "2025-01-01T00:00:00.000Z",
    robotStatus: {
      health_summary: { robot_model: "OT-3 Standard", robot_serial: "FLX-SAVED" },
      instruments_summary: [
        { mount: "right", instrument_name: "p50_single_flex", ok: false, tip_detected: true },
        { mount: "extension", instrument_name: "gripperV1", raw_status: "open", ok: false },
      ],
      deck_configuration: { raw: { cutoutFixtures: [] }, cutout_fixtures: [] },
      blockers: ["door_open", "estop_engaged"],
    },
    moduleStatus: { modules: [{ id: "hs1", model: "heaterShakerModuleV1", slot: "D1",
      status: "error", ready: false, current_temperature: 50, target_temperature: 60,
      labware_latch_status: "open" }], blockers: ["module_not_ready:hs1"] },
  });
}

test("persistent authoring cache is local, target-specific, restart-safe and separate from live readiness", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hardware-cache-"));
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;
  try {
    process.env.OPENTRONS_CONNECTION_FILE = path.join(dir, "connection.json");
    delete process.env.OPENTRONS_HOST;
    let requests = 0;
    global.fetch = async () => { requests++; throw new Error("offline"); };
    assert.ok(TOOL_DEFINITIONS.some(tool => tool.name === "robot_authoring_context"));
    assert.equal((await TOOL_HANDLERS.robot_authoring_context({})).data.status, "missing");
    const live = context();
    rememberRobotAddress(live.robot_ip);
    const file = saveHardwareContext(live);
    const result = await TOOL_HANDLERS.robot_authoring_context({});
    assert.equal(requests, 0);
    assert.equal(result.data.status, "available");
    const saved = result.data.authoring_context;
    assert.equal(saved.source, "saved_robot_snapshot");
    assert.equal(saved.observed_at, live.observed_at); // No age expiry or timestamp reset.
    assert.equal(saved.robot_serial, "FLX-SAVED");
    assert.equal(saved.pipettes[0].protocol_load_name, "flex_1channel_50");
    assert.equal(saved.modules[0].slot, "D1");
    assert.equal(saved.refresh_before_run, true);
    for (const key of ["ok", "tip_detected"]) assert.equal(key in saved.pipettes[0], false);
    assert.equal("raw_status" in saved.grippers[0], false);
    for (const key of ["status", "ready", "current_temperature", "target_temperature", "labware_latch_status"]) {
      assert.equal(key in saved.modules[0], false);
    }
    assert.equal("live_action_blockers" in saved, false);
    assert.equal(saved.live_state_checked, false);
    assert.equal(live.pipettes[0].tip_detected, true); // Do not mutate live output.

    // A fresh process with a different experiment folder uses the same snapshot.
    const cacheModule = new URL("../lib/hardware-cache.js", import.meta.url).href;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e",
      `import { readHardwareContext } from ${JSON.stringify(cacheModule)}; process.stdout.write(JSON.stringify(readHardwareContext("robot.local")));`],
    { encoding: "utf8", env: { ...process.env, PLUGIN_DATA: path.join(dir, "another-experiment") } });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout).authoring_context, saved);
    assert.equal(hardwareCachePath("robot.local"), file);

    assert.equal(saveHardwareContext({ ...live, modules_checked: false, modules: [] }), null);
    assert.deepEqual(readHardwareContext(live.robot_ip).authoring_context, saved);

    // Explicit address and environment targets must not borrow the saved target.
    assert.equal((await TOOL_HANDLERS.robot_authoring_context({ robot_ip: "other.local" })).data.status, "missing");
    process.env.OPENTRONS_HOST = "other.local";
    assert.equal((await TOOL_HANDLERS.robot_authoring_context({})).data.status, "missing");
    saveHardwareContext(context("http://other.local:31950"));
    assert.equal((await TOOL_HANDLERS.robot_authoring_context({})).data.authoring_context.robot_ip, "http://other.local:31950");
    delete process.env.OPENTRONS_HOST;
    assert.equal(requests, 0);

    fs.writeFileSync(file, "{broken");
    const corrupt = (await TOOL_HANDLERS.robot_authoring_context({})).data;
    assert.equal(corrupt.status, "missing");
    assert.ok(corrupt.cache_error);
    saveHardwareContext(live); // A new capture repairs a corrupt snapshot.
    const wrong = JSON.parse(fs.readFileSync(file));
    wrong.authoring_context.robot_ip = "http://wrong.local:31950";
    fs.writeFileSync(file, JSON.stringify(wrong));
    assert.equal(readHardwareContext(live.robot_ip).authoring_context, null);
    assert.equal(requests, 0);
  } finally {
    global.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
