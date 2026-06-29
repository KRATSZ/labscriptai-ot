import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import { runtimeWatchLoop } from "../lib/runtime-watch/watch-loop.js";
import { readRuntimeOutbox } from "../lib/runtime-outbox.js";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "runtime-watch-loop-"));
}

function makeFakePoll(sequence) {
  let index = 0;
  return async () => {
    const entry = sequence[Math.min(index, sequence.length - 1)];
    index += 1;
    return entry;
  };
}

function tick(status, reason = null, extra = {}) {
  return {
    status,
    data: { reason, run_status: status === "running" ? "running" : status, ...extra },
  };
}

test("runtime_watch_loop polls until completed and emits one outbox sentinel per tick", async () => {
  const watchDir = tempDir();
  const outboxDir = tempDir();
  const poll = makeFakePoll([tick("running"), tick("running"), tick("completed", "run_succeeded")]);

  const result = await runtimeWatchLoop(
    {
      run_id: "run-loop-complete",
      session_id: "loop-complete",
      watch_dir: watchDir,
      outbox_dir: outboxDir,
      max_turns: 10,
      max_runtime_ms: 60000,
      interval_ms: 1,
    },
    { runtimeWatchPoll: poll, sleep: () => Promise.resolve() },
  );

  assert.equal(result.status, "complete");
  assert.equal(result.goal_status, "COMPLETE");
  assert.equal(result.turns_completed, 3);
  assert.equal(result.final_status, "completed");

  const events = readRuntimeOutbox({ sessionId: "loop-complete", outboxDir, includeAcked: true, limit: 50 });
  assert.equal(events.length, 3);
  assert.ok(events.every(event => event.source === "runtime_watch_loop"));
  assert.ok(events.every(event => event.type === "runtime_watch_loop_tick"));
  // readRuntimeOutbox returns newest-first by created_at; assert per-turn order explicitly to avoid ms-tie flakiness.
  const byTurn = [...events].sort((a, b) => (a.data?.turn || 0) - (b.data?.turn || 0));
  const statuses = byTurn.map(event => event.status);
  assert.deepEqual(statuses, ["running", "running", "completed"]);

  const goalState = JSON.parse(fs.readFileSync(path.join(watchDir, "run-loop-complete", "goal-state.json"), "utf8"));
  assert.equal(goalState.status, "complete");
  assert.equal(goalState.turns_completed, 3);
});

test("runtime_watch_loop stops and blocks on needs_user", async () => {
  const watchDir = tempDir();
  const outboxDir = tempDir();
  const poll = makeFakePoll([tick("running"), tick("needs_user", "manual_confirmation_required")]);

  const result = await runtimeWatchLoop(
    {
      run_id: "run-loop-blocked",
      session_id: "loop-blocked",
      watch_dir: watchDir,
      outbox_dir: outboxDir,
      max_turns: 10,
      max_runtime_ms: 60000,
      interval_ms: 1,
    },
    { runtimeWatchPoll: poll, sleep: () => Promise.resolve() },
  );

  assert.equal(result.status, "blocked");
  assert.equal(result.goal_status, "BLOCKED");
  assert.equal(result.turns_completed, 2);
  assert.equal(result.final_status, "needs_user");

  const events = readRuntimeOutbox({ sessionId: "loop-blocked", outboxDir, includeAcked: true, limit: 50 });
  const blockedEvent = events.find(event => event.status === "needs_user");
  assert.ok(blockedEvent);
  assert.equal(blockedEvent.requires_attention, true);
  assert.equal(blockedEvent.recommended_next_tool, "runtime_get_alerts");
});

test("runtime_watch_loop hard_stop blocks and never retries", async () => {
  const watchDir = tempDir();
  const outboxDir = tempDir();
  let calls = 0;
  const poll = async () => {
    calls += 1;
    return tick("hard_stop", "deck_collision");
  };

  const result = await runtimeWatchLoop(
    {
      run_id: "run-loop-hardstop",
      session_id: "loop-hardstop",
      watch_dir: watchDir,
      outbox_dir: outboxDir,
      max_turns: 10,
      interval_ms: 1,
    },
    { runtimeWatchPoll: poll, sleep: () => Promise.resolve() },
  );

  assert.equal(result.status, "blocked");
  assert.equal(result.final_status, "hard_stop");
  assert.equal(calls, 1);
});

test("runtime_watch_loop returns budget_limited when max_turns is reached while still running", async () => {
  const watchDir = tempDir();
  const outboxDir = tempDir();
  const poll = makeFakePoll([tick("running")]);

  const result = await runtimeWatchLoop(
    {
      run_id: "run-loop-budget",
      session_id: "loop-budget",
      watch_dir: watchDir,
      outbox_dir: outboxDir,
      max_turns: 3,
      max_runtime_ms: 60000,
      interval_ms: 1,
    },
    { runtimeWatchPoll: poll, sleep: () => Promise.resolve() },
  );

  assert.equal(result.status, "budget_limited");
  assert.equal(result.goal_status, "BUDGET_LIMITED");
  assert.equal(result.turns_completed, 3);
  assert.equal(result.final_reason, "max_turns_reached");
});

test("runtime_watch_loop COMPLETE fires as soon as the verify callback passes", async () => {
  const watchDir = tempDir();
  const outboxDir = tempDir();
  const poll = makeFakePoll([tick("running", null, { last_event: "auto_fixed" }), tick("running")]);

  const result = await runtimeWatchLoop(
    {
      run_id: "run-loop-verify",
      session_id: "loop-verify",
      watch_dir: watchDir,
      outbox_dir: outboxDir,
      max_turns: 10,
      interval_ms: 1,
    },
    {
      runtimeWatchPoll: poll,
      sleep: () => Promise.resolve(),
      verify: tickResult => tickResult?.data?.last_event === "auto_fixed",
    },
  );

  assert.equal(result.status, "complete");
  assert.equal(result.turns_completed, 1);
  assert.equal(result.final_reason, "verify_passed");
});

test("runtime_watch_loop resume continues an active goal's turn count", async () => {
  const watchDir = tempDir();
  const outboxDir = tempDir();
  const firstPoll = makeFakePoll([tick("running"), tick("running")]);

  const first = await runtimeWatchLoop(
    {
      run_id: "run-loop-resume",
      session_id: "loop-resume",
      watch_dir: watchDir,
      outbox_dir: outboxDir,
      max_turns: 2,
      interval_ms: 1,
    },
    { runtimeWatchPoll: firstPoll, sleep: () => Promise.resolve() },
  );
  assert.equal(first.status, "budget_limited");
  assert.equal(first.turns_completed, 2);

  const resumePoll = makeFakePoll([tick("running"), tick("completed", "run_succeeded")]);
  const resumed = await runtimeWatchLoop(
    {
      run_id: "run-loop-resume",
      session_id: "loop-resume",
      watch_dir: watchDir,
      outbox_dir: outboxDir,
      max_turns: 4,
      interval_ms: 1,
      resume: true,
      goal_id: first.goal_id,
    },
    { runtimeWatchPoll: resumePoll, sleep: () => Promise.resolve() },
  );

  assert.equal(resumed.status, "complete");
  assert.equal(resumed.goal_id, first.goal_id);
  assert.equal(resumed.turns_completed, 4);
});

test("runtime_watch_loop is registered as a required MCP tool", async () => {
  const { TOOL_HANDLERS } = await import("../index.js");
  assert.equal(typeof TOOL_HANDLERS.runtime_watch_loop, "function");
});
