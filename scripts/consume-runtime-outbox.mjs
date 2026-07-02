#!/usr/bin/env node
/**
 * Cross-platform runtime outbox consumer (Cursor / Claude Code / Codex hooks + CLI).
 *
 * Reads pending wake sentinels from:
 *   1) PLUGIN_DATA/host-adapters/<host>/<session>.jsonl  (adapter mailbox), or
 *   2) PLUGIN_DATA/runtime-outbox/<session>/outbox.jsonl (canonical outbox)
 *
 * Host output schemas (see runs/outbox-wake/01-cursor-core-consumer.md, 02-claudecode-codex.md):
 *   - cursor stop         → { "followup_message": "..." } | {}
 *   - cursor sessionStart → { "additional_context": "..." } | {}
 *   - claudecode Stop     → { "decision": "block", "reason": "...", "hookSpecificOutput": {...} } | {}
 *   - codex Stop          → { "decision": "block", "reason": "..." } | {}
 *
 * Usage:
 *   node scripts/consume-runtime-outbox.mjs --host cursor --hook stop [--ack]
 *   node scripts/consume-runtime-outbox.mjs --host claudecode --hook-event Stop
 *   node scripts/consume-runtime-outbox.mjs --poll-once --host cursor
 *   node scripts/consume-runtime-outbox.mjs --host piagent --poll-once [--ack]
 *   node scripts/consume-runtime-outbox.mjs --host opencode --format opencode-prompt [--ack]
 */
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(
  process.env.OPENTRONS_PLUGIN_ROOT ||
    process.env.CURSOR_PLUGIN_ROOT ||
    process.env.CLAUDE_PLUGIN_ROOT ||
    process.env.PLUGIN_ROOT ||
    path.join(__dirname, ".."),
);
const DATA_DIR = path.resolve(
  process.env.PLUGIN_DATA ||
    process.env.OPENTRONS_PLUGIN_DATA ||
    process.env.CLAUDE_PLUGIN_DATA ||
    path.join(PLUGIN_ROOT, ".plugin-data"),
);
const DEFAULT_SESSION_ID = process.env.OPENTRONS_SESSION_ID || "default";
const VALID_HOSTS = new Set(["cursor", "claudecode", "codex", "piagent", "opencode"]);

function defaultFormatForHost(host, { pollOnce = false } = {}) {
  if (pollOnce) {
    return "text";
  }
  switch (host) {
    case "cursor":
      return "cursor-stop";
    case "claudecode":
      return "claude-stop";
    case "codex":
      return "text";
    case "piagent":
      return "pi-message";
    case "opencode":
      return "opencode-prompt";
    default:
      return "json";
  }
}

export function buildWakePayload(event, host, continuation) {
  const kind = event.kind || event.data?.kind || event.type || "unknown";
  return {
    action: "wake",
    adapter: host,
    outbox_id: event.outbox_id,
    kind,
    session_id: event.session_id || "default",
    run_id: event.run_id || null,
    prompt: continuation,
    recommended_next_tool:
      event.recommended_next_tool || event.data?.recommended_next_tool || "runtime_get_outbox",
    no_robot_motion: event.no_robot_motion !== false,
  };
}

export function parseArgs(argv) {
  const args = {
    host: "cursor",
    hook: null,
    hook_event: null,
    session_id: DEFAULT_SESSION_ID,
    run_id: null,
    source: "auto",
    wake_only: true,
    ack: false,
    poll_once: false,
    dry_run: false,
    limit: 20,
    host_adapter_dir: null,
    outbox_dir: null,
    format: null,
    stdin_json: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--host" || item === "--adapter") {
      args.host = String(argv[i + 1] || "cursor").trim().toLowerCase();
      if (args.host === "claude") {
        args.host = "claudecode";
      }
      i += 1;
    } else if (item === "--hook") {
      args.hook = argv[i + 1];
      i += 1;
    } else if (item === "--hook-event") {
      args.hook_event = argv[i + 1];
      i += 1;
    } else if (item === "--session-id") {
      args.session_id = argv[i + 1];
      i += 1;
    } else if (item === "--run-id") {
      args.run_id = argv[i + 1];
      i += 1;
    } else if (item === "--source") {
      args.source = argv[i + 1];
      i += 1;
    } else if (item === "--include-heartbeats") {
      args.wake_only = false;
    } else if (item === "--ack") {
      args.ack = true;
    } else if (item === "--no-ack") {
      args.ack = false;
    } else if (item === "--poll-once") {
      args.poll_once = true;
    } else if (item === "--dry-run") {
      args.dry_run = true;
    } else if (item === "--limit") {
      args.limit = Number(argv[i + 1]);
      i += 1;
    } else if (item === "--host-adapter-dir") {
      args.host_adapter_dir = argv[i + 1];
      i += 1;
    } else if (item === "--outbox-dir") {
      args.outbox_dir = argv[i + 1];
      i += 1;
    } else if (item === "--format") {
      args.format = argv[i + 1];
      i += 1;
    }
  }
  if (!VALID_HOSTS.has(args.host)) {
    throw new Error(`invalid --host ${args.host}; expected cursor|claudecode|codex|piagent|opencode`);
  }
  if (!args.format) {
    args.format = defaultFormatForHost(args.host, { pollOnce: args.poll_once });
  }
  return args;
}

