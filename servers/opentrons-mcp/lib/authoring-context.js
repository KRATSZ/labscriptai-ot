import { knownPipetteProtocolName } from "./pipette-names.js";

function robotType(value) {
  const normalized = String(value || "").toLowerCase();
  if (/^(flex|ot[-_ ]?3)(?:\b|_)/.test(normalized)) return "Flex";
  if (/^ot[-_ ]?2(?:\b|_)/.test(normalized)) return "OT-2";
  return null;
}

// Only current API observations enter this context. No run history, camera
// inference, template defaults, or previously committed labware is merged here.
export function buildAuthoringContext({ robotStatus, moduleStatus = null, robotIp, observedAt = new Date().toISOString() }) {
  const health = robotStatus.health_summary || {};
  const deck = robotStatus.deck_configuration || {};
  const identifiedTypes = [...new Set([health.robot_model, health.robot_type, deck.deck_type].map(robotType).filter(Boolean))];
  const robot = identifiedTypes.length === 1 ? identifiedTypes[0] : null;
  const hardwareQuestions = [];
  if (!robot) hardwareQuestions.push(identifiedTypes.length > 1 ? "robot_type_conflict" : "robot_type_unknown");

  const instruments = robotStatus.instruments_summary || [];
  const pipettes = instruments.filter(item => item.mount !== "extension" && !/gripper/i.test(item.instrument_name || item.model || ""))
    .map(item => {
      const loadName = knownPipetteProtocolName(item.instrument_name);
      if (!loadName) hardwareQuestions.push(`pipette_load_name:${item.mount || "unknown"}`);
      if (!["left", "right"].includes(item.mount)) hardwareQuestions.push(`pipette_mount:${item.mount || "unknown"}`);
      if (loadName && robot && (loadName.startsWith("flex_") ? "Flex" : "OT-2") !== robot) {
        hardwareQuestions.push(`pipette_robot_mismatch:${item.mount || "unknown"}`);
      }
      return { mount: item.mount, protocol_load_name: loadName, reported_name: item.instrument_name,
        model: item.model, serial: item.serial, ok: item.ok, tip_detected: item.tip_detected };
    });
  if (!pipettes.length) hardwareQuestions.push("no_pipette_reported");
  if (!moduleStatus) hardwareQuestions.push("modules_not_checked");
  const fixtures = Array.isArray(deck.cutout_fixtures) ? deck.cutout_fixtures : [];
  const modules = (moduleStatus?.modules || []).map(item => {
    const fixtureSlots = [...new Set(fixtures
      .filter(fixture => fixture.opentronsModuleSerialNumber
        && [item.serial, item.id].includes(fixture.opentronsModuleSerialNumber))
      .map(fixture => String(fixture.cutoutId || "").match(/^cutout([A-D][1-3])$/i)?.[1]?.toUpperCase())
      .filter(Boolean))];
    if (!item.model) hardwareQuestions.push(`module_model:${item.id || "unknown"}`);
    if (!item.slot) hardwareQuestions.push(`module_location:${item.id || item.model || "unknown"}`);
    if (item.slot && fixtureSlots.length && !fixtureSlots.includes(item.slot)) {
      hardwareQuestions.push(`module_location_conflict:${item.id || item.serial}`);
    }
    return { id: item.id, model: item.model, slot: item.slot, serial: item.serial, status: item.status,
      fixture_slots: fixtureSlots,
      ready: item.ready, current_temperature: item.current_temperature, target_temperature: item.target_temperature,
      labware_latch_status: item.labware_latch_status, lid_status: item.lid_status };
  });
  const deckChecked = Array.isArray(deck.raw?.cutoutFixtures) || Array.isArray(deck.raw?.cutout_fixtures)
    || Array.isArray(deck.raw?.fixtures);
  if (!deckChecked) hardwareQuestions.push("deck_fixtures_not_reported");

  return {
    source: "live_robot_api",
    observed_at: observedAt,
    robot_ip: robotIp,
    robot_type: robot,
    robot_serial: health.robot_serial || null,
    software: { system_version: health.system_version, api_version: health.api_version, firmware_version: health.firmware_version },
    pipettes,
    grippers: instruments.filter(item => item.mount === "extension" || /gripper/i.test(item.instrument_name || item.model || "")),
    modules,
    modules_checked: moduleStatus !== null,
    deck: { deck_type: deck.deck_type, fixtures_checked: deckChecked, fixtures },
    hardware_questions: [...new Set(hardwareQuestions)],
    // These endpoints do not inventory passive labware or measure liquids.
    not_observable: ["ordinary_labware_load_names_and_positions", "remaining_clean_tips", "liquid_identity_and_volume", "unreported_passive_modules_and_adapters"],
    live_action_blockers: [...(robotStatus.blockers || []), ...(moduleStatus?.blockers || [])],
    motion_performed: false,
    refresh_before_run: true,
  };
}
