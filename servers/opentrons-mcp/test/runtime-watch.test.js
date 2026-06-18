import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import { TOOL_DEFINITIONS, TOOL_HANDLERS } from "../index.js";
import { readAlerts } from "../lib/runtime-watch/alert-store.js";
import { loadAttemptQueue } from "../lib/runtime-watch/attempt-queue.js";
import { runSentryStep, runtimeWatchPoll } from "../lib/runtime-watch/sentry-step.js";

function tempWatchDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "runtime-watch-"));
}

function failedCommand({
  id = "cmd-failed",
  commandType = "pickUpTip",
  detail = "No Tip Detected",
  errorType = "tipPhysicallyMissing",
} = {}) {
  return {
    id,
    commandType,
    status: "failed",
    params: {
      pipetteId: "pipette-left",
      labwareId: "tiprack-1",
      wellName: "A1",
    },
    error: {
      errorType,
      detail,
    },
  };
}

function snapshot({
  status = "running",
  blockers = [],
  moduleBlockers = [],
  command = null,
} = {}) {
  const commands = command ? [command] : [];
  return {
    runHistoryResult: {
      data: {
        run_id: "run-1",
        status,
        awaiting_recovery: status === "awaiting-recovery",
        latest_failed_command: command
          ? {
              id: command.id,
              command_type: command.commandType,
              status: command.status,
            }
          : null,
      },
      hardwareSnapshot: {
        run: {
          data: {
            id: "run-1",
            status,
            currentlyRecoveringFrom: status === "awaiting-recovery" && command ? command.id : null,
          },
        },
        commands: {
          data: commands,
        },
      },
    },
    robotStatusResult: {
      data: {
        blockers,
        instruments_summary: [{ mount: "left", tip_detected: false }],
      },
      hardwareSnapshot: {},
    },
    moduleStatusResult: {
      data: {
        blockers: moduleBlockers,
      },
      hardwareSnapshot: {},
    },
  };
}

function guidance({
  errorCategory,
  errorLeaf,
  action,
  autoExecutable = true,
  requiresConfirmation = false,
  escalateToHuman = false,
  hardStop = false,
  candidates = [],
  failedCommandId = "cmd-failed",
  diffs = [],
} = {}) {
  return {
    parsedError: {
      error_category: errorCategory,
      error_leaf: errorLeaf,
      hard_stop: hardStop,
      failed_command: {
        id: failedCommandId,
        command_type: "pickUpTip",
        status: "failed",
      },
    },
    recovery: {
      error_category: errorCategory,
      error_leaf: errorLeaf,
      action,
      auto_executable: autoExecutable,
      requires_confirmation: requiresConfirmation,
      escalate_to_human: escalateToHuman,
      hard_stop: hardStop,
      candidate_destination_slots: candidates,
      diffs,
    },
    action_summary: {
      do_what: action,
    },
  };
}

test("runtime watch MCP tools are registered", () => {
  const names = new Set(TOOL_DEFINITIONS.map(tool => tool.name));
  assert.equal(names.has("runtime_watch_poll"), true);
  assert.equal(names.has("runtime_get_alerts"), true);
  assert.equal(names.has("runtime_ack_alert"), true);
  assert.equal(typeof TOOL_HANDLERS.runtime_watch_poll, "function");
  assert.equal(typeof TOOL_HANDLERS.runtime_get_alerts, "function");
  assert.equal(typeof TOOL_HANDLERS.runtime_ack_alert, "function");
});

test("runtime watch fixture 1: normal completion returns completed", async () => {
  const watchDir = tempWatchDir();
  let executeCalls = 0;
  const result = await runSentryStep(
    { run_id: "run-1", watch_dir: watchDir },
    {
      readSnapshot: async () => snapshot({ status: "succeeded" }),
      executeRecovery: async () => {
        executeCalls += 1;
      },
    },
  );

  assert.equal(result.status, "completed");
  assert.equal(executeCalls, 0);
});

