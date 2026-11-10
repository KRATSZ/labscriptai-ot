import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { atomicWrite } from "../../../scripts/runtime-paths.mjs";
import { normalizeRobotAddress, robotConnectionPath } from "./robot-connection.js";

// Stable user-wide storage, scoped to the connection file and normalized target.
// Never use experiment state, run history, or a different robot as a fallback.
export function hardwareCachePath(robotIp) {
  const key = createHash("sha256").update(normalizeRobotAddress(robotIp)).digest("hex");
  return path.join(path.dirname(robotConnectionPath()), "robot-hardware", `${key}.json`);
}

function savedContext(context) {
  const { live_action_blockers, ...hardware } = context;
  return {
    ...hardware,
    source: "saved_robot_snapshot",
    pipettes: context.pipettes.map(({ ok, tip_detected, ...pipette }) => pipette),
    grippers: context.grippers.map(({ ok, tip_detected, raw_status, ...gripper }) => gripper),
    modules: context.modules.map(({ status, ready, current_temperature, target_temperature,
      labware_latch_status, lid_status, ...module }) => module),
    live_state_checked: false,
    motion_performed: false,
    refresh_before_run: true,
  };
}

export function saveHardwareContext(context) {
  // A status call that skipped or failed module inspection must not replace a
  // complete previous snapshot with a partial inventory.
  if (!context.modules_checked) return null;
  const file = hardwareCachePath(context.robot_ip);
  atomicWrite(file, `${JSON.stringify({ schema: 1, authoring_context: savedContext(context) }, null, 2)}\n`);
  return file;
}

export function readHardwareContext(robotIp) {
  const file = hardwareCachePath(robotIp);
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    const context = saved.authoring_context;
    if (saved.schema !== 1 || !context || context.robot_ip !== normalizeRobotAddress(robotIp)
      || !Number.isFinite(Date.parse(context.observed_at)) || context.modules_checked !== true
      || !Array.isArray(context.pipettes) || !Array.isArray(context.grippers)
      || !Array.isArray(context.modules) || !Array.isArray(context.hardware_questions)
      || !Array.isArray(context.deck?.fixtures)) {
      throw new Error("Invalid saved hardware snapshot");
    }
    return { authoring_context: savedContext(context), cache_path: file };
  } catch (error) {
    return { authoring_context: null, cache_path: file,
      ...(error.code === "ENOENT" ? {} : { cache_error: error.message }) };
  }
}
