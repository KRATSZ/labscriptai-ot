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
});
