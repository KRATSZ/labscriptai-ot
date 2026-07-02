#!/usr/bin/env bash
# Arm background runtime monitor + host adapter delivery for unattended wake.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export OPENTRONS_PLUGIN_ROOT="$PLUGIN_ROOT"
export PLUGIN_DATA="${PLUGIN_DATA:-$PLUGIN_ROOT/.plugin-data}"
export OPENTRONS_SESSION_ID="${OPENTRONS_SESSION_ID:-self-recovery-liquid}"

SESSION_ID="$OPENTRONS_SESSION_ID"
NOTIFY_ADAPTERS="${OPENTRONS_NOTIFY_ADAPTERS:-cursor,claudecode,codex,piagent,opencode}"
PID_FILE="$PLUGIN_DATA/runtime-watch-arm.pid"
LOG_FILE="$PLUGIN_DATA/runtime-recovery-monitor-arm.log"
ADAPTER_DIR="$PLUGIN_DATA/host-adapters"
OUTBOX_PATH="$PLUGIN_DATA/runtime-outbox/$SESSION_ID/outbox.jsonl"

mkdir -p "$ADAPTER_DIR"/cursor "$ADAPTER_DIR"/claudecode "$ADAPTER_DIR"/codex \
  "$ADAPTER_DIR"/piagent "$ADAPTER_DIR"/opencode
mkdir -p "$(dirname "$OUTBOX_PATH")"

if [[ -f "$PID_FILE" ]]; then
  OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "${OLD_PID:-}" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Runtime watch already armed (PID $OLD_PID). Stop with: kill $OLD_PID"
    exit 0
  fi
fi

MONITOR_ARGS=(
  --session-id "$SESSION_ID"
  --cycles 999
  --interval-ms 30000
  --notify-adapters "$NOTIFY_ADAPTERS"
  --host-adapter-dir "$ADAPTER_DIR"
  --out "$PLUGIN_DATA/runtime-recovery-monitor-latest.json"
  --markdown-out "$PLUGIN_DATA/runtime-recovery-monitor-latest.md"
)

if [[ -n "${OPENTRONS_ROBOT_IP:-}" ]]; then
  MONITOR_ARGS+=(--robot-ip "$OPENTRONS_ROBOT_IP")
fi
if [[ -n "${OPENTRONS_RUN_ID:-}" ]]; then
  MONITOR_ARGS+=(--run-id "$OPENTRONS_RUN_ID")
fi

nohup node "$PLUGIN_ROOT/scripts/runtime-recovery-monitor.mjs" "${MONITOR_ARGS[@]}" >>"$LOG_FILE" 2>&1 &
echo $! >"$PID_FILE"

cat <<EOF
Armed runtime watch (background monitor).

  PID:          $(cat "$PID_FILE")
  session_id:   $SESSION_ID
  PLUGIN_DATA:  $PLUGIN_DATA
  outbox:       $OUTBOX_PATH
  notify:       $NOTIFY_ADAPTERS
  adapters:     $ADAPTER_DIR/{cursor,claudecode,codex,piagent,opencode}/$SESSION_ID.jsonl
  log:          $LOG_FILE

Override adapters: OPENTRONS_NOTIFY_ADAPTERS=cursor,claudecode,codex bash scripts/arm-runtime-watch.sh

Next: open Claude Code / Cursor / Codex / Pi / OpenCode and say:
  "用 opentrons-experiment-goal 盯 session $SESSION_ID 到 BLOCKED 或 COMPLETE"

Or arm goal loop in-agent:
  runtime_watch_loop(run_id=..., session_id="$SESSION_ID",
                     notify_adapters=["cursor","claudecode","codex","piagent","opencode"],
                     zero_llm_when_no_error=true, self_fix_mode="observe")

Stop monitor: kill \$(cat "$PID_FILE")
EOF
