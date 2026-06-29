import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import { TOOL_DEFINITIONS, TOOL_HANDLERS } from "../index.js";
import { readSessionState } from "../lib/state.js";

test("record_liquid_source_map persists operator-confirmed liquid identity", async () => {
  const originalSessionDir = process.env.OPENTRONS_SESSION_STATE_DIR;
  process.env.OPENTRONS_SESSION_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "liquid-source-map-"));

  try {
    const names = new Set(TOOL_DEFINITIONS.map(tool => tool.name));
    assert.equal(names.has("record_liquid_source_map"), true);
    assert.equal(names.has("get_liquid_source_map"), true);

    const result = await TOOL_HANDLERS.record_liquid_source_map({
      session_id: "liquid-map-test",
      sources: [
        {
          slot_name: "d3",
          well_name: "a1",
          labware_load_name: "corning_96_wellplate_360ul_flat",
          liquid_name: "water",
          sample_id: "plate-col1-a1",
          volume_ul: 120,
          capacity_ul: 360,
          dead_volume_ul: 5,
          liquid_class: "aqueous",
          trust_level: "declared",
          expected_presence: true,
          expected_min_height_mm: 2,
          notes: "User-filled D3 first column.",
        },
      ],
    });

    assert.equal(result.sessionId, "liquid-map-test");
    assert.equal(result.data.recorded_sources[0].slot_name, "D3");
    assert.equal(result.data.recorded_sources[0].well_name, "A1");
    assert.equal(result.data.recorded_sources[0].sample_id, "plate-col1-a1");

    const sessionState = readSessionState("liquid-map-test");
    assert.equal(sessionState.liquid_tracking.sources["D3.A1"].liquid_name, "water");
    assert.equal(sessionState.liquid_tracking.sources["D3.A1"].volume_ul, 120);
    assert.equal(sessionState.liquid_tracking.sources["D3.A1"].capacity_ul, 360);
    assert.equal(sessionState.liquid_tracking.sources["D3.A1"].dead_volume_ul, 5);
    assert.equal(sessionState.liquid_tracking.sources["D3.A1"].liquid_class, "aqueous");
    assert.equal(sessionState.liquid_tracking.sources["D3.A1"].trust_level, "declared");
    assert.equal(sessionState.liquid_tracking.sources["D3.A1"].expected_presence, true);
    assert.equal(sessionState.liquid_tracking.sources["D3.A1"].expected_min_height_mm, 2);
    assert.equal(sessionState.liquid_tracking.containers["D3.A1"].role, "source");
    assert.equal(sessionState.liquid_tracking.containers["D3.A1"].volume_ul, 120);

    const readback = await TOOL_HANDLERS.get_liquid_source_map({
      session_id: "liquid-map-test",
      slot_name: "d3",
      well_name: "a1",
    });
    assert.equal(readback.data.source_count, 1);
    assert.equal(readback.data.sources[0].key, "D3.A1");
    assert.equal(readback.data.sources[0].sample_id, "plate-col1-a1");
  } finally {
    if (originalSessionDir === undefined) {
      delete process.env.OPENTRONS_SESSION_STATE_DIR;
    } else {
      process.env.OPENTRONS_SESSION_STATE_DIR = originalSessionDir;
    }
  }
});

test("source-map summary reports live observed presence mismatches", async () => {
  const originalSessionDir = process.env.OPENTRONS_SESSION_STATE_DIR;
  process.env.OPENTRONS_SESSION_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "liquid-source-observed-"));

  try {
    await TOOL_HANDLERS.record_liquid_source_map({
      session_id: "liquid-observed-test",
      sources: [
        {
          slot_name: "D3",
          well_name: "H1",
          liquid_name: "water",
          sample_id: "water-d3-h1",
          expected_presence: true,
        },
        {
          slot_name: "C3",
          well_name: "A1",
          liquid_name: "water",
          sample_id: "water-c3-a1",
          expected_presence: true,
          observed_presence: true,
          observed_run_id: "positive-run",
        },
        {
          slot_name: "D3",
          well_name: "H1",
          observed_presence: false,
          observed_run_id: "probe-run",
          observed_source: "live_probe",
        },
      ],
    });

    const summary = await TOOL_HANDLERS.summarize_liquid_source_map({
      session_id: "liquid-observed-test",
    });

    assert.equal(summary.data.incomplete_expected_present_count, 0);
    assert.equal(summary.data.observed_presence_mismatch_count, 1);
    assert.deepEqual(
      summary.data.observed_presence_mismatch_sources.map(source => source.key),
      ["D3.H1"],
    );
    assert.equal(summary.data.observed_presence_mismatch_sources[0].observed_presence, false);
    assert.equal(summary.data.ready_for_semantic_recovery, false);
  } finally {
    if (originalSessionDir === undefined) {
      delete process.env.OPENTRONS_SESSION_STATE_DIR;
    } else {
      process.env.OPENTRONS_SESSION_STATE_DIR = originalSessionDir;
    }
  }
});

