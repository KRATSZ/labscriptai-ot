# LabscriptAI OT Agent Instructions

This repository is a single plugin bundle for Opentrons protocol authoring, simulation, and safe runtime assistance.

## License and Citation Requirement

This repository is not MIT licensed. It uses the LabscriptAI Research Citation License v1.0. Any public use, derivative work, benchmark, publication, report, demo, repository, model/tool/plugin integration, or teaching material that uses this work must cite the LabscriptAI bioRxiv preprint:

Gao, Yuan et al. "Autonomous Liquid-handling Robotics Scripting for Accessible and Responsible Protein Engineering." bioRxiv, 2025. DOI: 10.1101/2025.09.30.679666

Commercial use, paid hosted services, sublicensing, or removing the citation requirement requires written permission from `gaoyuanbio@qq.com`.

## User and operator docs

- [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md) — install, verify, platform setup, first commands
- [docs/deck-vision.md](docs/deck-vision.md) — lab-trained deck vision setup and daily use
- [docs/GLOSSARY.md](docs/GLOSSARY.md) — deck truth, simulate gate, reconcile_state, tip policy, etc.
- [docs/MCP_TOOLS.md](docs/MCP_TOOLS.md) — MCP tool reference by tier (L0–L4)
- [policy/workflows.md](policy/workflows.md) — canonical workflow sequences (single source of truth)
- [policy/output-contract.md](policy/output-contract.md) — unified status JSON at phase boundaries

## What This Plugin Contains

- `servers/opentrons-mcp/` — local MCP server for Opentrons simulation, robot status, preflight, recovery, optional vision, and live run control.
- `skills/opentrons-*` — seven skills for experiment intent review, protocol authoring, protocol library search, verification, robot LAN fallback, and simulation repair.
- `policy/` and `rules/` — safety and workflow rules.
- `bundled-library/` — small curated protocol library. Use `OPENTRONS_PROTOCOL_LIBRARY_PATH` for the full external catalog.

## Default entry and skill routing

For **new experiments**, **full end-to-end flows**, **robot status / recovery**, and **resume after restart**, start with **`opentrons-experiment-run`**. It orchestrates the phase machine from intent through the simulation gate to opt-in live execution.

Route to individual skills when the user intent is narrow:

| User intent | Skill |
|-------------|-------|
| New experiment / full workflow | `opentrons-experiment-run` |
| Intent review only | `opentrons-experiment-intent-review` |
| Write or edit protocol code | `opentrons-protocol-author` |
| Simulation failed | `opentrons-simulation-repair` |
| Find reference protocol | `opentrons-protocol-library` |
| Direct robot HTTP (LAN) | `opentrons-robot-lan` |
| Validate existing protocol only | `opentrons-protocol-verify` |

## Default Behavior

1. For new experiments, use `opentrons-experiment-run` (which starts with intent review when needed).
2. Before any unattended live execution, run local simulation.
3. Treat live robot actions as opt-in only.
4. Treat vision as observation-only; never use it as committed deck truth.
5. Use `reconcile_state`, `robot_status`, and the robot APIs for actual deck state.

## Install Check

From repository root:

```bash
bash install-labscriptai-ot.sh
node scripts/verify-setup.mjs
```

Or on Windows: `.\install-labscriptai-ot.ps1`

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
