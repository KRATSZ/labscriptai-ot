import test from "node:test";
import assert from "node:assert/strict";

import { listCriticalProbeTargets } from "../lib/critical-probe-targets.js";

test("listCriticalProbeTargets prefers explicit critical_sources argument", () => {
  const result = listCriticalProbeTargets({
    criticalSources: [{ slot: "D3", well: "A1", role: "wash_buffer" }],
  });

  assert.equal(result.target_count, 1);
  assert.equal(result.targets[0].slot_name, "D3");
  assert.equal(result.targets[0].well_name, "A1");
  assert.equal(result.source, "explicit_argument");
  assert.equal(result.probe_gate, "required");
});

test("listCriticalProbeTargets filters session source map by critical role", () => {
  const result = listCriticalProbeTargets({
    sessionState: {
      liquid_tracking: {
        probe_policy: "critical_sources_only",
        sources: {
          "D3.A1": {
            slot_name: "D3",
            well_name: "A1",
            expected_presence: true,
            role: "wash_buffer",
          },
          "C3.A1": {
            slot_name: "C3",
            well_name: "A1",
            expected_presence: true,
            role: "buffer",
          },
        },
      },
    },
  });

  assert.equal(result.target_count, 1);
  assert.equal(result.targets[0].key, "D3.A1");
});

test("sample and reagent roles are not critical by default", () => {
  const result = listCriticalProbeTargets({
    sessionState: {
      liquid_tracking: {
        sources: {
          "D1.A1": {
            slot_name: "D1",
            well_name: "A1",
            expected_presence: true,
            role: "sample",
          },
          "D2.A1": {
            slot_name: "D2",
            well_name: "A1",
            expected_presence: true,
            role: "reagent",
          },
          "D3.A1": {
            slot_name: "D3",
            well_name: "A1",
            expected_presence: true,
            role: "enzyme",
          },
        },
      },
    },
  });

  assert.equal(result.target_count, 1);
  assert.equal(result.targets[0].role, "enzyme");
});

test("sample/reagent become critical only when explicitly flagged", () => {
  const result = listCriticalProbeTargets({
    sessionState: {
      liquid_tracking: {
        sources: {
          "D1.A1": {
            slot_name: "D1",
            well_name: "A1",
            expected_presence: true,
            role: "sample",
            critical: true,
          },
        },
      },
    },
  });

  assert.equal(result.target_count, 1);
  assert.equal(result.targets[0].role, "sample");
});

test("zero critical targets skip/pass the probe gate", () => {
  const result = listCriticalProbeTargets({
    sessionState: {
      liquid_tracking: {
        sources: {
          "C3.A1": {
            slot_name: "C3",
            well_name: "A1",
            expected_presence: true,
            role: "buffer",
          },
        },
      },
    },
  });

  assert.equal(result.target_count, 0);
  assert.equal(result.gate_status, "passed");
  assert.equal(result.probe_gate, "skipped");
  assert.equal(result.skip_reason, "no_critical_targets");
  assert.equal(result.no_probe_confirmation, true);
  assert.deepEqual(result.recommended_next_actions, ["continue_live_preflight"]);
});

test("listCriticalProbeTargets can fall back to all expected-present sources", () => {
  const result = listCriticalProbeTargets({
    includeAllExpectedPresent: true,
    sessionState: {
      liquid_tracking: {
        sources: {
          "D3.A1": {
            slot_name: "D3",
            well_name: "A1",
            expected_presence: true,
          },
        },
      },
    },
  });

  assert.equal(result.target_count, 1);
  assert.equal(result.fallback_used, true);
  assert.equal(result.probe_gate, "required");
});
