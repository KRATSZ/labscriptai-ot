#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MCP_ROOT="$PLUGIN_ROOT/servers/opentrons-mcp"

cd "$MCP_ROOT"
npm install

export OPENTRONS_PLUGIN_ROOT="$PLUGIN_ROOT"
node "$PLUGIN_ROOT/scripts/verify-setup.mjs" || VERIFY_EXIT=$?

# --- host adapter dirs + optional hook wiring (idempotent) ---
PLUGIN_DATA_DIR="${PLUGIN_DATA:-$PLUGIN_ROOT/.plugin-data}"
mkdir -p "$PLUGIN_DATA_DIR/host-adapters"/cursor "$PLUGIN_DATA_DIR/host-adapters"/claudecode \
  "$PLUGIN_DATA_DIR/host-adapters"/codex "$PLUGIN_DATA_DIR/host-adapters"/piagent \
  "$PLUGIN_DATA_DIR/host-adapters"/opencode

HOOKS_SRC="$PLUGIN_ROOT/hooks"
INSTALL_HOOKS="${LABSCRIPTAI_INSTALL_HOST_HOOKS:-1}"
if [[ "$INSTALL_HOOKS" == "1" && -d "$HOOKS_SRC" ]]; then
  # Claude Code plugin discovery (hooks/ + monitors/ at plugin root)
  if [[ -d "$HOOKS_SRC/claude" ]]; then
    mkdir -p "$PLUGIN_ROOT/hooks" "$PLUGIN_ROOT/monitors"
    [[ -e "$PLUGIN_ROOT/hooks/hooks.json" ]] || ln -sf claude/hooks.json "$PLUGIN_ROOT/hooks/hooks.json" 2>/dev/null || true
    [[ -e "$PLUGIN_ROOT/monitors/monitors.json" ]] || ln -sf ../hooks/claude/monitors.json "$PLUGIN_ROOT/monitors/monitors.json" 2>/dev/null || true
  fi

  # Codex user-level fallback when plugin_hooks feature is off
  if [[ -d "$HOME/.codex" || "${LABSCRIPTAI_FORCE_CODEX_HOOKS:-0}" == "1" ]]; then
    mkdir -p "$HOME/.codex"
    if [[ ! -f "$HOME/.codex/hooks.json" ]]; then
      node "$PLUGIN_ROOT/scripts/install-codex-hooks.mjs" \
        --plugin-root "$PLUGIN_ROOT" \
        --source "$HOOKS_SRC/codex/hooks.json" \
        --target "$HOME/.codex/hooks.json" \
        --merge 2>/dev/null || true
      echo "Codex: wrote ~/.codex/hooks.json — run 'codex' then '/hooks' to trust."
    else
      echo "Codex: ~/.codex/hooks.json exists — merge manually from hooks/codex/hooks.json if needed."
    fi
  fi
fi

cat <<EOF

LabscriptAI OT plugin is installed.

Set these variables in your client if it does not inject them:
  OPENTRONS_PLUGIN_ROOT=$PLUGIN_ROOT
  OPENTRONS_PROTOCOL_LIBRARY_PATH=$PLUGIN_ROOT/bundled-library

Optional writable state directory:
  PLUGIN_DATA=$PLUGIN_ROOT/.plugin-data

Unattended wake (five hosts):
  bash scripts/arm-runtime-watch.sh
  docs/GETTING_STARTED.md#unattended-wake-five-host-self-watch

Pi / OpenCode (experimental):
  hooks/piagent/README.md
  hooks/opencode/README.md
  docs/outbox-wake-pi-opencode.md

Optional deck vision (lab-trained YOLO):
  pip install ultralytics opencv-python-headless pillow
  Weights: vision/models/weights/deck_v2_best.pt
  Setup: docs/GETTING_STARTED.md#deck-vision-setup

Next steps: docs/GETTING_STARTED.md
EOF

exit "${VERIFY_EXIT:-0}"
