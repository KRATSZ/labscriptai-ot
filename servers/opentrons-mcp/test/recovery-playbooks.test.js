import test from "node:test";
import assert from "node:assert/strict";

import { TOOL_DEFINITIONS, TOOL_HANDLERS } from "../index.js";
import {
  getRecoveryPlaybook,
  listRecoveryPlaybooks,
} from "../lib/recovery-playbooks.js";

test("recovery playbook registry exposes fixed recovery contracts", () => {
  const tip = getRecoveryPlaybook("retry_pick_up_tip_with_next_candidate");
  const liquid = getRecoveryPlaybook("liquid_source_substitution_continuation_protocol");

  assert.equal(tip.allowed_watch_mode, true);
  assert.equal(tip.executor_tool, "execute_protocol_recovery");
  assert.equal(liquid.allowed_watch_mode, false);
  assert.equal(liquid.can_move_robot, false);
  assert.equal(liquid.requires_operator_opt_in, true);
  assert.ok(liquid.required_gates.includes("live_liquid_recovery_gate"));
  assert.ok(liquid.semantic_invariants.includes("liquid_name_unchanged"));
});

test("list_recovery_playbooks MCP tool is read-only and filterable", async () => {
  const names = new Set(TOOL_DEFINITIONS.map(tool => tool.name));
  assert.equal(names.has("list_recovery_playbooks"), true);

  const all = await TOOL_HANDLERS.list_recovery_playbooks({});
  const noMotion = await TOOL_HANDLERS.list_recovery_playbooks({ include_motion: false });

  assert.equal(all.data.no_robot_motion, true);
  assert.ok(all.data.playbook_count >= noMotion.data.playbook_count);
  assert.equal(
    noMotion.data.playbooks.some(playbook => playbook.can_move_robot === true),
    false,
  );
  assert.equal(
    listRecoveryPlaybooks({ includeMotion: false }).some(playbook => playbook.can_move_robot === true),
    false,
  );
});
