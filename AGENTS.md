# LabscriptAI OT Agent Instructions

This repository is a single plugin bundle for Opentrons protocol authoring, simulation, and safe runtime assistance.

## What This Plugin Contains

- `servers/opentrons-mcp/` — local MCP server for Opentrons simulation, robot status, preflight, recovery, optional vision, and live run control.
- `skills/opentrons-*` — seven skills for experiment intent review, protocol authoring, protocol library search, verification, robot LAN fallback, and simulation repair.
- `policy/` and `rules/` — safety and workflow rules.
- `bundled-library/` — small curated protocol library. Use `OPENTRONS_PROTOCOL_LIBRARY_PATH` for the full external catalog.

## Default Behavior

1. For new experiments, start with intent review before writing protocol code.
2. Before any unattended live execution, run local simulation.
3. Treat live robot actions as opt-in only.
4. Treat vision as observation-only; never use it as committed deck truth.
5. Use `reconcile_state`, `robot_status`, and the robot APIs for actual deck state.

## Install Check

From repository root:

```bash
bash install-labscriptai-ot.sh
cd servers/opentrons-mcp
OPENTRONS_PLUGIN_ROOT="$(cd ../.. && pwd)" npm test
```

## Platform Files

- Claude Code: `.claude-plugin/plugin.json`, `.claude-plugin/mcp.json`, `.claude-plugin/marketplace.json`
- Codex: `.codex-plugin/plugin.json`, `.codex-plugin/marketplace.json`, `.mcp.json`
- Cursor: `.cursor-plugin/plugin.json`, `.cursor/mcp.json`, `.cursor/rules/labscriptai-ot.mdc`

## Important Environment Variables

- `OPENTRONS_PLUGIN_ROOT`: absolute path to this repository.
- `PLUGIN_DATA`: writable state/artifact directory.
- `OPENTRONS_PYTHON`: Python executable with Opentrons simulation dependencies.
- `OPENTRONS_PROTOCOL_LIBRARY_PATH`: optional external protocol library.
- `OPENTRONS_ENABLE_PROBE_WELLS=1`: explicit opt-in for live probe motion only.

## Safety Boundary

Do not enable live robot motion by default. Do not bypass the simulation gate. Do not mix robot HTTP fallback and MCP live control against the same robot in parallel.
