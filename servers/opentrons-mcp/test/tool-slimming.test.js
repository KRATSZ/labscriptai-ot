import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

import { TOOL_DEFINITIONS, TOOL_HANDLERS } from "../index.js";

test("merged monitoring tools are advertised and dispatch", async () => {
  const names = new Set(TOOL_DEFINITIONS.map(tool => tool.name));
  for (const merged of [
    "runtime_watch",
    "runtime_alerts",
    "runtime_outbox",
    "query_history",
    "safe_next_action",
  ]) {
    assert.equal(names.has(merged), true, `${merged} should be advertised`);
  }
  for (const removed of [
    "runtime_watch_poll",
    "runtime_watch_loop",
    "runtime_get_alerts",
    "runtime_ack_alert",
    "runtime_get_outbox",
    "runtime_ack_outbox",
    "runtime_deliver_outbox",
    "get_runs",
    "run_history",
    "experiment_history",
    "restart_review",
  ]) {
    assert.equal(names.has(removed), false, `${removed} should no longer be advertised`);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-slimming-"));
  process.env.OPENTRONS_SESSION_STATE_DIR = tempDir;
  process.env.OPENTRONS_RESULT_LOG_DIR = tempDir;

  await assert.rejects(
    () => TOOL_HANDLERS.runtime_watch({ mode: "bogus", run_id: "r1" }),
    /unknown mode/,
  );

  const alerts = await TOOL_HANDLERS.runtime_alerts({
    action: "list",
    session_id: "slim-test",
    watch_dir: tempDir,
  });
  assert.equal(alerts.data.status, "ok");

  const outbox = await TOOL_HANDLERS.runtime_outbox({
    action: "list",
    session_id: "slim-test",
    outbox_dir: tempDir,
  });
  assert.equal(outbox.data.status, "ok");

  const logs = await TOOL_HANDLERS.query_history({
    scope: "experiment_logs",
    session_id: "slim-test",
  });
  assert.ok(Array.isArray(logs.data.entries));

  await assert.rejects(
    () => TOOL_HANDLERS.query_history({ scope: "nope" }),
    /unknown scope/,
  );

  const summary = await TOOL_HANDLERS.safe_next_action({
    detail: "summary",
    session_id: "slim-test",
  });
  assert.ok(summary.data.safe_next_action);

  const full = await TOOL_HANDLERS.safe_next_action({
    detail: "full",
    session_id: "slim-test",
  });
  assert.ok(full.data);
});

test("merged vision/camera/image/misc tools are advertised and dispatch", async () => {
  const names = new Set(TOOL_DEFINITIONS.map(tool => tool.name));
  for (const merged of [
    "camera_settings",
    "capture_image",
    "data_files",
    "analyze_image",
    "deck_vision_check",
    "labware_lookup",
    "deck_slots",
    "tip_wells",
    "control_module",
  ]) {
    assert.equal(names.has(merged), true, `${merged} should be advertised`);
  }
  for (const removed of [
    "camera_status",
    "configure_camera",
    "capture_preview_image",
    "capture_run_image",
    "list_data_files",
    "download_data_file",
    "analyze_image_with_kimi",
    "analyze_image_with_ark",
    "vision_check",
    "validate_labware_name",
    "inspect_labware_definition",
    "get_slot_occupation",
    "list_available_slots",
    "list_tip_candidates",
    "suggest_next_tip_well",
    "control_temperature_module",
    "control_heater_shaker",
    "control_thermocycler",
    "robot_health",
    "doctor_local_runtime",
  ]) {
    assert.equal(names.has(removed), false, `${removed} should no longer be advertised`);
  }

  await assert.rejects(() => TOOL_HANDLERS.analyze_image({ provider: "nope", image_path: "x.png" }), /unknown provider/);
  await assert.rejects(() => TOOL_HANDLERS.camera_settings({ action: "nope" }), /unknown action/);
  await assert.rejects(() => TOOL_HANDLERS.capture_image({ mode: "nope" }), /unknown mode/);
  await assert.rejects(() => TOOL_HANDLERS.control_module({ module_type: "nope" }), /unknown module_type/);
  await assert.rejects(() => TOOL_HANDLERS.deck_slots({ action: "nope" }), /unknown action/);
  await assert.rejects(() => TOOL_HANDLERS.tip_wells({ action: "nope" }), /unknown action/);
  await assert.rejects(() => TOOL_HANDLERS.labware_lookup({ action: "nope", load_name: "x" }), /unknown action/);
  await assert.rejects(() => TOOL_HANDLERS.data_files({ action: "nope" }), /unknown action/);

  const validated = await TOOL_HANDLERS.labware_lookup({
    action: "validate",
    load_name: "nest_96_wellplate_100ul_pcr_full_skirt",
  });
  assert.ok(validated.data);
});

test("health_check scope dispatch matches merged sub-checks", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-slimming-health-"));
  process.env.OPENTRONS_SESSION_STATE_DIR = tempDir;

  await assert.rejects(
    () => TOOL_HANDLERS.health_check({ scope: "robot" }),
    /robot_ip|base URL/i,
  );

  const local = await TOOL_HANDLERS.health_check({ scope: "local" });
  assert.ok(local.data);
});

test("simulate_protocol response embeds parsed_repair classification", async () => {
  const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
  const candidates = fs
    .readdirSync(fixturesDir)
    .filter(name => name.endsWith(".py"))
    .slice(0, 1);
  if (candidates.length === 0) {
    return; // no fixture protocol available; harness covers this path
  }
  const result = await TOOL_HANDLERS.simulate_protocol({
    protocol_path: path.join(fixturesDir, candidates[0]),
    max_log_chars: 2000,
  });
  assert.ok(result.data);
  assert.ok("parsed_repair" in result.data);
});

test("3D preview requires a protocol and fails without starting an empty viewer", async () => {
  const def = TOOL_DEFINITIONS.find(tool => tool.name === "flex3d_open_viewer");
  assert.ok(def.inputSchema.required.includes("protocol_path"));
  const result = await TOOL_HANDLERS.flex3d_open_viewer({});
  assert.equal(result.data.ok, false);
  assert.equal(result.data.error, "protocol_required");
  assert.equal(result.data.pid, undefined);
});
