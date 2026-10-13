import test from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "fs";

const ENTRY_SKILL = "opentrons-experiment-run";

// Single source of truth: shared with scripts/deepseek-agent-harness.mjs.
const SCENARIO_SPECS = JSON.parse(
  readFileSync(new URL("./fixtures/agent-scenarios.json", import.meta.url), "utf8"),
);


function makeScenario(spec) {
  return {
    id: spec.id,
    category: spec.category,
    difficulty: spec.difficulty,
    prompt: spec.prompt,
    expected_entry_skill: ENTRY_SKILL,
    expected_route: [ENTRY_SKILL, ...spec.route_tail],
    route_note: spec.route_note,
    ...(spec.expected_tools !== undefined ? { expected_tools: spec.expected_tools } : {}),
    ...(spec.must_not_do !== undefined ? { must_not_do: spec.must_not_do } : {}),
  };
}

export const AGENT_SCENARIOS = SCENARIO_SPECS.map(makeScenario);

const CANONICAL_SKILLS = new Set([
  ENTRY_SKILL,
  "opentrons-experiment-intent-review",
  "opentrons-protocol-author",
  "opentrons-protocol-verify",
  "opentrons-simulation-repair",
  "opentrons-robot-lan",
]);

const REQUIRED_CATEGORIES = new Set([
  "e2e",
  "intent",
  "verify",
  "repair",
  "recovery",
  "safety",
  "hard-stop",
  "fallback",
  "experimental",
]);

function isStringArray(value) {
  return Array.isArray(value) && value.every(item => typeof item === "string" && item.trim().length > 0);
}

test("agent scenario bank stays within the 10-20 target", () => {
  assert.ok(
    AGENT_SCENARIOS.length >= 10,
    `expected at least 10 scenarios, got ${AGENT_SCENARIOS.length}`,
  );
  assert.ok(
    AGENT_SCENARIOS.length <= 20,
    `expected at most 20 scenarios, got ${AGENT_SCENARIOS.length}`,
  );
});

test("agent scenario bank is structurally consistent", () => {
  const ids = new Set();
  const prompts = new Set();
  const seenSkills = new Set();
  const seenCategories = new Set();

  for (const scenario of AGENT_SCENARIOS) {
    assert.match(scenario.id, /^[a-z0-9-]+$/);
    assert.ok(!ids.has(scenario.id), `duplicate scenario id: ${scenario.id}`);
    ids.add(scenario.id);

    assert.ok(typeof scenario.prompt === "string" && scenario.prompt.trim().length >= 20, scenario.id);
    assert.ok(typeof scenario.route_note === "string" && scenario.route_note.trim().length > 0, scenario.id);
    assert.ok(Number.isInteger(scenario.difficulty) && scenario.difficulty >= 1 && scenario.difficulty <= 5, scenario.id);
    assert.ok(typeof scenario.expected_entry_skill === "string" && scenario.expected_entry_skill.length > 0, scenario.id);
    assert.ok(Array.isArray(scenario.expected_route) && scenario.expected_route.length >= 1, scenario.id);
    assert.ok(scenario.expected_route.length <= 5, `${scenario.id} route should stay compact`);
    assert.equal(
      scenario.expected_route[0],
      scenario.expected_entry_skill,
      `${scenario.id} must start with its declared entry skill`,
    );
    assert.ok(CANONICAL_SKILLS.has(scenario.expected_entry_skill), `${scenario.id} has unknown entry skill`);

    for (const skill of scenario.expected_route) {
      assert.ok(CANONICAL_SKILLS.has(skill), `${scenario.id} uses non-canonical route step ${skill}`);
      seenSkills.add(skill);
    }

    if (scenario.expected_tools !== undefined) {
      assert.ok(isStringArray(scenario.expected_tools), `${scenario.id} expected_tools must be string[]`);
    }

    if (scenario.must_not_do !== undefined) {
      assert.ok(isStringArray(scenario.must_not_do), `${scenario.id} must_not_do must be string[]`);
    }

    assert.ok(!prompts.has(scenario.prompt), `duplicate prompt found for ${scenario.id}`);
    prompts.add(scenario.prompt);
    seenCategories.add(scenario.category);
  }

  for (const category of REQUIRED_CATEGORIES) {
    assert.ok(seenCategories.has(category), `missing scenario category coverage for ${category}`);
  }

  for (const skill of CANONICAL_SKILLS) {
    assert.ok(seenSkills.has(skill), `missing route coverage for ${skill}`);
  }
});
