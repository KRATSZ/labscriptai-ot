const FLEX_PIPETTE_NAME_ALIASES = new Map([
  ["p50_single_flex", "flex_1channel_50"],
  ["p50_multi_flex", "flex_8channel_50"],
  ["p50_96_flex", "flex_96channel_50"],
  ["p1000_single_flex", "flex_1channel_1000"],
  ["p1000_multi_flex", "flex_8channel_1000"],
  ["p1000_multi_em_flex", "flex_8channel_1000_em"],
  ["p1000_96", "flex_96channel_1000"],
  ["p200_96", "flex_96channel_200"],
  ["p1000_96_flex", "flex_96channel_1000"],
]);

// Public names from opentrons_shared_data.pipette.types.PIPETTE_API_NAMES_MAP.
// Keep unknown/versioned model strings out of generated load_instrument calls.
const PROTOCOL_PIPETTE_NAMES = new Set([
  "p10_single", "p10_multi", "p20_single_gen2", "p20_multi_gen2",
  "p50_single", "p50_multi", "p300_single", "p300_multi",
  "p300_single_gen2", "p300_multi_gen2", "p1000_single", "p1000_single_gen2",
  "flex_1channel_50", "flex_8channel_50", "flex_1channel_1000", "flex_8channel_1000",
  "flex_8channel_1000_em", "flex_96channel_1000", "flex_96channel_200",
]);

export function normalizePipetteProtocolName(pipetteName) {
  const normalized = String(pipetteName || "").trim();
  return FLEX_PIPETTE_NAME_ALIASES.get(normalized.toLowerCase()) || normalized || null;
}

// Recognize reported API load names, not hardware model/version strings.
export function knownPipetteProtocolName(pipetteName) {
  const name = normalizePipetteProtocolName(pipetteName);
  return PROTOCOL_PIPETTE_NAMES.has(name) ? name : null;
}
