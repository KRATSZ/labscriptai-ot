# LabscriptAI OT Glossary

Shared vocabulary for operators and agents. For workflow order, see [policy/workflows.md](../policy/workflows.md).

| Term | Meaning |
|------|---------|
| **Deck truth** | The committed, authoritative deck layout for a session — what the agent and robot APIs believe is on each slot. Vision and guesses do not override deck truth; use `reconcile_state` and robot APIs to update it. |
| **Simulate gate** | Mandatory local simulation (`doctor_local_runtime` → `simulate_protocol` → `parse_simulation_output`) before unattended live execution. Simulation failure blocks live runs. |
| **Live readiness** | Read-only preflight (`live_readiness_check`) combining environment health, session state, robot/module status, and optional protocol deck diff. Distinct from `health_check`, which probes the developer environment only. |
| **reconcile_state** | Compares persisted session deck state with live hardware and run context, then proposes or persists a reconciliation snapshot. Run when deck layout may have drifted or after restarts. |
| **Tip policy** | Rules for tip usage: rack count, low-volume transfer warnings, out-of-tips handling. Often set during intent review (`opentrons-experiment-intent-review`) and checked with `estimate_tip_budget`. |
| **dry_run_on** | Protocol runtime switch for a liquid-free physical motion test. When enabled, each tip is returned to its original rack position instead of discarded. Returned tips remain used/potentially contaminated; replace or segregate the rack before a wet run. Default is off. |
| **Session state** | Persisted bookkeeping under `PLUGIN_DATA` (runs, deck commits, recovery hints). Historical logs are audit-only, not live deck truth. |
| **Opt-in live** | Physical robot motion requires explicit operator confirmation. Tools like `run_protocol` and `probe_wells` do not run unattended by default. |
| **Probe wells** | Experimental liquid-presence helper. Live motion requires `OPENTRONS_ENABLE_PROBE_WELLS=1` and operator sign-off. |
| **Vision (observation-only)** | Camera capture and `vision_check` provide hints about deck appearance. Never treat vision output as committed deck truth — always compare with `reconcile_state`. |
| **Preflight** | `preflight_run_setup` verifies reconciliation, robot readiness, and (Flex) declared protocol loads vs live deck before play. |
| **Recovery branch** | Structured fix path from `suggest_recovery_action` (e.g. retry tip pickup). Only `auto_executable` branches may run via `execute_protocol_recovery` without human review. |
| **Bundled library** | Small curated protocol set in `bundled-library/`. Set `OPENTRONS_PROTOCOL_LIBRARY_PATH` for a full external catalog. |
| **Custom labware (`custom_beta`)** | Third-party consumables defined via Agent-generated JSON in `automation/labware/`. See [custom-labware-guide.md](custom-labware-guide.md). |
| **PLUGIN_DATA** | Writable directory for session artifacts, logs, and captured images. Defaults to `.plugin-data` under the plugin root. |
| **OPENTRONS_PLUGIN_ROOT** | Absolute path to this repository. Required for MCP path resolution when the server is not in the default layout. |
| **OPENTRONS_PYTHON** | Python interpreter with `opentrons` simulation dependencies. Without it, simulate tools will warn or fail. |
| **LAN fallback** | Direct robot HTTP via `opentrons-robot-lan` skill. Do not use in parallel with MCP live control on the same robot. |
| **safe_next_action** | Single-call operator summary after MCP/host restart: recommended next tool and numbered steps. |
| **Hard stop** | Non-negotiable failure (e.g. deck collision, unknown error) requiring human intervention before resume. |

## Tool tier shorthand

MCP tools are grouped L0–L4 in [MCP_TOOLS.md](MCP_TOOLS.md):

- **L0** — Local simulation and environment (start here)
- **L1** — Authoring helpers (labware, tips, preflight)
- **L2** — Live read-only robot status
- **L3** — Live control (opt-in)
- **L4** — Recovery and vision (on demand)

## See also

- [GETTING_STARTED.md](GETTING_STARTED.md) — install and first command
- [custom-labware-guide.md](custom-labware-guide.md) — add and use third-party labware (e.g. PE tip racks)
- [runbooks/simulation-fails.md](runbooks/simulation-fails.md) — common sim errors
- [policy/output-contract.md](../policy/output-contract.md) — agent status JSON template
