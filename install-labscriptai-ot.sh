#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MCP_ROOT="$PLUGIN_ROOT/servers/opentrons-mcp"

cd "$MCP_ROOT"
npm install

export OPENTRONS_PLUGIN_ROOT="$PLUGIN_ROOT"
node "$PLUGIN_ROOT/scripts/verify-setup.mjs" || VERIFY_EXIT=$?

cat <<EOF

LabscriptAI OT plugin is installed.

Set these variables in your client if it does not inject them:
  OPENTRONS_PLUGIN_ROOT=$PLUGIN_ROOT
  OPENTRONS_PROTOCOL_LIBRARY_PATH=$PLUGIN_ROOT/bundled-library

Optional writable state directory:
  PLUGIN_DATA=$PLUGIN_ROOT/.plugin-data

Optional deck vision (lab-trained YOLO):
  pip install ultralytics opencv-python-headless pillow
  Weights: vision/models/weights/deck_v2_best.pt
  Setup: docs/GETTING_STARTED.md#deck-vision-setup

Next steps: docs/GETTING_STARTED.md
EOF

exit "${VERIFY_EXIT:-0}"