test("summarize_liquid_source_map reports incomplete semantic recovery identity", async () => {
  const originalSessionDir = process.env.OPENTRONS_SESSION_STATE_DIR;
  const originalResultLogDir = process.env.OPENTRONS_RESULT_LOG_DIR;
  process.env.OPENTRONS_SESSION_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "liquid-source-summary-"));
  process.env.OPENTRONS_RESULT_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "liquid-source-summary-log-"));

  try {
    const names = new Set(TOOL_DEFINITIONS.map(tool => tool.name));
    assert.equal(names.has("summarize_liquid_source_map"), true);

    await TOOL_HANDLERS.record_liquid_source_map({
      session_id: "liquid-summary-test",
      sources: [
        {
          slot_name: "C3",
          well_name: "A1",
          liquid_name: "buffer-a",
          sample_id: "reservoir-buffer-a",
          expected_presence: true,
        },
        {
          slot_name: "D3",
          well_name: "A1",
          liquid_name: "operator-confirmed-liquid",
          expected_presence: true,
        },
        {
          slot_name: "D3",
          well_name: "B1",
          expected_presence: true,
        },
        {
          slot_name: "D3",
          well_name: "A12",
          liquid_name: "empty-control",
          sample_id: "validated-empty-source-d3-a12",
          expected_presence: false,
        },
      ],
    });

    const summary = await TOOL_HANDLERS.summarize_liquid_source_map({
      session_id: "liquid-summary-test",
    });

    assert.equal(summary.data.source_count, 4);
    assert.equal(summary.data.expected_present_count, 3);
    assert.equal(summary.data.expected_absent_count, 1);
    assert.equal(summary.data.incomplete_expected_present_count, 2);
    assert.equal(summary.data.ready_for_semantic_recovery, false);
    assert.deepEqual(
      summary.data.incomplete_expected_present_sources.map(source => source.key),
      ["D3.A1", "D3.B1"],
    );
    assert.deepEqual(summary.data.incomplete_expected_present_sources[0].missing_identity_fields, [
      "specific_liquid_name",
      "sample_id",
    ]);
    assert.deepEqual(summary.data.incomplete_expected_present_sources[1].missing_identity_fields, [
      "liquid_name",
      "sample_id",
    ]);
    assert.deepEqual(
      summary.data.record_liquid_source_map_template.map(source => ({
        slot_name: source.slot_name,
        well_name: source.well_name,
        liquid_name: source.liquid_name,
        sample_id: source.sample_id,
      })),
      [
        {
          slot_name: "D3",
          well_name: "A1",
          liquid_name: "TODO_specific_liquid_name",
          sample_id: "TODO_sample_id",
        },
        {
          slot_name: "D3",
          well_name: "B1",
          liquid_name: "TODO_specific_liquid_name",
          sample_id: "TODO_sample_id",
        },
      ],
    );
    assert.equal(summary.data.record_liquid_source_map_draft.session_id, "liquid-summary-test");
    assert.deepEqual(
      summary.data.record_liquid_source_map_draft.sources,
      summary.data.record_liquid_source_map_template,
    );
    assert.equal(summary.data.complete_expected_present_sources[0].key, "C3.A1");
    assert.equal(summary.data.expected_absent_sources[0].key, "D3.A12");

    const d3Summary = await TOOL_HANDLERS.summarize_liquid_source_map({
      session_id: "liquid-summary-test",
      slot_name: "D3",
    });
    assert.equal(d3Summary.data.slot_filter, "D3");
    assert.equal(d3Summary.data.source_count, 3);
    assert.equal(d3Summary.data.incomplete_expected_present_count, 2);

    const history = await TOOL_HANDLERS.experiment_history({
      session_id: "liquid-summary-test",
      tool_name: "summarize_liquid_source_map",
      event_kind: "source_map_readiness",
    });
    assert.equal(history.data.entries.length, 2);
    assert.equal(history.data.entries[0].status, "warn");
    assert.equal(history.data.entries[0].data.ready_for_semantic_recovery, false);
    assert.equal(history.data.entries[0].data.incomplete_expected_present_count, 2);
    assert.equal(history.data.entries[0].data.record_liquid_source_map_template.length, 2);
    assert.equal(history.data.entries[0].data.record_liquid_source_map_draft.session_id, "liquid-summary-test");
    assert.equal(history.data.entries[0].data.record_liquid_source_map_draft.sources.length, 2);
    assert.deepEqual(history.data.entries[0].data.incomplete_expected_present_sources[0].missing_identity_fields, [
      "specific_liquid_name",
      "sample_id",
    ]);
  } finally {
    if (originalSessionDir === undefined) {
      delete process.env.OPENTRONS_SESSION_STATE_DIR;
    } else {
      process.env.OPENTRONS_SESSION_STATE_DIR = originalSessionDir;
    }
    if (originalResultLogDir === undefined) {
      delete process.env.OPENTRONS_RESULT_LOG_DIR;
    } else {
      process.env.OPENTRONS_RESULT_LOG_DIR = originalResultLogDir;
    }
  }
});