export function normalizeHookEvent(args) {
  const raw = args.hook_event || args.hook;
  if (!raw) {
    return null;
  }
  const lower = String(raw).toLowerCase();
  if (lower === "stop") {
    return "stop";
  }
  if (lower === "sessionstart") {
    return "sessionStart";
  }
  if (lower === "userpromptsubmit") {
    return "userPromptSubmit";
  }
  return raw;
}

function hostAdapterRoot(hostAdapterDir) {
  return path.resolve(hostAdapterDir || path.join(DATA_DIR, "host-adapters"));
}

function outboxRoot(outboxDir) {
  return path.resolve(outboxDir || path.join(DATA_DIR, "runtime-outbox"));
}

export function consumerStatePath(sessionId, host, hostAdapterDir) {
  return path.join(hostAdapterRoot(hostAdapterDir), host, `${sessionId}.consumer-state.json`);
}

function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`);
  fs.renameSync(temp, filePath);
}

export function unwrapAdapterEnvelope(row) {
  if (row?.event && typeof row.event === "object") {
    return row.event;
  }
  return row;
}

export function isWakeEvent(event, wakeOnly) {
  if (!wakeOnly) {
    return true;
  }
  if (event.wake === true) {
    return true;
  }
  if (event.wake === false) {
    return false;
  }
  const kind = event.kind || event.data?.kind;
  if (kind === "heartbeat") {
    return false;
  }
  if (event.requires_attention === true || event.severity === "hard_stop") {
    return true;
  }
  return event.wake !== false;
}

export function readAdapterMailbox({ sessionId, host, hostAdapterDir, consumerState }) {
  const filePath = path.join(hostAdapterRoot(hostAdapterDir), host, `${sessionId}.jsonl`);
  if (!fs.existsSync(filePath)) {
    return { events: [], filePath, nextOffset: consumerState.adapter_offset || 0 };
  }
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split("\n");
  const offset = Number(consumerState.adapter_offset || 0);
  const slice = lines.slice(offset);
  const events = slice
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      try {
        return unwrapAdapterEnvelope(JSON.parse(line));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return {
    events,
    filePath,
    nextOffset: lines.length,
  };
}

async function readCanonicalOutbox({ sessionId, runId, outboxDir, limit }) {
  const modPath = path.join(PLUGIN_ROOT, "servers/opentrons-mcp/lib/runtime-outbox.js");
  const mod = await import(pathToFileURL(modPath).href);
  const events = mod.readRuntimeOutbox({
    sessionId,
    runId,
    includeAcked: false,
    includeDelivered: true,
    limit,
    outboxDir: outboxDir || null,
  });
  return { events, filePath: path.join(outboxRoot(outboxDir), sessionId, "outbox.jsonl") };
}

export function pickLatestActionable(events, { runId, wakeOnly, consumerState }) {
  const seen = new Set(consumerState.acked_outbox_ids || []);
  const filtered = events
    .filter(event => !runId || event.run_id === runId)
    .filter(event => !event.acked_at)
    .filter(event => !seen.has(event.outbox_id))
    .filter(event => isWakeEvent(event, wakeOnly));
  if (filtered.length === 0) {
    return null;
  }
  filtered.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  return filtered[0];
}

function goalStatusHint(event) {
  const kind = event.kind || event.data?.kind || "unknown";
  if (kind === "completed") {
    return "COMPLETE";
  }
  if (["needs_user", "hard_stop", "blocked"].includes(kind) || event.severity === "hard_stop") {
    return "BLOCKED";
  }
  return "CONTINUE";
}

export function buildContinuationPrompt(event, host = "cursor") {
  const kind = event.kind || event.data?.kind || "unknown";
  const hint = goalStatusHint(event);
  const tool = event.recommended_next_tool || event.data?.recommended_next_tool || "runtime_get_outbox";
  const runIdJson = event.run_id ? `"${event.run_id}"` : "null";
  const adapterList = host;
  const message = event.message_zh || event.message || event.title || kind;
  return [
    "[LabscriptAI OT Goal Wake]",
    `Session: ${event.session_id || "default"}  Run: ${event.run_id || "(none)"}`,
    `Event: ${event.type || kind} — ${message}`,
    `Severity: ${event.severity || "info"}  requires_attention=${event.requires_attention === true}`,
    `Recommended tool: ${tool}`,
    `no_robot_motion=${event.no_robot_motion !== false}`,
    "",
    "Follow skill opentrons-experiment-goal:",
    `1. runtime_get_outbox(session_id="${event.session_id || "default"}", run_id=${runIdJson}, limit=5)`,
    `2. If goal loop not armed: runtime_watch_loop(..., notify_adapters=["${adapterList}"], self_fix_mode="observe")`,
    "3. Branch on goal_status / alert severity",
    "4. Print exactly one status line:",
    "   GOAL_STATUS: CONTINUE | COMPLETE | BLOCKED",
    "   GOAL_REASON: <one line>",
    `5. On COMPLETE: runtime_ack_outbox(outbox_id="${event.outbox_id}")`,
    "",
    "Safety: hard_stop → BLOCKED, do not auto-retry. Liquid recovery → live_liquid_recovery_gate + operator opt-in.",
    "",
    `outbox_id: ${event.outbox_id}`,
    `kind: ${kind}`,
    `wake: ${event.wake === true}`,
    "",
    `GOAL_STATUS: ${hint}  (refine to CONTINUE | COMPLETE | BLOCKED after inspection)`,
    "GOAL_REASON: <one line>",
  ].join("\n");
}

async function ackOutboxEvent({ sessionId, outboxId, outboxDir }) {
  const modPath = path.join(PLUGIN_ROOT, "servers/opentrons-mcp/lib/runtime-outbox.js");
  const mod = await import(pathToFileURL(modPath).href);
  return mod.ackRuntimeOutboxEvent({
    sessionId,
    outboxId,
    note: "consumed by consume-runtime-outbox.mjs",
    outboxDir: outboxDir || null,
  });
}

function updateConsumerState({ sessionId, host, hostAdapterDir, patch }) {
  const statePath = consumerStatePath(sessionId, host, hostAdapterDir);
  const current = readJsonFile(statePath, {
    session_id: sessionId,
    adapter_offset: 0,
    acked_outbox_ids: [],
    last_outbox_id: null,
    updated_at: null,
  });
  const next = {
    ...current,
    ...patch,
    updated_at: new Date().toISOString(),
  };
  if (Array.isArray(next.acked_outbox_ids) && next.acked_outbox_ids.length > 200) {
    next.acked_outbox_ids = next.acked_outbox_ids.slice(-200);
  }
  writeJsonFile(statePath, next);
  return next;
}

export async function consumeOnce(args) {
  const consumerState = readJsonFile(consumerStatePath(args.session_id, args.host, args.host_adapter_dir), {
    session_id: args.session_id,
    adapter_offset: 0,
    acked_outbox_ids: [],
  });

  let events = [];
  let adapterMeta = null;

  if (args.source === "adapter" || args.source === "auto") {
    adapterMeta = readAdapterMailbox({
      sessionId: args.session_id,
      host: args.host,
      hostAdapterDir: args.host_adapter_dir,
      consumerState,
    });
    events = adapterMeta.events;
  }

  if ((args.source === "outbox" || args.source === "auto") && events.length === 0) {
    const outbox = await readCanonicalOutbox({
      sessionId: args.session_id,
      runId: args.run_id,
      outboxDir: args.outbox_dir,
      limit: args.limit,
    });
    events = outbox.events;
    adapterMeta = adapterMeta || { nextOffset: consumerState.adapter_offset || 0 };
  }

  const event = pickLatestActionable(events, {
    runId: args.run_id,
    wakeOnly: args.wake_only,
    consumerState,
  });

  if (!event) {
    return { event: null, continuation: null, consumerState, adapterMeta };
  }

  if (args.ack && event.outbox_id && !args.dry_run) {
    await ackOutboxEvent({
      sessionId: args.session_id,
      outboxId: event.outbox_id,
      outboxDir: args.outbox_dir,
    });
    updateConsumerState({
      sessionId: args.session_id,
      host: args.host,
      hostAdapterDir: args.host_adapter_dir,
      patch: {
        adapter_offset: adapterMeta?.nextOffset ?? consumerState.adapter_offset,
        last_outbox_id: event.outbox_id,
        acked_outbox_ids: [...(consumerState.acked_outbox_ids || []), event.outbox_id],
      },
    });
  }

  return {
    event,
    continuation: buildContinuationPrompt(event, args.host),
    consumerState,
    adapterMeta,
  };
}

/**
 * Emit host-specific hook JSON to stdout.
 * Claude schema per runs/outbox-wake/02-claudecode-codex.md (v2.1.163+ Stop continuation).
 */
export function emitHookResponse({ host, hookEvent, continuation, event }) {
  if (!continuation) {
    process.stdout.write("{}\n");
    return;
  }

  if (host === "cursor") {
    if (hookEvent === "stop") {
      process.stdout.write(`${JSON.stringify({ followup_message: continuation })}\n`);
      return;
    }
    if (hookEvent === "sessionStart") {
      process.stdout.write(`${JSON.stringify({ additional_context: continuation })}\n`);
      return;
    }
    process.stdout.write(`${continuation}\n`);
    return;
  }

  if (host === "claudecode") {
    if (hookEvent === "stop") {
      const payload = {
        decision: "block",
        reason: continuation,
        hookSpecificOutput: {
          hookEventName: "Stop",
          additionalContext: `Pending runtime outbox event ${event?.outbox_id || "unknown"}. Execute opentrons-experiment-goal wake protocol.`,
        },
      };
      process.stdout.write(`${JSON.stringify(payload)}\n`);
      return;
    }
    if (hookEvent === "sessionStart" || hookEvent === "userPromptSubmit") {
      const payload = {
        hookSpecificOutput: {
          hookEventName: hookEvent === "sessionStart" ? "SessionStart" : "UserPromptSubmit",
          additionalContext: continuation,
        },
      };
      process.stdout.write(`${JSON.stringify(payload)}\n`);
      return;
    }
    process.stdout.write(`${continuation}\n`);
    return;
  }

  if (host === "codex") {
    if (hookEvent === "stop") {
      process.stdout.write(`${JSON.stringify({ decision: "block", reason: continuation })}\n`);
      return;
    }
    process.stdout.write(`${continuation}\n`);
    return;
  }

  process.stdout.write(`${continuation}\n`);
}

/**
 * Emit poll/CLI output for piagent, opencode, and generic --format modes.
 */
export function emitPollResponse({ host, format, continuation, event }) {
  if (!continuation || !event) {
    if (format === "json" || format === "pi-message" || format === "opencode-prompt") {
      process.stdout.write(`${JSON.stringify({ action: "noop", adapter: host })}\n`);
      return;
    }
    process.stdout.write("NO_WAKE\n");
    return;
  }

  const payload = buildWakePayload(event, host, continuation);

  if (format === "json" || format === "pi-message" || format === "opencode-prompt") {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }

  process.stdout.write(`${continuation}\n`);
}

async function readStdinJson() {
  if (process.stdin.isTTY) {
    return null;
  }
  const text = await new Promise(resolve => {
    let data = "";
    const done = () => {
      clearTimeout(timer);
      process.stdin.removeAllListeners();
      if (process.stdin.destroy) {
        process.stdin.destroy();
      } else {
        process.stdin.pause();
      }
      resolve(data);
    };
    const timer = setTimeout(done, 100);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => {
      data += chunk;
    });
    process.stdin.on("end", done);
  });
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

export async function runConsumer(argv = process.argv.slice(2), { stdinJson = null } = {}) {
  const args = parseArgs(argv);
  const hookEvent = normalizeHookEvent(args);
  const isHookMode = Boolean(hookEvent);
  const stdin = stdinJson ?? (isHookMode ? await readStdinJson() : null);

  // Cursor conversation UUID ≠ OPENTRONS_SESSION_ID — always prefer env/--session-id.
  if (stdin?.stop_hook_active === true) {
    process.stdout.write("{}\n");
    return { event: null, continuation: null, hookEvent };
  }

  if (isHookMode && !argv.includes("--ack") && !argv.includes("--no-ack")) {
    args.ack = true;
  }

  if (args.dry_run) {
    args.ack = false;
  }

  const { event, continuation } = await consumeOnce(args);

  if (args.dry_run) {
    emitPollResponse({ host: args.host, format: "text", continuation, event });
    return { event, continuation, hookEvent, exitCode: continuation ? 0 : 2 };
  }

  if (hookEvent) {
    emitHookResponse({ host: args.host, hookEvent, continuation, event });
    return { event, continuation, hookEvent, exitCode: 0 };
  }

  if (args.poll_once || !hookEvent) {
    emitPollResponse({ host: args.host, format: args.format, continuation, event });
    const noWakeExit =
      !continuation && ["piagent", "opencode"].includes(args.host) ? 2 : 0;
    return { event, continuation, hookEvent, exitCode: noWakeExit };
  }

  return { event, continuation, hookEvent, exitCode: 0 };
}

async function main() {
  try {
    const result = await runConsumer();
    process.exit(result.exitCode ?? 0);
  } catch (error) {
    console.error(`consume-runtime-outbox failed: ${error.message}`);
    process.stdout.write("{}\n");
    process.exit(1);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main();
}
