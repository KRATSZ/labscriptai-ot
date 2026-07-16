const DEFAULT_CRITICAL_ROLES = new Set([
  "wash_buffer",
  "wash",
  "enzyme",
  "reagent",
  "sample",
  "critical",
]);

function normalizeWellName(wellName) {
  return String(wellName || "").trim().toUpperCase();
}

function normalizeSlotName(slotName) {
  return String(slotName || "").trim().toUpperCase();
}

function sourceKey(slotName, wellName) {
  return `${normalizeSlotName(slotName)}.${normalizeWellName(wellName)}`;
}

function isCriticalSource(source = {}) {
  if (source.critical === true || source.probe_required === true) {
    return true;
  }
  const role = String(source.role || "").trim().toLowerCase();
  return role ? DEFAULT_CRITICAL_ROLES.has(role) : false;
}

export function listCriticalProbeTargets({
  sessionState = {},
  criticalSources = null,
  includeAllExpectedPresent = false,
} = {}) {
  const explicitTargets = Array.isArray(criticalSources)
    ? criticalSources
        .map(entry => ({
          slot_name: normalizeSlotName(entry.slot || entry.slot_name),
          well_name: normalizeWellName(entry.well || entry.well_name),
          role: entry.role || null,
          required: entry.required !== false,
          labware_load_name: entry.labware_load_name || entry.labware || null,
          mode: entry.mode || "require_presence",
          reason: entry.reason || "explicit_critical_source",
        }))
        .filter(entry => entry.slot_name && entry.well_name)
    : [];

  if (explicitTargets.length > 0) {
    return {
      probe_policy: "critical_sources_only",
      targets: explicitTargets,
      target_count: explicitTargets.length,
      source: "explicit_argument",
      fallback_used: false,
    };
  }

  const sources = sessionState?.liquid_tracking?.sources || {};
  const fromSession = Object.entries(sources)
    .map(([key, source]) => ({
      key,
      slot_name: normalizeSlotName(source.slot_name),
      well_name: normalizeWellName(source.well_name),
      role: source.role || null,
      expected_presence: source.expected_presence ?? null,
      observed_presence: source.observed_presence ?? null,
      liquid_name: source.liquid_name || null,
      labware_load_name: source.labware_load_name || null,
      critical: source.critical === true,
      probe_required: source.probe_required === true,
    }))
    .filter(entry => entry.slot_name && entry.well_name);

  let selected = fromSession.filter(
    entry => entry.expected_presence === true && isCriticalSource(entry),
  );

  let fallbackUsed = false;
  if (selected.length === 0 && includeAllExpectedPresent) {
    selected = fromSession.filter(entry => entry.expected_presence === true);
    fallbackUsed = selected.length > 0;
  }

  const targets = selected.map(entry => ({
    slot_name: entry.slot_name,
    well_name: entry.well_name,
    key: entry.key || sourceKey(entry.slot_name, entry.well_name),
    role: entry.role,
    required: true,
    labware_load_name: entry.labware_load_name,
    mode: "require_presence",
    reason: fallbackUsed ? "fallback_expected_present" : "critical_source_map",
    liquid_name: entry.liquid_name,
    expected_presence: entry.expected_presence,
    observed_presence: entry.observed_presence,
  }));

  return {
    probe_policy: sessionState?.liquid_tracking?.probe_policy || "critical_sources_only",
    targets,
    target_count: targets.length,
    source: fallbackUsed ? "session_expected_present_fallback" : "session_source_map",
    fallback_used: fallbackUsed,
    wells: targets.map(entry => entry.well_name),
    probe_groups: groupTargetsBySlot(targets),
  };
}

export function groupTargetsBySlot(targets = []) {
  const groups = new Map();
  for (const target of targets) {
    const slot = normalizeSlotName(target.slot_name);
    if (!groups.has(slot)) {
      groups.set(slot, {
        labware_slot: slot,
        labware_load_name: target.labware_load_name || null,
        wells: [],
        mode: target.mode || "require_presence",
        targets: [],
      });
    }
    const group = groups.get(slot);
    group.wells.push(target.well_name);
    group.targets.push(target);
    if (!group.labware_load_name && target.labware_load_name) {
      group.labware_load_name = target.labware_load_name;
    }
  }
  return [...groups.values()];
}
