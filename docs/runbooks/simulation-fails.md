# Simulation fails — runbook

When `simulate_protocol` or `parse_simulation_output` reports failure, stay in the simulation/repair loop. **Do not proceed to live execution.**

See also: [GLOSSARY.md](../GLOSSARY.md), [policy/error-response.md](../../policy/error-response.md), skill `opentrons-simulation-repair`.

## Diagnostic sequence

```
doctor_local_runtime → simulate_protocol → parse_simulation_output
```

If `doctor_local_runtime` fails first, fix Python/opentrons before debugging the protocol.

## Common errors and fixes

| Symptom / category | Typical cause | Fix |
|--------------------|---------------|-----|
| `RUNTIME_UNAVAILABLE` / doctor fails | No Python or opentrons | Set `OPENTRONS_PYTHON`; `uv sync --extra protocol` |
| `SYNTAX_OR_IMPORT` | Python syntax, missing import | Fix protocol source; check API level |
| `API_MISUSE` | Wrong API for robot type or version | Match `requirements` to Flex vs OT-2; check apiLevel |
| `LABWARE_OR_MODULE_COMPAT` | Unknown or wrong load name | `validate_labware_name`, `inspect_labware_definition` |
| `MISSING_TRASH_OR_SETUP` | Flex trash not loaded | Add `protocol.load_trash_bin(...)` on Flex |
| `VOLUME_OR_RANGE_VIOLATION` | Transfer exceeds pipette/well limits | Reduce volumes; check `estimate_tip_budget` warnings |
| `OUT_OF_TIPS` | More transfers than tip capacity | Add tip racks or reduce steps |
| Deck / slot errors | Labware on invalid slot | Flex vs OT-2 deck maps differ; verify slot names |
| Parameter errors | Runtime parameters out of range | Adjust `add_parameters` defaults or user inputs |

## Repair loop

1. Read structured output from `parse_simulation_output` (`error_domain`, `error_leaf`, `default_next_step`).
2. Apply minimal fix via `opentrons-protocol-author` or direct edit.
3. Re-run simulation until `status: passed`.
4. Emit [output-contract](../../policy/output-contract.md) JSON with `"phase": "simulation"`.

## When to escalate

- Repeated `UNKNOWN_NEEDS_HUMAN` after two repair attempts
- Errors that imply physical deck state (`DECK_COLLISION`) — simulation only; do not “fix” with live motion
- Module or hardware requirements not modeled in simulation — confirm with operator before live preflight

## Environment checklist

- [ ] `node scripts/verify-setup.mjs` passes MCP checks
- [ ] `OPENTRONS_PYTHON` imports `opentrons`
- [ ] Protocol `requirements.robotType` matches target hardware
- [ ] Custom labware JSON paths included if used

## Related

- Example walkthrough: [examples/01-flex-serial-dilution](../../examples/01-flex-serial-dilution/README.md)
- MCP tools: [MCP_TOOLS.md](../MCP_TOOLS.md) (L0 tier)
