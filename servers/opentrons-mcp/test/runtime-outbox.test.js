import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import { TOOL_DEFINITIONS, TOOL_HANDLERS } from "../index.js";
import { runRuntimeRecoveryMonitor } from "../lib/runtime-monitor.js";
import { readAlerts } from "../lib/runtime-watch/alert-store.js";
import {
  ackRuntimeOutboxEvent,
  deliverRuntimeOutbox,
  publishMonitorNotifications,
  readRuntimeOutbox,
} from "../lib/runtime-outbox.js";

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "runtime-outbox-"));
}

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
        status: "awaiting-recovery",
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

test("runtime outbox tools are registered", () => {
  const names = new Set(TOOL_DEFINITIONS.map(tool => tool.name));
  assert.equal(names.has("runtime_get_outbox"), true);
  assert.equal(names.has("runtime_ack_outbox"), true);
  assert.equal(names.has("runtime_deliver_outbox"), true);
  assert.equal(typeof TOOL_HANDLERS.runtime_get_outbox, "function");
  assert.equal(typeof TOOL_HANDLERS.runtime_ack_outbox, "function");
  assert.equal(typeof TOOL_HANDLERS.runtime_deliver_outbox, "function");
});

test("monitor notifications publish once into alerts and outbox", async () => {
  const root = tempRoot();
  const watchDir = path.join(root, "watch");
  const outboxDir = path.join(root, "outbox");
  const monitor = await runRuntimeRecoveryMonitor(
    {
      robot_ip: "10.0.0.2",
      session_id: "outbox-session",
      run_id: "run-1",
      levels: ["L2"],
    },
    baseDependencies(),
  );

  const first = publishMonitorNotifications({ monitor, watchDir, outboxDir });
  const second = publishMonitorNotifications({ monitor, watchDir, outboxDir });
  const alerts = readAlerts("run-1", { watchDir, includeAcked: false });
  const events = readRuntimeOutbox({ sessionId: "outbox-session", outboxDir });

  assert.equal(first.status, "published");
  assert.equal(second.status, "published");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, "monitor_run_needs_attention");
  assert.equal(alerts[0].data.no_robot_motion, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "run_needs_attention");
  assert.equal(events[0].requires_attention, true);
  assert.equal(events[0].recommended_next_tool, "safe_next_action");
});

test("monitor publication emits resolved event when robot API becomes reachable", async () => {
  const root = tempRoot();
  const outboxDir = path.join(root, "outbox");

  const unreachable = await runRuntimeRecoveryMonitor(
    {
      robot_ip: "10.0.0.2",
      session_id: "reachable-session",
      levels: ["L1"],
    },
    baseDependencies({
      readRobotStatus: async () => {
        throw new Error("ECONNREFUSED");
      },
      readModuleStatus: async () => ({
        data: {
          blockers: [],
        },
      }),
    }),
  );
  publishMonitorNotifications({ monitor: unreachable, outboxDir });

  const reachable = await runRuntimeRecoveryMonitor(
    {
      robot_ip: "10.0.0.2",
      session_id: "reachable-session",
      levels: ["L1"],
    },
    baseDependencies(),
  );
  publishMonitorNotifications({ monitor: reachable, outboxDir });

  const events = readRuntimeOutbox({
    sessionId: "reachable-session",
    outboxDir,
    includeDelivered: true,
  });
  assert.equal(events.some(event => event.type === "robot_unreachable"), true);
  assert.equal(events.some(event => event.type === "robot_api_reachable"), true);
  assert.equal(events.find(event => event.type === "robot_api_reachable").no_robot_motion, true);
});

test("runtime outbox delivers to host adapter files and can be acked", async () => {
  const root = tempRoot();
  const outboxDir = path.join(root, "outbox");
  const hostAdapterDir = path.join(root, "host-adapters");
  const monitor = await runRuntimeRecoveryMonitor(
    {
      robot_ip: "10.0.0.2",
      session_id: "delivery-session",
      run_id: "run-1",
      levels: ["L2"],
    },
    baseDependencies(),
  );
  publishMonitorNotifications({ monitor, outboxDir });

  const delivery = await deliverRuntimeOutbox({
    sessionId: "delivery-session",
    adapters: ["claudecode", "codex", "cursor", "cli"],
    outboxDir,
    hostAdapterDir,
  });
  const deliveredEvent = readRuntimeOutbox({
    sessionId: "delivery-session",
    outboxDir,
  })[0];

  assert.equal(delivery.status, "delivered");
  assert.equal(delivery.delivered.length, 4);
  assert.ok(fs.existsSync(path.join(hostAdapterDir, "claudecode", "delivery-session.jsonl")));
  assert.ok(fs.existsSync(path.join(hostAdapterDir, "codex", "delivery-session.jsonl")));
  assert.ok(fs.existsSync(path.join(hostAdapterDir, "cursor", "delivery-session.jsonl")));
  assert.equal(deliveredEvent.delivery_status, "delivered");
  assert.match(deliveredEvent.deliveries.cli.message, /no_robot_motion=true/);

  const acked = ackRuntimeOutboxEvent({
    sessionId: "delivery-session",
    outboxId: deliveredEvent.outbox_id,
    note: "handled",
    outboxDir,
  });
  assert.equal(acked.ack_note, "handled");
  assert.equal(
    readRuntimeOutbox({
      sessionId: "delivery-session",
      outboxDir,
      includeAcked: false,
    }).length,
    0,
  );
});
