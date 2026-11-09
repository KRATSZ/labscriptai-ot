---
name: opentrons-protocol-verify
description: Local doctor, analyze, simulate, and LogicPass for Opentrons Python protocols without a live robot.
metadata:
  entry: scripts/verify_protocol.py
---

# Protocol Verify

Use `.venv/bin/python` or `uv run python` for all commands.

## Workflow

1. Run `scripts/verify_protocol.py preflight` for fast static checks (invalid Flex pipette names, apiLevel hints, AST rules: `display_name` length, no `.default_flow_rate`, RTP arg style, literal `transfer` list lengths) — no opentrons import.
   It also checks the standard `dry_run_on` contract: boolean parameter defaults
   off and protocols that declare it include `return_tip()`.
2. Run `scripts/verify_protocol.py doctor` if runtime readiness is unknown.
3. If `doctor` reports broken imports, report the missing prerequisite — do not
   pretend the protocol is validated.
4. Prefer one MCP `simulate_protocol` call: it analyzes once, caches the JSON and returns parsed repair guidance. Do not call it twice or run CLI analyze just to repeat that successful check.
   It also returns `experiment_figure` and inline PNG content automatically. Show the setup image with a local Markdown image embed using `png_path` (or the returned image content), plus its `page_path` for all pages and the per-well table. Do not dump base64 or require an extra plotting command. Preserve the simulation verdict if drawing fails. This first version shows declared initial contents, not final concentrations. Unknown contents remain undeclared.
5. Use the CLI `analyze` / `simulate` commands below only when working without MCP or diagnosing a specific runtime issue.
6. `logicpass_check` — same protocol. `pass` / `fail` / `unevaluable`. A `fail` issue includes `step_index`.
7. `flex3d_preflight_check` — OT-2 and Flex protocols, selected by the analysis robot type (the tool name is retained). OT-2 uses the dedicated analyzer installed with the plugin, overrideable with `OPENTRONS_OT2_PYTHON`. MuJoCo 3D checks: geometry, liquid, targets, clearance; a failing check carries `command_index` matching the LogicPass `step_index` numbering. Degrades with `error: mujoco_missing` (exit 0) when mujoco is not installed — report as optional-unavailable, not a validation failure. `flex3d_open_viewer` starts the interactive browser view.
   The viewer result also includes `experiment_figure.url`; link the animation and setup page together. The animation toolbar has a setup-image link, with PNG and CSV downloads on that page.
8. Pass extra CLI flags after `--`.
9. If iterating until simulation passes -> `opentrons-simulation-repair`.

## Commands

Run from the plugin root, not the consuming project.

```bash
uv run python skills/opentrons-protocol-verify/scripts/verify_protocol.py preflight path/to/protocol.py
uv run python skills/opentrons-protocol-verify/scripts/verify_protocol.py doctor
uv run python skills/opentrons-protocol-verify/scripts/verify_protocol.py analyze path/to/protocol.py -- --check
uv run python skills/opentrons-protocol-verify/scripts/verify_protocol.py simulate path/to/protocol.py
```

## Limits

Cannot fix missing third-party dependencies or partial Opentrons source snapshots.

Ref: `references/local-runtime.md`
