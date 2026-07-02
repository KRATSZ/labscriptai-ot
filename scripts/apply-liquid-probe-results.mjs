#!/usr/bin/env node
/**
 * Apply live liquid probe observations to the session source map.
 *
 * Thin CLI wrapper around servers/opentrons-mcp TOOL_HANDLERS.apply_liquid_probe_results.
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const artifactPath = path.resolve(requireString(args.probe_artifact, "--probe-artifact"));
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));

  const { TOOL_HANDLERS } = await import(path.join(PLUGIN_ROOT, "servers", "opentrons-mcp", "index.js"));
  const result = await TOOL_HANDLERS.apply_liquid_probe_results({
    session_id: args.session_id,
    probe_artifact_path: artifactPath,
    probe_results: Array.isArray(artifact.probe_results) ? artifact.probe_results : undefined,
    generated_protocol_path: artifact.generated_protocol_path || null,
    slot_name: args.slot_name || undefined,
    labware_load_name: args.labware_load_name || undefined,
    run_id: artifact.run_id || artifact.summary?.run_id || null,
    mode: artifact.mode || undefined,
  });

  const payload = {
    ...result.data,
    probe_artifact_path: artifactPath,
    record_result: result.data.record_result,
  };

  if (args.out) {
    const outPath = path.resolve(args.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
    payload.output_path = outPath;
  }

  console.log(
    JSON.stringify(
      {
        status: payload.status,
        session_id: payload.session_id,
        run_id: payload.run_id,
        slot_name: payload.slot_name,
        applied_count: payload.applied_count,
        observed_presence_mismatch_count: payload.source_map_summary?.observed_presence_mismatch_count,
        observed_presence_mismatch_keys:
          payload.source_map_summary?.observed_presence_mismatch_sources?.map(source => source.key) || [],
        ready_for_semantic_recovery: payload.source_map_summary?.ready_for_semantic_recovery,
        output_path: payload.output_path || null,
      },
      null,
      2,
    ),
  );
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
