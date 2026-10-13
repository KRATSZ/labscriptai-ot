---
name: opentrons-protocol-verify
description: Local doctor, analyze, simulate, and LogicPass for Opentrons Python protocols without a live robot.
type: script-backed
entry: scripts/verify_protocol.py
mcp_tools:
  - doctor_local_runtime
  - simulate_protocol
  - parse_simulation_output
  - logicpass_check
  - flex3d_preflight_check
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
4. `analyze` — parser and command graph checks.
5. `simulate` — stronger dry run (requires working environment). `simulate_protocol` runs analyze once and caches the JSON.
6. `logicpass_check` — same protocol. `pass` / `fail` / `unevaluable`. A `fail` issue includes `step_index`.
7. `flex3d_preflight_check` — Flex protocols only (OT-2 refused). MuJoCo 3D checks: geometry, liquid, targets, clearance; a failing check carries `command_index` matching the LogicPass `step_index` numbering. Degrades with `error: mujoco_missing` (exit 0) when mujoco is not installed — report as optional-unavailable, not a validation failure. `flex3d_open_viewer` starts the interactive browser view.
8. Pass extra CLI flags after `--`.
9. If iterating until simulation passes -> `opentrons-simulation-repair`.

## Commands

```bash
uv run python scripts/verify_protocol.py preflight path/to/protocol.py
uv run python scripts/verify_protocol.py doctor
uv run python scripts/verify_protocol.py analyze path/to/protocol.py -- --check
uv run python scripts/verify_protocol.py simulate path/to/protocol.py
```

## Limits

Cannot fix missing third-party dependencies or partial Opentrons source snapshots.

Ref: `references/local-runtime.md`
