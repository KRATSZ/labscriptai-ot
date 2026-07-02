import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "url";

import {
  buildContinuationPrompt,
  buildWakePayload,
  consumeOnce,
  emitHookResponse,
  emitPollResponse,
  isWakeEvent,
  parseArgs,
  pickLatestActionable,
  readAdapterMailbox,
  unwrapAdapterEnvelope,
} from "../../../scripts/consume-runtime-outbox.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CONSUME_SCRIPT = path.join(REPO_ROOT, "scripts/consume-runtime-outbox.mjs");

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "consume-outbox-"));
}

function appendAdapterLine(adapterDir, host, sessionId, event) {
  const filePath = path.join(adapterDir, host, `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(
    filePath,
    `${JSON.stringify({
      delivered_at: new Date().toISOString(),
      adapter: host,
      event,
    })}\n`,
  );
  return filePath;
}

test("isWakeEvent filters heartbeat and accepts wake:true", () => {
  assert.equal(isWakeEvent({ wake: true, kind: "heartbeat" }, true), true);
  assert.equal(isWakeEvent({ wake: false, kind: "needs_user" }, true), false);
  assert.equal(isWakeEvent({ kind: "heartbeat" }, true), false);
  assert.equal(isWakeEvent({ kind: "needs_user", requires_attention: true }, true), true);
});

test("pickLatestActionable prefers newest unacked wake event", () => {
  const events = [
    { outbox_id: "a", created_at: "2026-07-01T10:00:00Z", wake: true, kind: "needs_user" },
    { outbox_id: "b", created_at: "2026-07-01T11:00:00Z", wake: true, kind: "blocked" },
  ];
  const picked = pickLatestActionable(events, {
    runId: null,
    wakeOnly: true,
    consumerState: { acked_outbox_ids: [] },
  });
  assert.equal(picked.outbox_id, "b");
});

test("buildContinuationPrompt includes GOAL_STATUS hint", () => {
  const prompt = buildContinuationPrompt(
    {
      outbox_id: "evt-1",
      session_id: "sess-a",
      run_id: "run-1",
      kind: "needs_user",
      wake: true,
      message: "operator required",
      recommended_next_tool: "runtime_get_alerts",
    },
    "claudecode",
  );
  assert.match(prompt, /GOAL_STATUS: BLOCKED/);
  assert.match(prompt, /GOAL_REASON:/);
  assert.match(prompt, /opentrons-experiment-goal/);
  assert.match(prompt, /notify_adapters=\["claudecode"\]/);
});

test("consumeOnce reads adapter mailbox and builds continuation", async () => {
  const root = tempRoot();
  const adapterDir = path.join(root, "host-adapters");
  const sessionId = "test-session";

  appendAdapterLine(adapterDir, "cursor", sessionId, {
    outbox_id: "wake-1",
    session_id: sessionId,
    run_id: "run-x",
    kind: "needs_user",
    wake: true,
    severity: "warn",
    message: "test wake",
    recommended_next_tool: "runtime_get_alerts",
    no_robot_motion: true,
    created_at: "2026-07-01T12:00:00Z",
  });

  const result = await consumeOnce({
    host: "cursor",
    session_id: sessionId,
    source: "adapter",
    wake_only: true,
    ack: false,
    host_adapter_dir: adapterDir,
    outbox_dir: path.join(root, "runtime-outbox"),
    limit: 5,
  });

  assert.ok(result.event);
  assert.equal(result.event.outbox_id, "wake-1");
  assert.match(result.continuation, /GOAL_STATUS:/);
});

test("readAdapterMailbox unwraps adapter envelope rows", () => {
  const root = tempRoot();
  const adapterDir = path.join(root, "host-adapters");
  const sessionId = "unwrap-test";
  appendAdapterLine(adapterDir, "codex", sessionId, {
    outbox_id: "e1",
    wake: true,
    kind: "blocked",
    created_at: "2026-07-01T12:00:00Z",
  });

  const { events } = readAdapterMailbox({
    sessionId,
    host: "codex",
    hostAdapterDir: adapterDir,
    consumerState: { adapter_offset: 0 },
  });
  assert.equal(events.length, 1);
  assert.equal(unwrapAdapterEnvelope({ event: events[0] }).outbox_id, "e1");
});

test("emitHookResponse formats Claude Stop block JSON", () => {
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = chunk => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    emitHookResponse({
      host: "claudecode",
      hookEvent: "stop",
      continuation: "GOAL_STATUS: CONTINUE",
      event: { outbox_id: "x" },
    });
  } finally {
    process.stdout.write = original;
  }
  const payload = JSON.parse(chunks.join(""));
  assert.equal(payload.decision, "block");
  assert.match(payload.reason, /GOAL_STATUS/);
  assert.equal(payload.hookSpecificOutput.hookEventName, "Stop");
});

test("emitHookResponse formats Cursor followup_message", () => {
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = chunk => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    emitHookResponse({
      host: "cursor",
      hookEvent: "stop",
      continuation: "wake prompt",
      event: { outbox_id: "y" },
    });
  } finally {
    process.stdout.write = original;
  }
  const payload = JSON.parse(chunks.join(""));
  assert.equal(payload.followup_message, "wake prompt");
});

test("CLI smoke: poll-once with no mailbox does not crash", () => {
  const root = tempRoot();
  const result = spawnSync(
    process.execPath,
    [CONSUME_SCRIPT, "--poll-once", "--host", "cursor", "--session-id", "smoke-empty"],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PLUGIN_DATA: root,
        OPENTRONS_PLUGIN_ROOT: REPO_ROOT,
      },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0);
  assert.match(result.stdout, /NO_WAKE/);
});

test("CLI smoke: piagent poll-once with no mailbox exits 2", () => {
  const root = tempRoot();
  const result = spawnSync(
    process.execPath,
    [CONSUME_SCRIPT, "--poll-once", "--host", "piagent", "--session-id", "smoke-pi"],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PLUGIN_DATA: root,
        OPENTRONS_PLUGIN_ROOT: REPO_ROOT,
      },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 2);
  assert.match(result.stdout, /NO_WAKE/);
});

test("CLI smoke: piagent poll-once returns continuation text on wake", () => {
  const root = tempRoot();
  const adapterDir = path.join(root, "host-adapters");
  appendAdapterLine(adapterDir, "piagent", "smoke-pi-wake", {
    outbox_id: "pi-smoke-1",
    session_id: "smoke-pi-wake",
    kind: "needs_user",
    wake: true,
    message: "pi wake",
    created_at: "2026-07-01T12:00:00Z",
  });

  const result = spawnSync(
    process.execPath,
    [
      CONSUME_SCRIPT,
      "--poll-once",
      "--host",
      "piagent",
      "--no-ack",
      "--source",
      "adapter",
      "--session-id",
      "smoke-pi-wake",
      "--host-adapter-dir",
      adapterDir,
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PLUGIN_DATA: root,
        OPENTRONS_PLUGIN_ROOT: REPO_ROOT,
      },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0);
  assert.match(result.stdout, /GOAL_STATUS/);
  assert.match(result.stdout, /LabscriptAI OT Goal Wake/);
});

test("emitPollResponse formats opencode-prompt JSON payload", () => {
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = chunk => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    emitPollResponse({
      host: "opencode",
      format: "opencode-prompt",
      continuation: "wake prompt",
      event: {
        outbox_id: "oc-1",
        session_id: "s1",
        kind: "blocked",
        no_robot_motion: true,
      },
    });
  } finally {
    process.stdout.write = original;
  }
  const payload = JSON.parse(chunks.join(""));
  assert.equal(payload.action, "wake");
  assert.equal(payload.adapter, "opencode");
  assert.equal(payload.prompt, "wake prompt");
});

test("CLI smoke: hook stop with synthetic wake returns followup_message", () => {
  const root = tempRoot();
  const adapterDir = path.join(root, "host-adapters");
  appendAdapterLine(adapterDir, "cursor", "smoke-wake", {
    outbox_id: "smoke-1",
    session_id: "smoke-wake",
    kind: "needs_user",
    wake: true,
    message: "smoke",
    created_at: "2026-07-01T12:00:00Z",
  });

  const result = spawnSync(
    process.execPath,
    [
      CONSUME_SCRIPT,
      "--host",
      "cursor",
      "--hook",
      "stop",
      "--no-ack",
      "--source",
      "adapter",
      "--session-id",
      "smoke-wake",
      "--host-adapter-dir",
      adapterDir,
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PLUGIN_DATA: root,
        OPENTRONS_PLUGIN_ROOT: REPO_ROOT,
      },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.ok(payload.followup_message);
  assert.match(payload.followup_message, /GOAL_STATUS/);
});

test("parseArgs accepts host and hook-event", () => {
  const args = parseArgs(["--host", "codex", "--hook-event", "Stop", "--session-id", "s1"]);
  assert.equal(args.host, "codex");
});

test("parseArgs accepts piagent and opencode hosts", () => {
  assert.equal(parseArgs(["--host", "piagent"]).host, "piagent");
  assert.equal(parseArgs(["--adapter", "opencode"]).host, "opencode");
});
