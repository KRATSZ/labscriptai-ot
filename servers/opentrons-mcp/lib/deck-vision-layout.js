import fs from "fs";
import path from "path";
import { PLUGIN_ROOT } from "./paths.js";

const FLEX_SLOTS = [..."ABCD"].flatMap(row => [1, 2, 3].map(col => `${row}${col}`));
const LABELS = new Set(["tiprack", "plate", "reservoir", "module", "trash_bin", "empty"]);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function visionLabel(loadName = "") {
  const name = String(loadName).toLowerCase();
  if (/tiprack|tip_rack/.test(name)) return "tiprack";
  if (/reservoir/.test(name)) return "reservoir";
  if (/wellplate|well_plate|pcr_plate/.test(name)) return "plate";
  return LABELS.has(name) ? name : null;
}

// Read configuration anew for every check: camera/layout changes must not reuse
// an earlier observation. Missing calibration must never become a grid-based pass.
export function readDeckVisionConfiguration({ robotIp = null } = {}) {
  const policyPath = process.env.OPENTRONS_DECK_LAYOUT_POLICY || path.join(PLUGIN_ROOT, "automation/deck_layout_policy.json");
  const calibrationPath = process.env.OPENTRONS_DECK_CALIBRATION || path.join(PLUGIN_ROOT, "automation/photo/deck_calibration.json");
  const issues = [];
  let policy = null;
  let calibration = null;
  try { policy = readJson(policyPath); } catch { issues.push("layout_policy_unavailable"); }
  try { calibration = readJson(calibrationPath); } catch { issues.push("camera_calibration_unavailable"); }
  const corners = calibration?.optional_deck_corners_norm;
  if (calibration && !(Array.isArray(corners) && corners.length === 4 && corners.every(point =>
    Array.isArray(point) && point.length === 2 && point.every(n => Number.isFinite(n) && n >= 0 && n <= 1)))) {
    issues.push("camera_calibration_invalid");
  }
  if (calibration?.robot && robotIp) {
    const host = value => new URL(/^https?:\/\//i.test(value) ? value : `http://${value}`).hostname;
    try {
      if (host(calibration.robot) !== host(robotIp)) issues.push("camera_calibration_robot_mismatch");
    } catch { issues.push("camera_calibration_robot_invalid"); }
  }
  const fixed = policy?.fixed_slots;
  const slots = policy?.detection_slots;
  if (policy && (!fixed || typeof fixed !== "object" || !Array.isArray(slots) || !slots.length ||
    slots.some(slot => !FLEX_SLOTS.includes(slot) || Object.hasOwn(fixed, slot)))) {
    issues.push("layout_policy_invalid");
  }
  return { policy, policy_path: path.resolve(policyPath), calibration_path: path.resolve(calibrationPath), issues };
}

/** Derive STARTING locations from analyzed commands, never final labware locations.
 * Loops, variables and keyword loads are already resolved by the analyzer.
 * Later manual additions/moves must not be interpreted as pre-run placement.
 */
export function buildDeckVisionLayout({ analysis = null, expectedLayout = null, policy = null, runTimeParameters = null } = {}) {
  const robotType = analysis?.robotType || analysis?.config?.robotType || null;
  const slots = policy?.detection_slots || FLEX_SLOTS;
  const supported = policy?.detection_classes?.map(visionLabel);
  const result = { expected_layout: {}, source: expectedLayout ? "explicit" : "simulation_analysis", robot_type: robotType, not_checked: [] };
  if (expectedLayout) {
    for (const [rawSlot, rawLabel] of Object.entries(expectedLayout)) {
      const slot = rawSlot.toUpperCase();
      const label = visionLabel(rawLabel);
      if (!slots.includes(slot) || !label || (label !== "empty" && supported?.length && !supported.includes(label))) result.not_checked.push(`unsupported_expectation:${rawSlot}`);
      else result.expected_layout[slot] = label;
    }
    if (!Object.keys(result.expected_layout).length) result.not_checked.push("expected_layout_unavailable");
    return result;
  }
  if (/ot-?2/i.test(robotType || "")) {
    result.not_checked.push("ot2_vision_not_supported");
    return result;
  }
  if (!Array.isArray(analysis?.commands)) {
    result.not_checked.push("analysis_commands_unavailable");
    return result;
  }
  if (analysis.errors?.length) {
    result.not_checked.push("analysis_failed");
    return result;
  }
  // Local analyze currently resolves default runtime parameters. Do not compare
  // that layout with a run using overrides (which may select different slots).
  if (runTimeParameters && Object.keys(runTimeParameters).length) {
    result.not_checked.push("runtime_parameter_layout_not_resolved");
    return result;
  }
  result.expected_layout = Object.fromEntries(slots.map(slot => [slot, "empty"]));
  let setup = true;
  const initialSlots = new Set();
  for (const command of analysis.commands) {
    const type = command.commandType || "";
    if (/^(pause|waitForResume|moveLabware|pickUpTip|aspirate|dispense|mix|moveTo|touchTip|dropTip|blowOut)/.test(type)) setup = false;
    if (!["loadLabware", "loadModule", "loadTrashBin", "loadWasteChute"].includes(type)) continue;
    const p = command.params || {};
    const rawSlot = p.location?.slotName || p.location?.addressableAreaName || p.addressableAreaName;
    const slot = String(rawSlot || "").match(/[A-D][1-3]$/)?.[0];
    if (!slot || !slots.includes(slot)) continue; // off-deck, modules and policy-fixed fixtures are outside detection scope
    if (!setup) {
      // A late load does not establish whether this slot should already be
      // occupied before play. Exclude it rather than asserting it is empty.
      if (!initialSlots.has(slot)) {
        delete result.expected_layout[slot];
        result.not_checked.push(`later_load_starting_placement_unknown:${slot}`);
      }
      continue;
    }
    initialSlots.add(slot);
    const label = type === "loadLabware" ? visionLabel(p.loadName) : type === "loadModule" ? "module" : "trash_bin";
    if (!label || (supported?.length && !supported.includes(label))) {
      delete result.expected_layout[slot];
      result.not_checked.push(`unsupported_labware:${slot}:${p.loadName}`);
    } else {
      result.expected_layout[slot] = label;
    }
  }
  if (!Object.keys(result.expected_layout).length) result.not_checked.push("expected_layout_unavailable");
  return result;
}

export function unperformedDeckVision(status, reason, details = {}) {
  return {
    subphase: "deck_vision", observation_only: true, status,
    skipped: status === "skipped", allowed_to_play: true,
    reason, not_checked: [reason], sensors_used: [],
    consensus: { status, summary: `Deck vision ${status}: ${reason}.`, recommended_next_actions: [], layout_consistent_with_expected: false },
    ...details,
  };
}

export function evaluateDeckVisionGate(result) {
  const status = result.consensus?.status || result.status || "not_checked";
  const mismatch = (result.yolo?.mismatches?.length || 0) > 0;
  const allowed = !mismatch && ["passed", "skipped", "not_checked", "not_applicable"].includes(status);
  return { ...result, status, allowed_to_play: allowed, observation_only: true };
}