test("runtime watch fixture 2: missing tip is L0 autofixed, then watch keeps running", async () => {
  const watchDir = tempWatchDir();
  let executeCalls = 0;
  const command = failedCommand();
  const result = await runSentryStep(
    { run_id: "run-1", watch_dir: watchDir, timeout_ms: 10, poll_interval_ms: 1 },
    {
      readSnapshot: async () => snapshot({ status: "awaiting-recovery", command }),
      readGuidance: async () =>
        guidance({
          errorCategory: "TIP_PHYSICALLY_MISSING",
          errorLeaf: "TIP_PHYSICALLY_MISSING",
          action: "retry_pick_up_tip_with_next_candidate",
        }),
      executeRecovery: async args => {
        executeCalls += 1;
        assert.equal(args.expected_action, "retry_pick_up_tip_with_next_candidate");
        return {
          data: {
            terminal_poll_skipped: true,
            resume_action: { data: { actionType: "resume-from-recovery" } },
            final_run_history: { status: "running" },
            executed_params: { well: "B1", tiprack_slot: "C2" },
          },
        };
      },
    },
  );

  const alerts = readAlerts("run-1", { watchDir });
  assert.equal(result.status, "running");
  assert.equal(result.data.reason, "auto_fix_applied");
  assert.equal(result.data.last_event, "auto_fixed");
  assert.equal(executeCalls, 1);
  assert.equal(alerts[0].type, "auto_fixed");
  assert.equal(alerts[0].status, "auto_fixed");
  assert.deepEqual(alerts[0].data.consumed_tips, [{ tiprack_slot: "C2", well: "B1" }]);
});

test("runtime watch fixture 3: module not ready waits through existing recovery executor", async () => {
  const watchDir = tempWatchDir();
  let executeCalls = 0;
  const command = failedCommand({
    commandType: "aspirate",
    detail: "module is still heating",
    errorType: "ModuleNotReadyError",
  });
  const result = await runSentryStep(
    { run_id: "run-1", watch_dir: watchDir, timeout_ms: 10, poll_interval_ms: 1 },
    {
      readSnapshot: async () =>
        snapshot({
          status: "awaiting-recovery",
          command,
          moduleBlockers: ["module_not_ready:temp-1"],
        }),
      readGuidance: async () =>
        guidance({
          errorCategory: "MODULE_NOT_READY",
          errorLeaf: "MODULE_NOT_READY",
          action: "wait_and_poll_module_status",
        }),
      executeRecovery: async args => {
        executeCalls += 1;
        assert.equal(args.expected_action, "wait_and_poll_module_status");
        return {
          data: {
            terminal_poll_skipped: true,
            resume_action: { data: { actionType: "resume-from-recovery" } },
            final_run_history: { status: "running" },
            executed_params: { blockers_cleared: true },
          },
        };
      },
    },
  );

  assert.equal(result.status, "running");
  assert.equal(result.data.reason, "auto_fix_applied");
  assert.equal(executeCalls, 1);
});

test("runtime watch fixture 3b: reconcile_state_first module blocker branch is L0", async () => {
  const watchDir = tempWatchDir();
  let executeCalls = 0;
  const command = failedCommand({
    commandType: "aspirate",
    detail: "module blocker diff",
    errorType: "ModuleNotReadyError",
  });
  const result = await runSentryStep(
    { run_id: "run-1", watch_dir: watchDir, timeout_ms: 10, poll_interval_ms: 1 },
    {
      readSnapshot: async () =>
        snapshot({
          status: "awaiting-recovery",
          command,
          moduleBlockers: ["module_not_ready:temp-1"],
        }),
      readGuidance: async () =>
        guidance({
          errorCategory: "MODULE_NOT_READY",
          errorLeaf: "MODULE_NOT_READY",
          action: "reconcile_state_first",
          diffs: [{ type: "module_blockers" }],
        }),
      executeRecovery: async args => {
        executeCalls += 1;
        assert.equal(args.expected_action, "reconcile_state_first");
        assert.equal(args.watch_mode, true);
        return {
          data: {
            terminal_poll_skipped: true,
            resume_action: { data: { actionType: "resume-from-recovery" } },
            final_run_history: { status: "running" },
            executed_params: { diffs_resolved: ["module_blockers"] },
          },
        };
      },
    },
  );

  assert.equal(result.status, "running");
  assert.equal(result.data.reason, "auto_fix_applied");
  assert.equal(executeCalls, 1);
});

test("runtime watch fixture 4: destination occupied asks user and does not execute", async () => {
  const watchDir = tempWatchDir();
  let executeCalls = 0;
  const command = failedCommand({
    commandType: "moveLabware",
    detail: "LocationIsOccupiedError: destination occupied",
    errorType: "LocationIsOccupiedError",
  });
  const result = await runSentryStep(
    { run_id: "run-1", watch_dir: watchDir },
    {
      readSnapshot: async () => snapshot({ status: "awaiting-recovery", command }),
      readGuidance: async () =>
        guidance({
          errorCategory: "DESTINATION_OCCUPIED",
          errorLeaf: "DESTINATION_OCCUPIED",
          action: "suggest_new_destination_slot",
          autoExecutable: true,
          requiresConfirmation: true,
          escalateToHuman: true,
          candidates: [{ slot_name: "B2" }, { slot_name: "D3" }],
        }),
      executeRecovery: async () => {
        executeCalls += 1;
      },
    },
  );

  const alerts = readAlerts("run-1", { watchDir });
  assert.equal(result.status, "needs_user");
  assert.equal(executeCalls, 0);
  assert.match(alerts[0].message, /B2.*D3/);
});

