import test from "node:test";
import assert from "node:assert/strict";

import { TOOL_DEFINITIONS, TOOL_HANDLERS } from "../index.js";
import { runRuntimeRecoveryMonitor } from "../lib/runtime-monitor.js";

function baseDependencies(overrides = {}) {
  return {
    runtimeRecoverySelfTest: async () => ({
      data: {
        status: "pass",
        runtime_build: "liquid-source-map-v2",
      },
    }),
    healthCheck: async () => ({
      data: {
        mcp_server: {
          required_runtime_tools: {
            all_present: true,
          },
        },
      },
    }),
    readRobotStatus: async () => ({
      data: {
        blockers: [],
      },
    }),
    readModuleStatus: async () => ({
      data: {
        blockers: [],
      },
    }),
    readRunHistory: async () => ({
      data: {
        run_id: "run-1",
        status: "running",
      },
    }),
    readRunFailureGuidance: async () => ({
      parsedError: {
        error_category: "TIP_PHYSICALLY_MISSING",
        error_leaf: "TIP_PHYSICALLY_MISSING",
      },
      recovery: {
        action: "retry_pick_up_tip_with_next_candidate",
        auto_executable: true,
      },
    }),
    safeNextAction: async () => ({
      data: {
        safe_next_action: {
          recommended_next_tool: "robot_status",
          latest_liquid_source_substitution_recovery: null,
        },
      },
    }),
    liveLiquidRecoveryGate: async () => ({
      data: {
        status: "pass",
        ok_for_live_liquid_rerun: true,
      },
    }),
    runtimeWatchPoll: async () => ({
      data: {
        status: "running",
        last_event: null,
      },
    }),
    ...overrides,
  };
}

test("runtime recovery monitor MCP tool is registered", () => {
  const names = new Set(TOOL_DEFINITIONS.map(tool => tool.name));
  assert.equal(names.has("runtime_recovery_monitor"), true);
  assert.equal(typeof TOOL_HANDLERS.runtime_recovery_monitor, "function");
});

test("runtime recovery monitor handler reads loaded self-test status without false failure", async () => {
  const result = await TOOL_HANDLERS.runtime_recovery_monitor({
    session_id: "monitor-handler-selftest",
    levels: ["L1"],
  });

  const selfTest = result.data.levels.L1.checks.find(check => check.name === "runtime_recovery_self_test");
  assert.equal(selfTest.status, "pass");
  assert.equal(selfTest.runtime_build, "liquid-source-map-v2");
});

test("L1 heartbeat passes with current runtime and clear robot/module status", async () => {
  const result = await runRuntimeRecoveryMonitor(
    {
      robot_ip: "10.31.2.149",
      session_id: "monitor-l1",
      levels: ["L1"],
    },
    baseDependencies(),
  );

  assert.equal(result.status, "ok");
  assert.equal(result.levels.L1.status, "pass");
  assert.equal(result.requires_attention, false);
});

test("L2 observe mode reports awaiting-recovery without executing self-fix", async () => {
  let watchCalls = 0;
  const result = await runRuntimeRecoveryMonitor(
    {
      robot_ip: "10.31.2.149",
      session_id: "monitor-l2",
      run_id: "run-1",
      levels: ["L2"],
    },
    baseDependencies({
      readRunHistory: async () => ({
        data: {
          run_id: "run-1",
          status: "awaiting-recovery",
        },
      }),
      runtimeWatchPoll: async () => {
        watchCalls += 1;
        return { data: { status: "running" } };
      },
    }),
  );

  assert.equal(result.status, "needs_attention");
  assert.equal(result.levels.L2.mode, "observe");
  assert.equal(result.levels.L2.status, "needs_attention");
  assert.equal(watchCalls, 0);
  assert.equal(result.notifications[0].type, "run_needs_attention");
});

