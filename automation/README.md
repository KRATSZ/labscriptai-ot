# Lab hardware helpers

Operational artifacts from live Flex work — not part of the plugin core.

| Path | Purpose |
|------|---------|
| `labware/` | Third-party PE tip rack definitions (`custom_beta`) and generator |
| `verify_pe_tip_pickup.py` | Dry-run protocol to validate custom tip rack pickup |
| `verify_c1_offset.py` | Dry-run protocol to validate temperature-module offset on C1 |

See [docs/custom-labware-guide.md](../docs/custom-labware-guide.md). Offset helper: `node scripts/verify-c1-offset-run.mjs`.
