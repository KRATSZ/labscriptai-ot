# Pi & OpenCode — runtime outbox wake (experimental)

This guide covers **Pi Coding Agent** (`piagent`) and **OpenCode** host adapters for
LabscriptAI OT unattended wake. Cursor, Claude Code, and Codex use the same MCP
outbox truth; only the thin hook/plugin layer differs.

> **Status: experimental.** Pi MCP requires a community extension; OpenCode plugins
> depend on `@opencode-ai/plugin` APIs that may change. When hooks are unavailable,
> use the **webhook fallback** documented below.

## Shared setup (all five hosts)

```bash
export OPENTRONS_PLUGIN_ROOT=/path/to/labscriptai-ot
export PLUGIN_DATA="$OPENTRONS_PLUGIN_ROOT/.plugin-data"
export OPENTRONS_SESSION_ID=my-run
export ROBOT_IP=192.168.66.102   # when arming live monitor
```

Canonical outbox: `$PLUGIN_DATA/runtime-outbox/<session>/outbox.jsonl`  
Adapter mailboxes: `$PLUGIN_DATA/host-adapters/{cursor|claudecode|codex|piagent|opencode}/<session>.jsonl`

## Pi — two-step enable

**Step 1 — register the wake extension**

Merge `hooks/piagent/settings.fragment.json` into `.pi/settings.json` (replace
`<OPENTRONS_PLUGIN_ROOT>`). Trust the project so Pi loads the extension.

**Step 2 — arm the shared background monitor**

```bash
export OPENTRONS_ROBOT_IP="$ROBOT_IP"
bash scripts/arm-runtime-watch.sh
# default notify: cursor,claudecode,codex,piagent,opencode
# override: OPENTRONS_NOTIFY_ADAPTERS=piagent,cli bash scripts/arm-runtime-watch.sh
```

Or run the monitor directly:

```bash
node scripts/runtime-recovery-monitor.mjs \
  --session-id "$OPENTRONS_SESSION_ID" \
  --robot-ip "$ROBOT_IP" \
  --run-id <run-id> \
  --cycles 0 --interval-ms 30000 \
  --notify-adapters cursor,claudecode,codex,piagent,opencode \
  --out runs/self-recovery/artifacts/runtime-recovery-monitor-latest.json
```

Smoke (empty mailbox → exit 2):

```bash
node scripts/consume-runtime-outbox.mjs --host piagent --poll-once
```

Details: [hooks/piagent/README.md](../hooks/piagent/README.md)

## OpenCode — two-step enable

**Step 1 — merge plugin + MCP**

Copy fields from `hooks/opencode/opencode.fragment.jsonc` into `opencode.jsonc`
(project or `~/.config/opencode/opencode.jsonc`).

**Step 2 — arm the shared background monitor**

```bash
export OPENTRONS_ROBOT_IP="$ROBOT_IP"
bash scripts/arm-runtime-watch.sh
```

Same default adapter list as Pi (`cursor,claudecode,codex,piagent,opencode`). See Pi step 2 for `OPENTRONS_NOTIFY_ADAPTERS` override and direct `runtime-recovery-monitor.mjs` invocation.

Smoke:

```bash
node scripts/consume-runtime-outbox.mjs --host opencode --poll-once
```

Details: [hooks/opencode/README.md](../hooks/opencode/README.md)

## Five hosts — one `arm-runtime-watch` pattern

All hosts share the same monitor and outbox delivery. Pick your adapter(s) in
`--notify-adapters`; each host consumes its own mailbox via hook/plugin or CLI:

| Host | Consume command | Wake trigger |
|------|-----------------|--------------|
| Cursor | `--host cursor --hook stop` | `.cursor/hooks.json` stop |
| Claude Code | `--host claudecode --format claude-stop` | Stop hook |
| Codex | `--host codex --poll-once` | heartbeat hook |
| Pi | `--host piagent --poll-once` | `agent_end` extension |
| OpenCode | `--host opencode --poll-once` | `session.idle` plugin |

Example deliver + wake via MCP:

```text
runtime_deliver_outbox(session_id, adapters=["piagent","opencode","cursor"])
runtime_watch_loop(run_id, notify_adapters=["piagent","opencode"], zero_llm_when_no_error=true)
```

Auto-detect: if `$PLUGIN_DATA/host-adapters/piagent/` or `opencode/` exists,
`runtime-recovery-monitor.mjs` includes that adapter when `--notify-adapters` is
omitted.

## Webhook fallback (Pi / OpenCode / any host)

When no IDE session is open:

```bash
export OPENTRONS_RUNTIME_ALERT_WEBHOOK_URL=http://127.0.0.1:18765/outbox

node scripts/runtime-recovery-monitor.mjs \
  --session-id "$OPENTRONS_SESSION_ID" \
  --robot-ip "$ROBOT_IP" \
  --notify-adapters webhook,piagent,opencode \
  --cycles 20 --interval-ms 30000
```

Point your relay (e.g. `scripts/outbox-webhook-relay.mjs` when packaged) at
`host-adapters/*` mailboxes. Events persist until a host session runs
`consume-runtime-outbox.mjs` with `--ack`.

## Safety

- Default monitor mode is observe-only (`no_robot_motion=true`).
- `needs_user` / `hard_stop` events always wake (`wake: true`).
- Never bypass the simulation gate from consume output — continuation prompts
  only recommend MCP tools; they do not execute robot motion.

See also: [GETTING_STARTED.md](./GETTING_STARTED.md) (runtime monitor section),
[hooks/piagent/README.md](../hooks/piagent/README.md),
[hooks/opencode/README.md](../hooks/opencode/README.md).
