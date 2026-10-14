---
name: opentrons-robot-lan
description: Fallback HTTP API when MCP is unavailable — direct LAN access to OT-2 or Flex robot.
type: script-backed
entry: scripts/opentrons_robot_api.py
mcp_tools:
  - robot_status
  - robot_status
  - reconcile_state
  - run_protocol
  - safe_next_action(detail=full)
  - is_home_safe
  - camera_settings(action=status)
  - capture_image(mode=preview)
---

# Robot LAN (MCP-absent fallback)

MCP is primary path. This skill's scripts are fallback when MCP is not wired.

## MCP Tool Order (when available)

`robot_status` -> `robot_status` -> `reconcile_state` ->
`deck_slots(action=occupation)` / `tip_wells(action=list)` / `is_home_safe` ->
`create_run_context` ->
command tools (`load_pipette`, `load_labware`, `load_module`,
`control_module(module_type=temperature)`, `control_module(module_type=heater_shaker)`, `control_module(module_type=thermocycler)`,
`move_labware`, `cleanup_motion`) ->
camera tools (`camera_settings(action=status)`, `capture_image(mode=preview)`, `capture_image(mode=run)`,
`data_files(action=list)`, `data_files(action=download)`, `deck_vision_check(mode=local)`, `analyze_image(provider=ark)`, `analyze_image(provider=kimi)`) ->
`query_history(scope=run_commands)` / `query_history(scope=experiment_logs)` -> `suggest_recovery_action`

## Key Rules

- After MCP/host restart: `safe_next_action(detail=full)` first, follow `guidance.suggested_tool_order`.
  If `reconcile_first`: run `reconcile_state` before other motion.
- For full protocol runs: `run_protocol` (simulation gate runs before play).
- For protocol execution without MCP: upload -> analyze -> create-run -> run-action.
- `DESTINATION_OCCUPIED`: follow `suggest_recovery_action`. In protocol recovery,
  treat alternative destinations as human-reviewed. Outside recovery, only
  `execute_protocol_recovery` with explicit slot.
- Before `home`: use `is_home_safe`.
- `probe_wells` = experimental. Simulate first. Live use still requires
  `OPENTRONS_ENABLE_PROBE_WELLS=1` + explicit opt-in, but fold that into the
  single go-live / `run_protocol` confirmation — do not stack a separate chat
  confirm after every preflight subgate when tools already returned `passed`.
- Preview images: save to file, reference path in response.
- Do not infer liquid state from camera output without separate analysis.

## Fallback Commands (no MCP)

### Connection management

```bash
# Save connection for reuse (--host is optional afterwards)
uv run python scripts/opentrons_robot_api.py --host 192.168.1.50 save-connection
# Show saved connection (token is redacted)
uv run python scripts/opentrons_robot_api.py show-connection
```

### One-shot deploy and run

```bash
# Upload → analyze → create run → play (single command)
uv run python scripts/opentrons_robot_api.py deploy-and-run protocol.py
```

### Labware search

```bash
# Search labware definitions by keyword (local-only, no host needed)
uv run python scripts/opentrons_robot_api.py search-labware "PCR full skirt"
uv run python scripts/opentrons_robot_api.py search-labware "reservoir" --limit 10
```

### Run monitoring

```bash
# Smart monitoring: only outputs on status change, exits on terminal
uv run python scripts/opentrons_robot_api.py watch-run <run-id> --interval 30 --timeout 1800
```

### Deck check

```bash
# Compare protocol declarations vs live robot deck before running
uv run python scripts/opentrons_robot_api.py --host 192.168.1.50 deck-check protocol.py
```

### Legacy commands (still available)

```bash
uv run python scripts/opentrons_robot_api.py health                       # uses saved connection
uv run python scripts/opentrons_robot_api.py get-camera
uv run python scripts/opentrons_robot_api.py upload-protocol path/to/protocol.py
uv run python scripts/opentrons_robot_api.py analyze-protocol <protocol-id>
uv run python scripts/opentrons_robot_api.py create-run --protocol-id <protocol-id>
uv run python scripts/opentrons_robot_api.py run-action <run-id> play
```

Ref: `references/http-api.md`
