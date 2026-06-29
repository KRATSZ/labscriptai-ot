import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import { readSessionState, writeSessionState, setLiquidContainerState } from "../lib/state.js";
import { appendResultLogEntry, readResultLogEntries } from "../lib/result-log.js";
import { buildReconciliationResult } from "../lib/decision.js";

function buildReconcileSessionState() {
  const state = {
    session_id: "reconcile-liquid",
    state_revision: 1,
    deck: { slots: {} },
    pipettes: {},
    tip_tracking: { tipracks: {} },
    liquid_tracking: { containers: {}, sources: {} },
    state_history: [],
    cleanup: { pending_actions: [], auto_home_allowed: null },
  };
  return state;
}

test("restart review: reconcile flag wins over a historical success log entry", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "opentrons-restart-"));
  const sessionDir = path.join(tempDir, "session-state");
  const logDir = path.join(tempDir, "result-logs");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });

  const originalSessionDir = process.env.OPENTRONS_SESSION_STATE_DIR;
  const originalLogDir = process.env.OPENTRONS_RESULT_LOG_DIR;

  process.env.OPENTRONS_SESSION_STATE_DIR = sessionDir;
  process.env.OPENTRONS_RESULT_LOG_DIR = logDir;

  try {
    writeSessionState({
      session_id: "restart-session",
      needs_reconciliation: true,
      state_revision: 3,
      deck: { slots: {} },
    });

    appendResultLogEntry({
      session_id: "restart-session",
      run_id: "run-old",
      tool_name: "run_protocol",
      event_kind: "protocol_run",
      status: "succeeded",
      summary: "Historical run succeeded",
      data: { note: "append-only evidence only" },
    });

    const session = readSessionState("restart-session");
    const entries = readResultLogEntries({ session_id: "restart-session", limit: 10 });

    assert.equal(session.needs_reconciliation, true);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].tool_name, "run_protocol");
    assert.equal(entries[0].status, "succeeded");

    const restartGuidance = {
      mustReconcileBeforeAutonomousMotion: session.needs_reconciliation === true,
      lastLogStatus: entries[0]?.status || null,
    };

    assert.equal(restartGuidance.mustReconcileBeforeAutonomousMotion, true);
    assert.equal(restartGuidance.lastLogStatus, "succeeded");
  } finally {
    if (originalSessionDir === undefined) {
      delete process.env.OPENTRONS_SESSION_STATE_DIR;
    } else {
      process.env.OPENTRONS_SESSION_STATE_DIR = originalSessionDir;
    }
    if (originalLogDir === undefined) {
      delete process.env.OPENTRONS_RESULT_LOG_DIR;
    } else {
      process.env.OPENTRONS_RESULT_LOG_DIR = originalLogDir;
    }
  }
});

test("reconcile_state flags liquid_volume_mismatch when observed volume differs from committed", () => {
  const sessionState = buildReconcileSessionState();
  setLiquidContainerState(sessionState, {
    container_key: "D3.A1",
    role: "source",
    liquid_name: "water",
    volume_ul: 100,
    capacity_ul: 300,
    dead_volume_ul: 10,
    trust_level: "declared",
  });

  const result = buildReconciliationResult({
    sessionState,
    robotStatusSnapshot: { instruments_summary: [] },
    moduleStatusSnapshot: null,
    observedDeckState: null,
    observedLiquidTracking: [
      {
        container_key: "D3.A1",
        role: "source",
        liquid_name: "water",
        volume_ul: 80,
        capacity_ul: 300,
        dead_volume_ul: 10,
        trust_level: "declared",
      },
    ],
    run: null,
  });

  const volumeMismatch = result.diffs.find(diff => diff.type === "liquid_volume_mismatch");
  assert.ok(volumeMismatch, "expected a liquid_volume_mismatch diff");
  assert.equal(volumeMismatch.container_key, "D3.A1");
  assert.equal(volumeMismatch.committed, 100);
  assert.equal(volumeMismatch.observed, 80);

  const trustMismatch = result.diffs.find(diff => diff.type === "liquid_trust_mismatch");
  assert.equal(trustMismatch, undefined, "no trust mismatch when trust levels match");
  assert.equal(result.proposed_commit.liquid_tracking.containers["D3.A1"].trust_level, "declared");
});

test("reconcile_state flags liquid_trust_mismatch without spuriously flagging volume", () => {
  const sessionState = buildReconcileSessionState();
  setLiquidContainerState(sessionState, {
    container_key: "D3.A1",
    role: "source",
    volume_ul: 100,
    capacity_ul: 300,
    trust_level: "declared",
  });

  const result = buildReconciliationResult({
    sessionState,
    robotStatusSnapshot: { instruments_summary: [] },
    moduleStatusSnapshot: null,
    observedDeckState: null,
    observedLiquidTracking: [
      {
        container_key: "D3.A1",
        role: "source",
        volume_ul: 100,
        capacity_ul: 300,
        trust_level: "observed",
      },
    ],
    run: null,
  });

  const trustMismatch = result.diffs.find(diff => diff.type === "liquid_trust_mismatch");
  assert.ok(trustMismatch, "expected a liquid_trust_mismatch diff");
  assert.equal(trustMismatch.committed, "declared");
  assert.equal(trustMismatch.observed, "observed");

  const volumeMismatch = result.diffs.find(diff => diff.type === "liquid_volume_mismatch");
  assert.equal(volumeMismatch, undefined, "no volume mismatch when volumes match");
  assert.equal(result.proposed_commit.liquid_tracking.containers["D3.A1"].trust_level, "observed");
});

test("reconcile_state flags liquid_container_missing for observed wells not yet declared", () => {
  const sessionState = buildReconcileSessionState();

  const result = buildReconciliationResult({
    sessionState,
    robotStatusSnapshot: { instruments_summary: [] },
    moduleStatusSnapshot: null,
    observedDeckState: null,
    observedLiquidTracking: [
      {
        container_key: "D3.A2",
        role: "source",
        liquid_name: "buffer",
        volume_ul: 150,
        capacity_ul: 300,
        trust_level: "observed",
      },
    ],
    run: null,
  });

  const missing = result.diffs.find(diff => diff.type === "liquid_container_missing");
  assert.ok(missing, "expected a liquid_container_missing diff");
  assert.equal(missing.container_key, "D3.A2");
  assert.equal(result.proposed_commit.liquid_tracking.containers["D3.A2"].trust_level, "observed");
});
