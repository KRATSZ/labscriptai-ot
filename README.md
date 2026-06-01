# LabscriptAI OT

Single plugin bundle for Cursor, Claude Code, and Codex-style agents.

Author: `gaoyuan`

Contact: `gaoyuanbio@qq.com`

Repository: `https://github.com/KRATSZ/labscriptai-ot`

## What It Does

LabscriptAI OT helps AI coding agents write, verify, and safely operate Opentrons OT-2/Flex workflows. It packages the agent-facing parts together so an AI assistant can load one plugin and get:

- `servers/opentrons-mcp/` — Opentrons MCP server.
- `skills/opentrons-*` — seven agent skills.
- `policy/` and `rules/` — safety and workflow summaries.
- `bundled-library/` — L0 Flex templates plus a curated L1 protocol subset.
- `.cursor-plugin/`, `.claude-plugin/`, `.codex-plugin/` — platform manifests.

Live robot actions are opt-in. Simulation is the gate before unattended live use. Vision is optional and observation-only.

## Contact

For questions, collaboration, bug reports, or research use, contact:

```text
gaoyuanbio@qq.com
```

## Citation Requirement

Use of this plugin, the LabscriptAI workflow, the bundled agent design, or substantial derived work requires citation of the LabscriptAI bioRxiv preprint under the repository license:

```bibtex
@article{gao2025labscriptai,
  title = {Autonomous Liquid-handling Robotics Scripting for Accessible and Responsible Protein Engineering},
  author = {Gao, Yuan and Luo, Yizhou and Li, Wenzhuo and Lan, Yunquan and Jiang, Han and Chen, Yongcan and Yi, Xiao and Li, Boyang and Alinejad-Rokny, Hamid and Wang, Teng and Fu, Lihao and Yang, Min and Si, Tong},
  year = {2025},
  doi = {10.1101/2025.09.30.679666},
  publisher = {bioRxiv}
}
```

Paper link: https://doi.org/10.1101/2025.09.30.679666

## License

This repository uses the LabscriptAI Research Citation License v1.0, not MIT. The license permits research, education, evaluation, internal development, and non-commercial use, but citation is mandatory. Commercial use, paid hosted services, sublicensing, or removing the citation requirement requires written permission from `gaoyuanbio@qq.com`.

This is a stricter citation-required research license. It should not be relabeled as MIT in downstream plugin metadata, package registries, or redistributed archives.

## Install

```bash
git clone https://github.com/KRATSZ/labscriptai-ot.git
cd labscriptai-ot
bash install-labscriptai-ot.sh
```

The installer runs `npm install` inside `servers/opentrons-mcp/`.

## Quick Verification

```bash
cd servers/opentrons-mcp
OPENTRONS_PLUGIN_ROOT="$(cd ../.. && pwd)" npm test
OPENTRONS_PLUGIN_ROOT="$(cd ../.. && pwd)" node -e "import('./lib/health-check.js').then(m => console.log(m.buildHealthCheck()))"
```

## Claude Code

This repository includes Claude Code plugin metadata:

- `.claude-plugin/plugin.json`
- `.claude-plugin/mcp.json`
- `.claude-plugin/marketplace.json`

Expected install flow:

```text
/plugin marketplace add KRATSZ/labscriptai-ot
/plugin install labscriptai-ot@labscriptai-ot-marketplace
```

If installing manually, clone the repository and point Claude Code at this repository as a local plugin/marketplace source.

## Codex

Codex metadata:

- `.codex-plugin/plugin.json`
- `.codex-plugin/marketplace.json`
- `.mcp.json`

Use this repository as a local plugin source or package source. The `opentrons-lab` MCP server is configured in `.mcp.json`.

## Cursor

Cursor metadata and project config:

- `.cursor-plugin/plugin.json`
- `.cursor/mcp.json`
- `.cursor/rules/labscriptai-ot.mdc`

For project-level Cursor use, copy these into the consuming project:

```text
.cursor/mcp.json
.cursor/rules/labscriptai-ot.mdc
```

Then adjust paths in `.cursor/mcp.json` if the plugin is not located at `plugins/labscriptai-ot` inside that project.

## AI Usage Pattern

For AI agents, the normal flow is:

1. Use `opentrons-experiment-intent-review` to clarify plate layout, deck slots, pipettes, liquid constraints, and tip strategy.
2. Use `opentrons-protocol-author` to draft or revise Python protocol code.
3. Use the MCP server to validate labware names, estimate tip budget, inspect labware, and simulate locally.
4. Use `opentrons-simulation-repair` when simulation fails.
5. Only after simulation passes, use live-readiness and preflight tools.
6. For real robot work, require explicit operator opt-in.

Do not default to the full external protocol library. The bundled library is small by design. Set `OPENTRONS_PROTOCOL_LIBRARY_PATH` to a full `Protocols-develop` checkout only when needed.

## Safety Rules

- Live robot motion is never enabled by default.
- `OPENTRONS_ENABLE_PROBE_WELLS=1` is required for live probing.
- Vision cannot override committed deck truth.
- Use `reconcile_state` and robot APIs for actual deck state.
- Do not run MCP live control and direct robot HTTP fallback in parallel against the same robot.

Useful environment variables:

- `OPENTRONS_PLUGIN_ROOT` — absolute path to this plugin.
- `PLUGIN_DATA` — writable state/artifact directory.
- `OPENTRONS_PYTHON` — Python interpreter with Opentrons simulation dependencies.
- `OPENTRONS_PROTOCOL_LIBRARY_PATH` — optional external full protocol library.
- `OPENTRONS_ENABLE_PROBE_WELLS=1` — explicit opt-in for live probing only.

Release packaging:

```bash
python3 scripts/build_curated_library.py --limit 40
python3 scripts/package_labscriptai_ot.py
```

See `PUBLISHING.md` for Cursor, Claude Code, and Codex release notes.
