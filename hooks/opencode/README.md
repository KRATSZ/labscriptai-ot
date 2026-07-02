# OpenCode — runtime outbox wake (experimental)

OpenCode natively supports MCP and TypeScript plugins. LabscriptAI OT delivers
events to `$PLUGIN_DATA/host-adapters/opencode/<session>.jsonl`. A thin plugin
calls `session.prompt` when a wake sentinel is pending.

## Prerequisites

```bash
export OPENTRONS_PLUGIN_ROOT=/path/to/labscriptai-ot
export PLUGIN_DATA="$OPENTRONS_PLUGIN_ROOT/.plugin-data"
export OPENTRONS_SESSION_ID=my-run
```

## Option A — TypeScript plugin (recommended)

1. Merge `opencode.fragment.jsonc` into project `opencode.jsonc` (or global
   `~/.config/opencode/opencode.jsonc`).
2. Ensure `@opencode-ai/plugin` types resolve (OpenCode bundles plugin runtime).
3. On `session.idle` / `stop`, the plugin runs `consume-runtime-outbox.mjs` and
   injects the continuation via `client.session.prompt`.

Files:

- `labscriptai-outbox-wake.ts` — minimal plugin skeleton
- `opencode.fragment.jsonc` — `mcpServers` + `plugin` entries

## Option B — CLI poll from shell / cron

When plugins are not loaded, poll manually or from a wrapper script:

```bash
node "$OPENTRONS_PLUGIN_ROOT/scripts/consume-runtime-outbox.mjs" \
  --host opencode --poll-once --ack
```

Stdout is plain continuation text suitable for pasting into OpenCode or feeding
to `session.prompt` from your own automation.

JSON mode for plugins:

```bash
node scripts/consume-runtime-outbox.mjs \
  --host opencode --format opencode-prompt --ack
```

## Option C — webhook fallback

```bash
export OPENTRONS_RUNTIME_ALERT_WEBHOOK_URL=http://127.0.0.1:18765/outbox
bash scripts/arm-runtime-watch.sh \
  --session-id "$OPENTRONS_SESSION_ID" \
  --robot-ip "$ROBOT_IP" \
  --notify-adapters webhook,opencode
```

When OpenCode is closed, events accumulate in the mailbox; the plugin or CLI
drains them on the next idle/stop event.

## Smoke test (no robot)

```bash
node scripts/consume-runtime-outbox.mjs --host opencode --poll-once --dry-run
# exit 2 + NO_WAKE when mailbox empty
```

## Limitations

- Experimental: plugin event names and `client.session.prompt` API may differ by
  OpenCode version — adjust `labscriptai-outbox-wake.ts` after upgrade.
- MCP `tool.execute.after` and native tools follow slightly different paths; wake
  logic stays in the plugin, not in MCP tool hooks.
- No cross-session UI focus API — an OpenCode session must be running.
