# Runbook: Flex `probe_wells` live validation

Validate Opentrons Flex **Liquid Presence Detection (LPD)** on real hardware before relying on it in recovery or pre-run workflows.

## Prerequisites

- Opentrons Flex with apiLevel **≥ 2.24**
- Conductive Flex tips loaded on deck
- Source well contains a conductive aqueous liquid (e.g. water in `nest_12_reservoir_15ml` well A1)
- MCP server running (`health_check` → `required_runtime_tools.all_present=true`)
- Operator available for explicit live-motion confirmation

## Safety

- Live probe motion is **opt-in only**. Set `OPENTRONS_ENABLE_PROBE_WELLS=1` in the MCP server environment.
- Always simulate first (`execute_on_robot=false`). Do not live-probe if simulation fails.
- `probe_wells` generates a temporary protocol that picks up tips, probes, and drops tips — no aspirate/dispense of sample liquid.

## Step 1 — Simulate locally

Call MCP `probe_wells` with:

| Parameter | Example |
|-----------|---------|
| `pipette_name` | `flex_1channel_1000` |
| `mount` | `left` |
| `tiprack_load_name` | `opentrons_flex_96_tiprack_1000ul` |
| `tiprack_slot` | deck slot of tip rack |
| `labware_load_name` | `nest_12_reservoir_15ml` |
| `labware_slot` | deck slot of source labware |
| `wells` | `["A1"]` |
| `mode` | `detect_presence` (then repeat for other modes) |
| `execute_on_robot` | `false` |

Confirm `parsed_simulation_output.success=true`.

## Step 2 — Enable live probe

1. Confirm deck layout matches parameters above (`reconcile_state`, `robot_status`).
2. Set environment variable on MCP host: `OPENTRONS_ENABLE_PROBE_WELLS=1`
3. Reload MCP client if the server was already running.

## Step 3 — Live probe

Re-run `probe_wells` with:

- `execute_on_robot=true`
- `robot_ip=<flex-ip>`
- `session_id=<your-session>`
- `auto_apply_to_session=true` (recommended — writes results to session state)

## Step 4 — Verify results

Check `probe_results` in the tool response:

```json
{"well":"A1","mode":"detect_presence","success":true,"value":true}
```

| Mode | Expected `value` |
|------|------------------|
| `detect_presence` | `true` if liquid present, `false` if empty |
| `require_presence` | `true` when liquid present; run fails if empty |
| `measure_height` | positive number (mm from well top) when liquid present |

If `auto_apply_to_session=true`, confirm `apply_liquid_probe_results.applied_count ≥ 1` and call `get_liquid_source_map` to see `observed_presence` / `observed_height_mm`.

## Step 5 — Recovery gate

```
live_liquid_recovery_gate (session_id, robot_ip)
```

Gate should pass when observed presence matches expected sources, or provide actionable `allowed_next_tools` (`probe_wells`, `apply_liquid_probe_results`).

## Troubleshooting

| Symptom | Likely cause | Action |
|---------|--------------|--------|
| `Live probe_wells execution is disabled` | Missing env flag | Set `OPENTRONS_ENABLE_PROBE_WELLS=1` |
| Simulation pass, live false negative | Non-conductive tips or empty well | Verify tips and source volume |
| `measure_height` returns unexpected values | Foam, volatile liquid, wrong labware definition | Try aqueous water first; document liquid class |
| Attached tip blocks rerun | Prior run left tip on pipette | Drop tip manually or use recovery tooling before reprobe |
| Gate still blocked after apply | `expected_presence` mismatch | Review `get_liquid_source_map`; update source map or re-probe |

## Record results

Archive a dated note under `runs/liquid-probe/` with:

- Robot serial / software version
- apiLevel, pipette, tip type, labware
- Three mode results (detect / require / measure)
- Gate outcome after `apply_liquid_probe_results`

## Related

- MCP tools: `probe_wells`, `apply_liquid_probe_results`, `live_liquid_recovery_gate`
- Workflow: [policy/workflows.md](../../policy/workflows.md) — *Optional Flex liquid probe*
- Authoring: [liquid-presence-detection-flex.md](../../skills/opentrons-protocol-author/references/liquid-presence-detection-flex.md)
