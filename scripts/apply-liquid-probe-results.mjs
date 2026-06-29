#!/usr/bin/env node
/**
 * Apply live liquid probe observations to the session source map.
 *
 * This records observed_presence separately from operator/source-map
 * expected_presence, so mismatches remain visible instead of silently changing
 * experimental intent.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(process.env.OPENTRONS_PLUGIN_ROOT || path.join(__dirname, ".."));
const DEFAULT_SESSION_ID = "self-recovery-liquid";

function parseArgs(argv) {
  const args = {
    session_id: process.env.OPENTRONS_SESSION_ID || DEFAULT_SESSION_ID,
    probe_artifact: null,
    slot_name: null,
    labware_load_name: null,
    out: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--session-id") {
      args.session_id = argv[index + 1];
      index += 1;
    } else if (item === "--probe-artifact") {
      args.probe_artifact = argv[index + 1];
      index += 1;
    } else if (item === "--slot") {
      args.slot_name = argv[index + 1];
      index += 1;
    } else if (item === "--labware-load-name") {
      args.labware_load_name = argv[index + 1];
      index += 1;
    } else if (item === "--out") {
      args.out = argv[index + 1];
      index += 1;
    }
  }
  return args;
}

function requireString(value, name) {
  const normalized = value ? String(value).trim() : "";
  if (!normalized) {
    throw new Error(`${name} is required.`);
  }
  return normalized;
}

function inferSlotFromProtocolPath(protocolPath) {
  const text = protocolPath && fs.existsSync(protocolPath) ? fs.readFileSync(protocolPath, "utf8") : "";
  const match = text.match(/protocol\.load_labware\([^,\n]+,\s*["']([A-D][1-4])["']/i);
  return match ? match[1].toUpperCase() : null;
}

function inferLabwareFromProtocolPath(protocolPath) {
  const text = protocolPath && fs.existsSync(protocolPath) ? fs.readFileSync(protocolPath, "utf8") : "";
  const match = text.match(/protocol\.load_labware\(["']([^"']+)["'],\s*["'][A-D][1-4]["']/i);
  return match ? match[1] : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const artifactPath = path.resolve(requireString(args.probe_artifact, "--probe-artifact"));
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const probeResults = Array.isArray(artifact.probe_results) ? artifact.probe_results : [];
  if (probeResults.length === 0) {
    throw new Error("Probe artifact does not contain probe_results.");
  }

  const generatedProtocolPath = artifact.generated_protocol_path || null;
  const slotName = String(args.slot_name || inferSlotFromProtocolPath(generatedProtocolPath) || "").toUpperCase();
  if (!slotName) {
    throw new Error("--slot is required when it cannot be inferred from generated_protocol_path.");
  }
  const labwareLoadName = args.labware_load_name || inferLabwareFromProtocolPath(generatedProtocolPath) || null;
  const observedAt = new Date().toISOString();
  const runId = artifact.run_id || artifact.summary?.run_id || null;

  const { TOOL_HANDLERS } = await import(path.join(PLUGIN_ROOT, "servers", "opentrons-mcp", "index.js"));
  const sources = probeResults.map(result => ({
    slot_name: slotName,
    well_name: result.well,
    labware_load_name: labwareLoadName,
    observed_presence: result.value === true,
    observed_at: observedAt,
    observed_run_id: runId,
    observed_source: "live_probe",
    notes: result.value === true
      ? `Live probe ${runId || "unknown-run"} observed liquid present.`
      : `Live probe ${runId || "unknown-run"} observed no liquid.`,
  }));

  const recordResult = await TOOL_HANDLERS.record_liquid_source_map({
    session_id: args.session_id,
    sources,
  });
  const summaryResult = await TOOL_HANDLERS.summarize_liquid_source_map({
    session_id: args.session_id,
  });

  const payload = {
    status: "completed",
    session_id: args.session_id,
    probe_artifact_path: artifactPath,
    run_id: runId,
    slot_name: slotName,
    labware_load_name: labwareLoadName,
    applied_count: sources.length,
    applied_sources: sources,
    record_result: recordResult,
    source_map_summary: summaryResult.data,
  };

  if (args.out) {
    const outPath = path.resolve(args.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
    payload.output_path = outPath;
  }

  console.log(JSON.stringify({
    status: payload.status,
    session_id: payload.session_id,
    run_id: payload.run_id,
    slot_name: payload.slot_name,
    applied_count: payload.applied_count,
    observed_presence_mismatch_count: payload.source_map_summary.observed_presence_mismatch_count,
    observed_presence_mismatch_keys:
      payload.source_map_summary.observed_presence_mismatch_sources?.map(source => source.key) || [],
    ready_for_semantic_recovery: payload.source_map_summary.ready_for_semantic_recovery,
    output_path: payload.output_path || null,
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
