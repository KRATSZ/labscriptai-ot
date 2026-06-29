import test from "node:test";
import assert from "node:assert/strict";

import { TOOL_DEFINITIONS, TOOL_HANDLERS } from "../index.js";

test("runtime_recovery_self_test is registered and passes no-motion liquid recovery invariants", async () => {
  const names = new Set(TOOL_DEFINITIONS.map(tool => tool.name));
  assert.equal(names.has("runtime_recovery_self_test"), true);
  assert.equal(typeof TOOL_HANDLERS.runtime_recovery_self_test, "function");

  const result = await TOOL_HANDLERS.runtime_recovery_self_test({});

  assert.equal(result.data.status, "pass");
  assert.equal(result.data.runtime_build, "liquid-source-map-v2");
  assert.equal(result.data.fixture.motion, "none");
  assert.equal(result.data.fixture.network, "none");
  assert.deepEqual(result.data.failed_checks, []);
  assert.ok(result.data.checks.length >= 8);
  assert.equal(result.data.checks.every(check => check.status === "pass"), true);

  assert.equal(result.data.classification.error_category, "INSUFFICIENT_VOLUME");
  assert.equal(result.data.classification.error_leaf, "INSUFFICIENT_VOLUME");
  assert.equal(result.data.recovery.action, "manual_only");
  assert.equal(result.data.recovery.auto_executable, false);
  assert.equal(result.data.action_summary.then_resume, false);
  assert.equal(result.data.action_summary.params.source_map_key, "D3.A12");
  assert.equal(result.data.action_summary.params.source_map_expected_presence, false);
  assert.equal(result.data.action_summary.params.observed_liquid_presence, false);
  assert.equal(result.data.action_summary.params.source_map_expectation_mismatch, true);
  assert.equal(
    result.data.action_summary.params.blocked_auto_recovery_reason,
    "liquid_source_change_requires_human_confirmation",
  );
  assert.deepEqual(result.data.action_summary.params.cleanup_required, ["drop_tip:left"]);

  assert.equal(result.data.expected_present_case.fixture.motion, "none");
  assert.equal(result.data.expected_present_case.fixture.network, "none");
  assert.equal(result.data.expected_present_case.classification.error_category, "INSUFFICIENT_VOLUME");
  assert.equal(result.data.expected_present_case.recovery.action, "manual_only");
  assert.equal(result.data.expected_present_case.recovery.auto_executable, false);
  assert.equal(result.data.expected_present_case.action_summary.then_resume, false);
  assert.equal(result.data.expected_present_case.action_summary.params.source_map_key, "D3.A1");
  assert.equal(result.data.expected_present_case.action_summary.params.source_map_expected_presence, true);
  assert.equal(result.data.expected_present_case.action_summary.params.observed_liquid_presence, false);
  assert.equal(result.data.expected_present_case.action_summary.params.source_map_expectation_mismatch, true);
});
