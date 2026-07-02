import fs from "fs";

import {
  appendRuntimeOutboxEvent,
  runtimeOutboxPaths,
} from "../runtime-outbox.js";

export function tickOutboxKind(status, goalStatus) {
  const normalizedStatus = String(status || "running").toLowerCase();
  if (normalizedStatus === "completed") {
    return "completed";
  }
  if (normalizedStatus === "hard_stop") {
    return "hard_stop";
  }
  if (normalizedStatus === "needs_user") {
    return "needs_user";
  }
  if (normalizedStatus === "unreachable") {
    return "blocked";
  }
  if (goalStatus === "blocked") {
    return "blocked";
  }
  return "heartbeat";
}

export function shouldWakeOnTick(status, goalStatus, zeroLlmWhenNoError) {
  if (!zeroLlmWhenNoError) {
    return true;
  }
  return tickOutboxKind(status, goalStatus) !== "heartbeat";
}

function patchOutboxEntryTopLevel({ sessionId, outboxId, patch, outboxDir }) {
  const { outbox_path: filePath } = runtimeOutboxPaths({ sessionId, outboxDir });
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
  let matched = null;
  const rewritten = lines.map(line => {
    const entry = JSON.parse(line);
    if (entry.outbox_id !== outboxId) {
      return line;
    }
    matched = { ...entry, ...patch };
    return JSON.stringify(matched);
  });
  if (!matched) {
    return null;
  }
  fs.writeFileSync(filePath, `${rewritten.join("\n")}\n`);
  return matched;
}

export function appendWatchLoopOutboxEntry(event = {}, { outboxDir = null, dedupe = true } = {}) {
  const kind = event.kind || event.data?.kind || null;
  const wake = event.wake === true;
  const saved = appendRuntimeOutboxEvent(event, { outboxDir, dedupe });
  if (kind == null && event.wake == null) {
    return saved;
  }
  const patched = patchOutboxEntryTopLevel({
    sessionId: saved.session_id,
    outboxId: saved.outbox_id,
    patch: {
      kind,
      wake,
      data: {
        ...(saved.data || {}),
        ...(event.data || {}),
        kind,
        wake,
      },
    },
    outboxDir,
  });
  return patched || { ...saved, kind, wake };
}
