#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export OPENTRONS_PLUGIN_ROOT="$PLUGIN_ROOT"

if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  echo "Install Node.js 18+ (including npm) from https://nodejs.org/, then rerun this installer." >&2
  exit 1
fi
node -e 'if (Number(process.versions.node.split(".")[0]) < 18) { console.error("Node.js 18+ is required. Update Node.js and rerun the installer."); process.exit(1); }'

node "$PLUGIN_ROOT/scripts/install-runtime.mjs"
node "$PLUGIN_ROOT/scripts/verify-setup.mjs" || VERIFY_EXIT=$?

cat <<EOF

Next: enable the plugin in your client using docs/GETTING_STARTED.md.
First task: "Check my protocol locally; do not connect to a robot."
EOF

exit "${VERIFY_EXIT:-0}"
