#!/usr/bin/env node
/**
 * Generate docs/MCP_TOOLS.md from servers/opentrons-mcp/index.js TOOL_DEFINITIONS.
 * Usage: node scripts/generate-mcp-docs.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "..");
const MCP_INDEX = path.join(PLUGIN_ROOT, "servers/opentrons-mcp/index.js");
const OUT_PATH = path.join(PLUGIN_ROOT, "docs/MCP_TOOLS.md");

process.env.OPENTRONS_PLUGIN_ROOT = PLUGIN_ROOT;

const TIER_LABELS = {
  L0: "Getting started — local simulation and environment",
  L1: "Authoring helpers — labware, tips, preflight",
  L2: "Live read-only — robot and session status",
  L3: "Live control — opt-in motion and runs",
  L4: "Recovery and vision — on demand",
};

const TIER_ORDER = ["L0", "L1", "L2", "L3", "L4"];

const TOOL_TIERS = {
  health_check: "L0",
  doctor_local_runtime: "L0",
  simulate_protocol: "L0",
  parse_simulation_output: "L0",
  validate_labware_name: "L0",
  estimate_tip_budget: "L1",
  inspect_labware_definition: "L1",
  preflight_run_setup: "L1",
  robot_health: "L2",
  robot_status: "L2",
  module_status: "L2",
  get_slot_occupation: "L2",
  list_available_slots: "L2",
  list_tip_candidates: "L2",
  suggest_next_tip_well: "L2",
  is_home_safe: "L2",
  reconcile_state: "L2",
  live_readiness_check: "L2",
  get_protocols: "L2",
  get_runs: "L2",
  run_history: "L2",
  experiment_history: "L2",
  restart_review: "L2",
  safe_next_action: "L2",
  run_protocol: "L3",
  create_run: "L3",
  control_run: "L3",
  probe_wells: "L3",
  upload_protocol: "L3",
  create_run_context: "L3",
  load_pipette: "L3",
  load_labware: "L3",
  load_module: "L3",
  control_temperature_module: "L3",
  control_heater_shaker: "L3",
  control_thermocycler: "L3",
  move_labware: "L3",
  cleanup_motion: "L3",
  execute_protocol_recovery: "L3",
  recover_tip_pickup: "L3",
  parse_error: "L4",
  suggest_recovery_action: "L4",
  vision_check: "L4",
  camera_status: "L4",
  configure_camera: "L4",
  capture_preview_image: "L4",
  capture_run_image: "L4",
  list_data_files: "L4",
  download_data_file: "L4",
  analyze_image_with_kimi: "L4",
};

function requiredParams(schema) {
  if (!schema?.properties) return "—";
  const req = new Set(schema.required || []);
  const names = Object.keys(schema.properties);
  if (names.length === 0) return "—";
  return names.map((n) => (req.has(n) ? `\`${n}\`` : `\`${n}\` (optional)`)).join(", ");
}

async function main() {
  const mod = await import(pathToFileURL(MCP_INDEX).href);
  const tools = mod.TOOL_DEFINITIONS || [];

  const byTier = Object.fromEntries(TIER_ORDER.map((t) => [t, []]));
  for (const tool of tools) {
    const tier = TOOL_TIERS[tool.name] || "L2";
    byTier[tier].push(tool);
  }

  const lines = [
    "# MCP tools reference",
    "",
    "Auto-generated from `servers/opentrons-mcp/index.js`. Regenerate:",
    "",
    "```bash",
    "node scripts/generate-mcp-docs.mjs",
    "```",
    "",
    "Server name: `opentrons-lab`. Workflows: [policy/workflows.md](../policy/workflows.md). Glossary: [GLOSSARY.md](GLOSSARY.md).",
    "",
    "## Tier overview",
    "",
    "| Tier | Focus | Default exposure |",
    "|------|-------|------------------|",
    "| **L0** | Local sim and environment | Always |",
    "| **L1** | Authoring helpers | Always |",
    "| **L2** | Live read-only status | Needs robot IP |",
    "| **L3** | Live control | Explicit opt-in |",
    "| **L4** | Recovery and vision | On demand |",
    "",
  ];

  for (const tier of TIER_ORDER) {
    lines.push(`## ${tier} — ${TIER_LABELS[tier]}`, "");
    for (const tool of byTier[tier].sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`### \`${tool.name}\` [${tier}]`, "");
      lines.push(tool.description || "(no description)", "");
      lines.push(`**Parameters:** ${requiredParams(tool.inputSchema)}`, "");
    }
  }

  lines.push("## Safety reminders", "");
  lines.push("- Simulation gate is blocking before unattended live runs.");
  lines.push("- Vision is observation-only; use `reconcile_state` for deck truth.");
  lines.push("- `probe_wells` live motion requires `OPENTRONS_ENABLE_PROBE_WELLS=1`.");
  lines.push("");

  fs.writeFileSync(OUT_PATH, lines.join("\n"));
  console.log(`Wrote ${OUT_PATH} (${tools.length} tools)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
