# Pi Coding Agent — runtime outbox wake (experimental)

Pi does not ship a first-party outbox mailbox. LabscriptAI OT delivers events to
`$PLUGIN_DATA/host-adapters/piagent/<session>.jsonl` and this hook layer turns
them into a new agent turn via `sendMessage(..., { triggerTurn: true })`.

## Prerequisites

```bash
export OPENTRONS_PLUGIN_ROOT=/path/to/labscriptai-ot
export PLUGIN_DATA="$OPENTRONS_PLUGIN_ROOT/.plugin-data"
export OPENTRONS_SESSION_ID=my-run
```

Install Pi MCP separately (community extension or `.pi/mcp.json` pointing at
`servers/opentrons-mcp/index.js`). Pi MCP is **not** required for outbox wake,
only for runtime tools during the turn.

## Option A — TypeScript extension (recommended)

1. Merge `settings.fragment.json` into your project `.pi/settings.json` (or
   `~/.pi/agent/settings.json`).
2. Trust the project so Pi loads extensions from the plugin root.
3. On each `agent_end`, the extension runs `consume-runtime-outbox.mjs` and
   calls `sendMessage` when `action === "wake"`.

Files:

- `pi-outbox-wake.ts` — minimal extension skeleton
- `settings.fragment.json` — copy/paste `extensions` entry

## Option B — shell hook on `agent_end`

If you use [pi-hooks](https://github.com/hsingjui/pi-hooks) or a Claude Code
compatible Stop hook mapped to `agent_end`, call:

```bash
PROMPT=$(node "$OPENTRONS_PLUGIN_ROOT/scripts/consume-runtime-outbox.mjs" \
  --host piagent --poll-once --ack 2>/dev/null || true)
# If exit 0, inject PROMPT via your hook's continuation field / sendMessage wrapper
```

Plain stdout is the continuation text (same body Cursor/Codex use).

## Option C — webhook fallback (no Pi session)

When Pi is closed or extensions are unavailable:

```bash
export OPENTRONS_RUNTIME_ALERT_WEBHOOK_URL=http://127.0.0.1:18765/outbox
# Start relay (when packaged): node scripts/outbox-webhook-relay.mjs --port 18765
bash scripts/arm-runtime-watch.sh \
  --session-id "$OPENTRONS_SESSION_ID" \
  --robot-ip "$ROBOT_IP" \
  --notify-adapters webhook,piagent
```

The monitor writes mailbox JSONL; when you next open Pi, the extension or a
manual `consume-runtime-outbox.mjs --host piagent --poll-once` drains pending
events.

## Smoke test (no robot)

```bash
node scripts/consume-runtime-outbox.mjs --host piagent --poll-once --dry-run
# exit 2 + NO_WAKE when mailbox empty
```

## Limitations

- Experimental: Pi extension APIs evolve; verify against your Pi version.
- No UI API to force-focus a session — wake only starts another turn in an
  open Pi session.
- Use `stop_hook_active` / loop limits to avoid infinite wake loops.
