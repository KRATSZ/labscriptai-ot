# Example 01 — Flex serial dilution

End-to-end walkthrough: intent → protocol → local simulation. No live robot required.

## What this demonstrates

- Default orchestration via `opentrons-experiment-run`
- Intent review before coding
- Flex deck layout (trash, tip rack, reservoir, plate)
- Local simulation gate

## Reference template

The bundled L0 template is the starting point:

`bundled-library/l0-flex-templates/flex_template_serial_dilution.py`

This example folder holds a copy you can modify during the walkthrough.

## What you should say

Copy this as your first message:

> Help me run the Flex serial dilution example. Review deck layout and tip policy first, then adapt the bundled serial dilution template for 7 steps along row A with 50 µL transfers, write the protocol, and simulate until it passes.

Shorter variant:

> Author and simulate a Flex serial dilution on row A using the bundled template as reference.

## Expected agent flow

1. **Intent** — Confirm robot (Flex), row A serial dilution, volumes, tip strategy.
2. **Protocol** — Draft from template; load trash on Flex; standard labware names.
3. **Simulation** — `doctor_local_runtime` → `simulate_protocol` → `parse_simulation_output`.
4. **Status** — Agent emits [output-contract](../../policy/output-contract.md) JSON with `"phase": "simulation"`.

## Prerequisites

- Plugin installed: [GETTING_STARTED.md](../../docs/GETTING_STARTED.md)
- `node scripts/verify-setup.mjs` — MCP checks pass
- Python with opentrons recommended for simulation (warnings OK without it, but sim will fail)

## Files in this folder

| File | Purpose |
|------|---------|
| `README.md` | This guide |
| `protocol.py` | Example protocol (copy of bundled template) |

## If simulation fails

See [runbooks/simulation-fails.md](../../docs/runbooks/simulation-fails.md).

## Next steps

- Live preflight (requires robot IP): ask *"Run live_readiness_check before executing on the robot."*
- More examples: [examples/README.md](../README.md)