test("summarize_liquid_source_map becomes ready after operator records specific identities", async () => {
  const originalSessionDir = process.env.OPENTRONS_SESSION_STATE_DIR;
  const originalResultLogDir = process.env.OPENTRONS_RESULT_LOG_DIR;
  process.env.OPENTRONS_SESSION_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "liquid-source-ready-"));
  process.env.OPENTRONS_RESULT_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "liquid-source-ready-log-"));

  try {
    await TOOL_HANDLERS.record_liquid_source_map({
      session_id: "liquid-ready-test",
      sources: [
        {
          slot_name: "C3",
          well_name: "A1",
          labware_load_name: "nest_12_reservoir_15ml",
          liquid_name: "operator-confirmed-liquid",
          expected_presence: true,
        },
        {
          slot_name: "D3",
          well_name: "A1",
          labware_load_name: "corning_96_wellplate_360ul_flat",
          expected_presence: true,
        },
      ],
    });

    const incomplete = await TOOL_HANDLERS.summarize_liquid_source_map({
      session_id: "liquid-ready-test",
    });
    assert.equal(incomplete.data.ready_for_semantic_recovery, false);
    assert.equal(incomplete.data.incomplete_expected_present_count, 2);
    assert.equal(incomplete.data.record_liquid_source_map_draft.sources.length, 2);

    await TOOL_HANDLERS.record_liquid_source_map({
      session_id: "liquid-ready-test",
      sources: [
        {
          slot_name: "C3",
          well_name: "A1",
          labware_load_name: "nest_12_reservoir_15ml",
          liquid_name: "reservoir-buffer-a",
          sample_id: "reservoir-buffer-a-c3-a1",
          expected_presence: true,
        },
        {
          slot_name: "D3",
          well_name: "A1",
          labware_load_name: "corning_96_wellplate_360ul_flat",
          liquid_name: "reaction-sample",
          sample_id: "reaction-sample-d3-a1",
          expected_presence: true,
        },
      ],
    });

    const ready = await TOOL_HANDLERS.summarize_liquid_source_map({
      session_id: "liquid-ready-test",
    });
    assert.equal(ready.data.ready_for_semantic_recovery, true);
    assert.equal(ready.data.incomplete_expected_present_count, 0);
    assert.deepEqual(ready.data.incomplete_expected_present_sources, []);
    assert.deepEqual(ready.data.record_liquid_source_map_template, []);
    assert.deepEqual(ready.data.record_liquid_source_map_draft.sources, []);
    assert.deepEqual(
      ready.data.complete_expected_present_sources.map(source => source.key),
      ["C3.A1", "D3.A1"],
    );

    const history = await TOOL_HANDLERS.experiment_history({
      session_id: "liquid-ready-test",
      tool_name: "summarize_liquid_source_map",
      event_kind: "source_map_readiness",
    });
    assert.equal(history.data.entries.length, 2);
    const passEntry = history.data.entries.find(entry => entry.status === "pass");
    const warnEntry = history.data.entries.find(entry => entry.status === "warn");
    assert.equal(passEntry.data.ready_for_semantic_recovery, true);
    assert.equal(warnEntry.data.ready_for_semantic_recovery, false);
  } finally {
    if (originalSessionDir === undefined) {
      delete process.env.OPENTRONS_SESSION_STATE_DIR;
    } else {
      process.env.OPENTRONS_SESSION_STATE_DIR = originalSessionDir;
    }
    if (originalResultLogDir === undefined) {
      delete process.env.OPENTRONS_RESULT_LOG_DIR;
    } else {
      process.env.OPENTRONS_RESULT_LOG_DIR = originalResultLogDir;
    }
  }
});

test("validate_virtual_lab_state_steps handler blocks deterministic liquid violations without persisting", async () => {
  const names = new Set(TOOL_DEFINITIONS.map(tool => tool.name));
  assert.equal(names.has("validate_virtual_lab_state_steps"), true);

  const result = await TOOL_HANDLERS.validate_virtual_lab_state_steps({
    session_id: "virtual-handler-test",
    initial_state: {
      session_id: "virtual-handler-test",
      state_revision: 12,
      pipettes: { left: { tip_attached: true } },
      tip_tracking: { tipracks: {} },
      liquid_tracking: {
        containers: {
          "D3.A1": {
            container_key: "D3.A1",
            role: "source",
            volume_ul: 50,
            capacity_ul: 100,
            dead_volume_ul: 5,
            trust_level: "declared",
          },
          "C3.A1": {
            container_key: "C3.A1",
            role: "destination",
            volume_ul: 15,
            capacity_ul: 40,
            dead_volume_ul: 0,
            trust_level: "declared",
          },
        },
      },
      cleanup: { pending_actions: [], auto_home_allowed: null },
    },
    steps: [
      {
        id: "overflow-before-sim",
        type: "transfer",
        source_key: "D3.A1",
        target_key: "C3.A1",
        volume_ul: 30,
        pipette_id: "left",
      },
    ],
  });

  assert.equal(result.data.ok, false);
  assert.equal(result.data.persisted, false);
  assert.equal(result.stateRevision, 12);
  assert.ok(result.data.violations.some(violation => violation.code === "liquid_volume_exceeds_capacity"));
});
