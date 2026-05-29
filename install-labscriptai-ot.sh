#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MCP_ROOT="$PLUGIN_ROOT/servers/opentrons-mcp"

cd "$MCP_ROOT"
npm install

cat <<EOF
LabscriptAI OT plugin is installed.

Set these variables in your client if it does not inject them:
  OPENTRONS_PLUGIN_ROOT=$PLUGIN_ROOT
  OPENTRONS_PROTOCOL_LIBRARY_PATH=$PLUGIN_ROOT/bundled-library

Optional writable state directory:
  PLUGIN_DATA=$PLUGIN_ROOT/.plugin-data
EOF