test("runtime watch fixture 5: estop or door is hard stop and does not execute", async () => {
  const watchDir = tempWatchDir();
  let executeCalls = 0;
  const result = await runSentryStep(
    { run_id: "run-1", watch_dir: watchDir },
    {
      readSnapshot: async () => snapshot({ status: "awaiting-recovery", blockers: ["estop_engaged"] }),
      executeRecovery: async () => {
        executeCalls += 1;
      },
    },
  );

  assert.equal(result.status, "hard_stop");
  assert.equal(executeCalls, 0);
});

test("runtime watch fixture 6: fourth retry escalates through attempt queue", async () => {
  const watchDir = tempWatchDir();
  const queue = loadAttemptQueue("run-1", { watchDir });
  for (let index = 0; index < 3; index += 1) {
    const attempt = queue.beginAttempt({
      failedCommandId: "cmd-failed",
      errorLeaf: "TIP_PHYSICALLY_MISSING",
      branch: "retry_pick_up_tip_with_next_candidate",
    });
    queue.finishAttempt(attempt.attempt_id, { status: "failed", result: { index } });
  }

  let executeCalls = 0;
  const result = await runSentryStep(
    { run_id: "run-1", watch_dir: watchDir },
    {
      readSnapshot: async () => snapshot({ status: "awaiting-recovery", command: failedCommand() }),
      readGuidance: async () =>
        guidance({
          errorCategory: "TIP_PHYSICALLY_MISSING",
          errorLeaf: "TIP_PHYSICALLY_MISSING",
          action: "retry_pick_up_tip_with_next_candidate",
        }),
      executeRecovery: async () => {
        executeCalls += 1;
      },
    },
  );

  assert.equal(result.status, "needs_user");
  assert.equal(executeCalls, 0);
  assert.match(result.data.reason, /retry budget exhausted/);
});

test("runtime watch fixture 7: repeated network failure is unreachable and never executes", async () => {
  const watchDir = tempWatchDir();
  let executeCalls = 0;
  const first = await runSentryStep(
    { run_id: "run-1", watch_dir: watchDir },
    {
      readSnapshot: async () => {
        throw new Error("Network request failed");
      },
      executeRecovery: async () => {
        executeCalls += 1;
      },
    },
  );
  const second = await runSentryStep(
    { run_id: "run-1", watch_dir: watchDir },
    {
      readSnapshot: async () => {
        throw new Error("Network request failed");
      },
      executeRecovery: async () => {
        executeCalls += 1;
      },
    },
  );

  assert.equal(first.status, "running");
  assert.equal(first.data.reason, "snapshot_unreachable_retrying");
  assert.equal(second.status, "unreachable");
  assert.equal(executeCalls, 0);
});

test("runtimeWatchPoll keeps polling after watch-mode autofix instead of returning needs_user", async () => {
  const watchDir = tempWatchDir();
  let executeCalls = 0;
  let snapshotReads = 0;
  const command = failedCommand();
  const result = await runtimeWatchPoll(
    {
      run_id: "run-1",
      watch_dir: watchDir,
      max_block_ms: 650,
      poll_interval_ms: 250,
      timeout_ms: 50,
    },
    {
      readSnapshot: async () => {
        snapshotReads += 1;
        return snapshotReads === 1
          ? snapshot({ status: "awaiting-recovery", command })
          : snapshot({ status: "running" });
      },
      readGuidance: async () =>
        guidance({
          errorCategory: "TIP_PHYSICALLY_MISSING",
          errorLeaf: "TIP_PHYSICALLY_MISSING",
          action: "retry_pick_up_tip_with_next_candidate",
        }),
      executeRecovery: async args => {
        executeCalls += 1;
        assert.equal(args.watch_mode, true);
        return {
          data: {
            terminal_poll_skipped: true,
            resume_action: { data: { actionType: "resume-from-recovery" } },
            final_run_history: { status: "running" },
            executed_params: { well: "B1", tiprack_slot: "C2" },
          },
        };
      },
    },
  );

  const alerts = readAlerts("run-1", { watchDir });
  assert.equal(result.status, "running");
  assert.equal(executeCalls, 1);
  assert.ok(snapshotReads >= 2);
  assert.equal(alerts.some(alert => alert.type === "auto_fixed"), true);
});
