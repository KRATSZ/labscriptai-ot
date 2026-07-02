#!/usr/bin/env bash
# Claude: chmod +x hooks/piagent/runtime-outbox-agent-end.sh
# Wire from pi-hooks Stop / agent_end shell hook.
set -euo pipefail
ROOT="${OPENTRONS_PLUGIN_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
SESSION="${OPENTRONS_SESSION_ID:-default}"
node "$ROOT/scripts/consume-runtime-outbox.mjs" \
  --host piagent \
  --session-id "$SESSION" \
  --poll-once \
  --ack 2>/dev/null || exit 0
