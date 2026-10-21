# LabscriptAI OT Glossary

Shared vocabulary for operators and agents. For workflow order, see [policy/workflows.md](../policy/workflows.md).

| Term | Meaning |
|------|---------|
| **Deck truth** | The recorded deck layout. Compare it with current robot readings and the operator’s setup; use `reconcile_state` when they differ. A camera guess does not silently change the record. |
| **Simulate gate** | Local simulation checks whether the protocol can run. Fix simulation errors before live execution. LogicPass adds liquid-volume checks by default; the operator can explicitly skip that extra check for a run/test. |
| **Live readiness** | Read-only preflight (`live_readiness_check`) combining environment health, session state, robot/module status, and optional protocol deck diff. Distinct from `health_check`, which probes the developer environment only. |
| **reconcile_state** | Compares persisted session deck state with live hardware and run context, then proposes or persists a reconciliation snapshot. Run when deck layout may have drifted or after restarts. |
| **Tip policy** | Rules for tip usage: rack count, low-volume transfer warnings, out-of-tips handling. Often set during intent review (`opentrons-experiment-intent-review`) and checked with `estimate_tip_budget`. |
| **dry_run_on** | Protocol runtime switch for a liquid-free physical motion test. When enabled, each tip is returned to its original rack position instead of discarded. Returned tips remain used/potentially contaminated; replace or segregate the rack before a wet run. Default is off. |
| **Session state** | Persisted bookkeeping under `PLUGIN_DATA` (runs, deck commits, recovery hints). Historical logs are audit-only, not live deck truth. |
| **Opt-in live** | Run physical actions when the user has authorized them. Reuse that permission for the unchanged action. `OPENTRONS_ENABLE_PROBE_WELLS=1` enables live probing only; an ordinary run without probing does not need it. |
| **HumanConfirmBudget** | Ask once for the action that needs permission; do not keep asking as checks complete. Respect named checks the operator chose to skip for that run. |
| **Probe wells** | Optional liquid-level/presence check. Live probing needs `OPENTRONS_ENABLE_PROBE_WELLS=1`; skipped probing does not block an ordinary run. Save observations via `apply_liquid_probe_results`. |
| **Liquid source map** | Operator-confirmed session bookkeeping for which liquid/sample is expected in a source well. It helps recovery messages preserve sample identity; it does not authorize automatic source-well substitution. |
| **Runtime recovery monitor** | L1-L4 active monitor tick that combines runtime self-test, robot/module status, run watching, safe-next guidance, liquid gates, and guarded L0 self-fix status. Default observe mode is read-only for run watching. |
| **Recovery playbook** | Registered fixed recovery contract exposed by `list_recovery_playbooks`: executor tool, watch-mode permission, motion boundary, required gates, and semantic invariants. Agents must not invent live recovery actions outside this registry. |
| **Vision (observation-only)** | Camera capture and `deck_vision_check(mode=local)` (YOLO) provide hints about deck appearance. Default preflight may run `deck_vision_check` (YOLO first, Ark VLM second opinion). Never deck truth — compare with `reconcile_state`. Sensor-aligned agreement → pass; uncertainty → auto-reconcile before human. |
| **Preflight subphases** | Read the robot state, optionally inspect the deck, optionally probe selected wells, then run. These labels organize work; they do not make every optional step mandatory. |
| **Recovery channel** | Routing hint from `suggest_recovery_action`: `dashboard` (门/模块), `vision` (台面), `reconcile` (会话/状态对齐), `manual` (碰撞等硬停), `slot_confirm` (槽位人工确认), `probe` (液体), `tip` (tip 缺失). |
| **Quiet execution** | During `run_protocol` / runtime watch, do not call vision or probe unless recovery routing requires it. |
| **Preflight** | `preflight_run_setup` verifies reconciliation, robot readiness, and (Flex) declared protocol loads vs live deck before play. |
| **Recovery branch** | Structured fix path from `suggest_recovery_action` (e.g. retry tip pickup). Only `auto_executable` branches may run via `execute_protocol_recovery` without human review. |
| **Bundled library** | Small curated protocol set in `bundled-library/`. Set `OPENTRONS_PROTOCOL_LIBRARY_PATH` for a full external catalog. |
| **Custom labware (`custom_beta`)** | Third-party consumables defined via Agent-generated JSON in `automation/labware/`. See [custom-labware-guide.md](custom-labware-guide.md). |
| **PLUGIN_DATA** | Writable directory for session artifacts, logs, and captured images. Defaults to `data/` in the stable LabscriptAI user directory; an explicit path keeps its existing location. |
| **OPENTRONS_PLUGIN_ROOT** | Absolute path to this repository. Required for MCP path resolution when the server is not in the default layout. |
| **OPENTRONS_PYTHON** | Python interpreter with `opentrons` simulation dependencies. Without it, simulate tools will warn or fail. |
| **LAN fallback** | Direct robot HTTP via `opentrons-robot-lan` skill. Do not use in parallel with MCP live control on the same robot. |
| **safe_next_action** | Single-call operator summary after MCP/host restart: recommended next tool and numbered steps. |
| **Hard stop** | An actual collision, hardware fault or similar runtime stop that needs review before more motion. An unavailable optional check or unsupported analysis is not such a fault. |

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