test("L3 falls back to local safe_next_action when L1 says robot API is unreachable", async () => {
  let safeNextArgs = null;
  let liquidGateCalls = 0;
  const result = await runRuntimeRecoveryMonitor(
    {
      robot_ip: "10.31.2.149",
      session_id: "monitor-l3-network-blocked",
      levels: ["L1", "L3"],
      source_plan: "c3_d3_liquid_recovery",
      enable_liquid_gate: true,
    },
    baseDependencies({
      readRobotStatus: async () => {
        throw new Error("ECONNREFUSED");
      },
      readModuleStatus: async () => {
        throw new Error("ECONNREFUSED");
      },
      safeNextAction: async args => {
        safeNextArgs = args;
        return {
          data: {
            safe_next_action: {
              recommended_next_tool: "robot_status",
              latest_liquid_source_substitution_recovery: null,
            },
          },
        };
      },
      liveLiquidRecoveryGate: async () => {
        liquidGateCalls += 1;
        return { data: { status: "pass", ok_for_live_liquid_rerun: true } };
      },
    }),
  );

  assert.equal(result.status, "blocked");
  assert.equal(safeNextArgs.robot_ip, undefined);
  assert.equal(liquidGateCalls, 0);
  assert.equal(
    result.notifications.some(notification => notification.type === "robot_unreachable"),
    true,
  );
  assert.equal(
    result.notifications.some(notification => notification.type === "safe_next_unavailable"),
    false,
  );
  assert.equal(
    result.notifications.some(notification => notification.type === "liquid_gate_unavailable"),
    false,
  );
});

test("L4 blocks execution by default", async () => {
  const result = await runRuntimeRecoveryMonitor(
    {
      session_id: "monitor-l4",
      levels: ["L4"],
    },
    baseDependencies(),
  );

  assert.equal(result.status, "blocked");
  assert.equal(result.levels.L4.status, "blocked");
  assert.ok(result.levels.L4.blockers.includes("self_fix_mode_is_observe"));
  assert.ok(result.levels.L4.blockers.includes("allow_l4_execution_false"));
  assert.equal(result.levels.L4.executed, false);
});

test("L0 self-fix mode does not call runtime_watch_poll before gates are open", async () => {
  let watchCalls = 0;
  const result = await runRuntimeRecoveryMonitor(
    {
      robot_ip: "10.31.2.149",
      session_id: "monitor-l0-blocked",
      run_id: "run-1",
      levels: ["L2", "L4"],
      self_fix_mode: "l0",
      allow_l4_execution: false,
      operator_opt_in: false,
    },
    baseDependencies({
      runtimeWatchPoll: async () => {
        watchCalls += 1;
        return { data: { status: "running", last_event: "auto_fixed" } };
      },
    }),
  );

  assert.equal(watchCalls, 0);
  assert.equal(result.status, "blocked");
  assert.equal(result.levels.L2.mode, "l0_self_fix_blocked_before_watch");
  assert.equal(result.levels.L2.no_robot_motion, true);
  assert.equal(result.acceptance.metrics.unapproved_motion_count, 0);
  assert.equal(result.acceptance.metrics.l0_auto_fix_count, 0);
  assert.equal(
    result.notifications.some(notification => notification.type === "l0_self_fix_gate_blocked"),
    true,
  );
});

test("L4 records whitelisted L0 self-fix when explicitly enabled through runtime_watch_poll", async () => {
  const result = await runRuntimeRecoveryMonitor(
    {
      robot_ip: "10.31.2.149",
      session_id: "monitor-l4-l0",
      run_id: "run-1",
      levels: ["L2", "L4"],
      self_fix_mode: "l0",
      allow_l4_execution: true,
      operator_opt_in: true,
    },
    baseDependencies({
      runtimeWatchPoll: async () => ({
        data: {
          status: "running",
          last_event: "auto_fixed",
        },
      }),
    }),
  );

  assert.equal(result.status, "self_fixed");
  assert.equal(result.levels.L2.mode, "l0_self_fix");
  assert.equal(result.levels.L4.status, "executed_l0_self_fix");
  assert.equal(result.levels.L4.executed, true);
  assert.equal(result.acceptance.metrics.l0_auto_fix_count, 1);
  assert.equal(result.acceptance.metrics.unapproved_motion_count, 0);
  assert.equal(
    result.notifications.some(notification => notification.type === "guarded_l0_execution_applied"),
    true,
  );
});
