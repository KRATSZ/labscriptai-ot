import test from "node:test";
import assert from "node:assert/strict";
import path from "path";
import { fileURLToPath } from "url";

import {
  buildSourcesFromProbeResults,
  inferSlotFromProtocolPath,
  probeResultToSourceUpdate,
  resolveProbeContext,
} from "../lib/liquid-probe-results.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const probeFixturePath = path.join(__dirname, "fixtures", "probe-protocol-slot-c2.py");

test("probeResultToSourceUpdate maps detect_presence boolean", () => {
  const source = probeResultToSourceUpdate(
    { well: "A1", mode: "detect_presence", success: true, value: true },
    { slotName: "C2", labwareLoadName: "nest_12_reservoir_15ml", runId: "run-1", observedAt: "2026-07-01T00:00:00.000Z" },
  );
  assert.equal(source.observed_presence, true);
  assert.equal(source.observed_height_mm, null);
  assert.equal(source.observed_probe_mode, "detect_presence");
  assert.equal(source.slot_name, "C2");
});

test("probeResultToSourceUpdate maps measure_height numeric value", () => {
  const source = probeResultToSourceUpdate(
    { well: "A1", mode: "measure_height", success: true, value: 12.4 },
    { slotName: "C2", runId: "run-2", observedAt: "2026-07-01T00:00:00.000Z" },
  );
  assert.equal(source.observed_height_mm, 12.4);
  assert.equal(source.observed_presence, true);
  assert.equal(source.observed_probe_mode, "measure_height");
});

test("resolveProbeContext infers slot from generated protocol path", () => {
  const context = resolveProbeContext({
    probe_results: [{ well: "A1", mode: "detect_presence", success: true, value: false }],
    generated_protocol_path: probeFixturePath,
    slot_name: "C2",
  });
  assert.equal(context.slotName, "C2");
  assert.equal(context.probeResults.length, 1);
});

test("inferSlotFromProtocolPath reads labware slot", () => {
  const slot = inferSlotFromProtocolPath(probeFixturePath);
  assert.equal(slot, "C2");
});

test("apply_liquid_probe_results MCP tool writes observed fields to session", async () => {
  const { TOOL_HANDLERS } = await import("../index.js");
  const sessionId = `liquid-probe-apply-${Date.now()}`;

  await TOOL_HANDLERS.record_liquid_source_map({
    session_id: sessionId,
    sources: [
      {
        slot_name: "C2",
        well_name: "A1",
        labware_load_name: "nest_12_reservoir_15ml",
        liquid_name: "water",
        expected_presence: true,
      },
    ],
  });

  const result = await TOOL_HANDLERS.apply_liquid_probe_results({
    session_id: sessionId,
    slot_name: "C2",
    labware_load_name: "nest_12_reservoir_15ml",
    run_id: "run-probe-1",
    mode: "measure_height",
    probe_results: [{ well: "A1", mode: "measure_height", success: true, value: 8.5 }],
  });

  assert.equal(result.data.applied_count, 1);
  assert.equal(result.data.applied_sources[0].observed_height_mm, 8.5);
  assert.equal(result.data.applied_sources[0].observed_probe_mode, "measure_height");

  const sourceMap = await TOOL_HANDLERS.get_liquid_source_map({ session_id: sessionId, slot_name: "C2" });
  const entry = sourceMap.data.sources.find(source => source.well_name === "A1");
  assert.equal(entry.observed_height_mm, 8.5);
  assert.equal(entry.observed_presence, true);
  assert.equal(entry.trust_level, "observed");
});

test("buildSourcesFromProbeResults handles multiple wells", () => {
  const sources = buildSourcesFromProbeResults(
    [
      { well: "A1", mode: "detect_presence", success: true, value: true },
      { well: "A2", mode: "detect_presence", success: true, value: false },
    ],
    { slotName: "D2", runId: "run-3", mode: "detect_presence" },
  );
  assert.equal(sources.length, 2);
  assert.equal(sources[0].observed_presence, true);
  assert.equal(sources[1].observed_presence, false);
});
