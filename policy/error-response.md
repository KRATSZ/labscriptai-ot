# Error response (canonical)

This file is the **single source of truth** for the MCP error taxonomy, recovery action contract, and live-recovery invariants.

## Canonical taxonomy fields

Every structured error emitted by `simulate_protocol`, `parse_error`, `suggest_recovery_action`, blocked `run_protocol` payloads, and `preflight_run_setup` checks should use these fields:

- `phase`
- `error_domain`
- `error_leaf`
- `severity`
- `recoverability`
- `requires_human_review`
- `auto_executable`
- `default_next_step`
- `evidence_sources`

Compatibility fields such as `error_category`, `hard_stop`, and `escalate_to_human` remain valid.

## Canonical leaf tree

| Domain | Leaves |
|--------|--------|
| `environment` | `RUNTIME_UNAVAILABLE`, `PYTHON_ENV_BROKEN`, `MCP_CONFIG_MISMATCH` |
| `protocol` | `SYNTAX_OR_IMPORT`, `API_MISUSE`, `LABWARE_OR_MODULE_COMPAT`, `MISSING_TRASH_OR_SETUP`, `VOLUME_OR_RANGE_VIOLATION`, `OUT_OF_TIPS` |
| `session_state` | `SESSION_NEEDS_RECONCILIATION`, `STALE_LAST_RUN`, `RUN_NOT_AWAITING_RECOVERY` |
| `robot_state` | `ROBOT_UNREACHABLE`, `DOOR_OPEN`, `ESTOP_ENGAGED`, `INSTRUMENT_NOT_READY` |
| `module_state` | `MODULE_NOT_READY` |
| `deck_state` | `DESTINATION_OCCUPIED`, `DESTINATION_UNAVAILABLE`, `LABWARE_MISMATCH`, `SLOT_NOT_ADDRESSABLE` |
| `motion_or_liquid` | `DECK_COLLISION`, `TIP_PHYSICALLY_MISSING`, `TIP_CLOG`, `INSUFFICIENT_VOLUME`, `AIR_BUBBLE`, `LIQUID_PROPERTY_ERROR` |
| `unknown` | `UNKNOWN_NEEDS_HUMAN` |

## Recovery action contract

`suggest_recovery_action` must always return one of these actionability states:

| `actionability` | Meaning |
|-----------------|---------|
| `auto_executable` | `execute_protocol_recovery` can run the branch immediately with the current guidance. |
| `manual_confirmation_required` | `execute_protocol_recovery` supports the branch, but the operator must confirm and/or supply required inputs first. |
| `manual_only` | No supported automatic branch exists; the operator must intervene. |
| `protocol_edit_required` | Return to the simulation/edit loop instead of attempting runtime recovery. |

`execute_protocol_recovery` only accepts guidance with `auto_executable: true`.

Runtime recovery actions should also map to a registered fixed playbook exposed by
`list_recovery_playbooks`. The registry records the executor tool, watch-mode
permission, motion boundary, required gates, and semantic invariants. If an
error cannot be mapped to a registered playbook, stop at `safe_next_action` or
human review instead of inventing a new live action.

### Supported `execute_protocol_recovery` branches

1. `retry_pick_up_tip_with_next_candidate`
2. `suggest_new_destination_slot` after explicit human confirmation and supplied `destination_slot`
3. `wait_and_poll_module_status`
4. `reconcile_state_first` when reconciliation diffs are module-blocker-only

`retry_pick_up_tip_with_next_candidate` is only valid when the protocol source classifies as
automatic tip binding (`pick_up_tip()` or high-level automatic tip handling). Explicit tip
locations and `starting_tip` state require a continuation protocol path instead of same-run
auto-resume.

### Runtime watch autonomy

`runtime_watch(mode=poll)` is narrower than `execute_protocol_recovery`. It may auto-execute only L0 branches, in this order:

1. L4 hard stop: `hard_stop`, `HARDWARE_FAULT`, `DECK_COLLISION`, `ESTOP_ENGAGED`, `DOOR_OPEN`, or `UNKNOWN` -> write alert and stop.
2. L3 human review: `escalate_to_human` or `requires_confirmation` -> write alert only.
3. L0 self-fix: `auto_executable: true`, run status is `awaiting-recovery`, attempt queue allows it, and action is one of:
   - `retry_pick_up_tip_with_next_candidate`
   - `wait_and_poll_module_status`
   - `reconcile_state_first` for module-blocker-only diffs

`runtime_watch(mode=poll)` must not auto-execute `suggest_new_destination_slot`, even when candidates look high-confidence. Destination recovery remains human-reviewed.

Liquid source-map entries are operator-confirmed bookkeeping only. They may be included in
`INSUFFICIENT_VOLUME` recovery guidance to preserve liquid/sample identity, but they do not
authorize automatic source-well substitution or automatic resume.

### Manual-only examples

- `INSUFFICIENT_VOLUME`
- `AIR_BUBBLE`
- `TIP_CLOG`
- `LIQUID_PROPERTY_ERROR`
- `DECK_COLLISION`
- `UNKNOWN_NEEDS_HUMAN`
- `DESTINATION_OCCUPIED` outside `awaiting-recovery`

### Protocol-edit-required examples

- `MISSING_TRASH_OR_SETUP`
- `SYNTAX_OR_IMPORT`
- `API_MISUSE`
- `LABWARE_OR_MODULE_COMPAT`
- `VOLUME_OR_RANGE_VIOLATION`
- `OUT_OF_TIPS` when discovered in simulation
- `TIP_PHYSICALLY_MISSING` in an explicit-tip or `starting_tip` protocol, until the validated
  continuation-protocol generator is available

## Hard-stop policy

These remain non-negotiable:

1. `HARDWARE_FAULT`, `DECK_COLLISION`, and `UNKNOWN` compatibility categories are hard stops.
2. `collision` / `unknown` class failures do **not** auto-resume.
3. `DESTINATION_OCCUPIED` inside protocol recovery stays human-reviewed even when candidate slots look safe.

## Live readiness

Use `live_readiness_check` as the read-only gate before `create_run` or `play`.

- `health_check` is a developer/environment check.
- `live_readiness_check` is the operator-facing live gate.
- `preflight_run_setup` remains the final protocol-aware check before play.

**HumanConfirmBudget (go-live):** Phase 3a/3b/3c machine outcomes do not each require a verbal human confirm. Recovery `manual_confirmation_required` / destination human-review still apply inside the recovery pipeline and are separate from stacking preflight subgate confirms. Before any physical motion, including live probing, require authorization covering that action and a person at the robot. One prompt may cover selected probing and the planned run, including named software-check waivers — see [output-contract.md](output-contract.md).

Current rollout is **Flex-first**. OT-2 deck-diff modeling is still explicitly skipped in this build; OT-2 support should not be implied by the new taxonomy alone.

## Recovery trigger routing

After `parse_error` → `suggest_recovery_action`, agents must follow `recovery_channel`:

| Channel | Meaning | Typical error leaves | First tools |
|---------|---------|----------------------|-------------|
| `dashboard` | 仪表盘 — door/estop/module/session | DOOR_OPEN, ESTOP_ENGAGED, MODULE_NOT_READY, ROBOT_UNREACHABLE | robot_status, live_readiness_check |
| `vision` | 眼睛 — deck appearance / layout doubt | LABWARE_MISMATCH, DESTINATION_UNAVAILABLE, SLOT_NOT_ADDRESSABLE | deck_vision_check, reconcile_state |
| `reconcile` | 状态对齐 — session/state mismatch | SESSION_NEEDS_RECONCILIATION, STATE_MISMATCH | reconcile_state first (not camera/VLM-first) |
| `manual` | 人工硬停 — collision / no safe auto path | DECK_COLLISION (hard-stop; does **not** enter vision) | stop; physical check; live_readiness_check |
| `probe` | 手指 — liquid presence/volume doubt | INSUFFICIENT_VOLUME, AIR_BUBBLE, LIQUID_PROPERTY_ERROR | live_liquid_recovery_gate, targeted probe_wells |
| `tip` | tip-level recovery | TIP_PHYSICALLY_MISSING | recover_tip_pickup |

`suggest_recovery_action` returns `recovery_channel`, `recovery_channel_label`, `recommended_next_tools`, and `channel_rationale`. Do not call vision during quiet execution unless recovery routing selects the vision channel.

After door/module recovery, re-run Phase 3a dashboard before resume. Deck appearance doubt → vision channel. `SESSION_NEEDS_RECONCILIATION` → reconcile-first. `DECK_COLLISION` → hard-stop/manual (no vision). Liquid doubt → probe channel only (no VLM).

## Agent FIX/STOP decision gates

Use the following defaults to choose a practical recovery. Distinguish physical faults from experiment-quality choices. Respect the operator’s explicit recovery plan and previously accepted limitations; do not describe their request as pressure or demand repeated confirmation.

| Gate | STOP when | FIX when |
|------|-----------|----------|
| Tip budget | Too few tips to finish the requested scope | Refill, use an agreed shorter protocol, or recover pickup when the remaining budget permits |
| Time / hold window | A specified time limit was exceeded and no continuation choice is known | Explain the quality limitation; continue if already accepted, or offer re-preparation / discard |
| Contamination | The next step conflicts with the agreed tip/contamination policy | Default to a fresh tip for common stock; follow an explicitly selected reuse plan without silently changing it |
| Partial dispense | The delivered amount is unknown and the next step depends on it | Explain the unknown amount; use a measured amount or an explicit operator recovery choice, not a guessed top-up |
| Waste / discard clog | Cleanup collision / tip budget exhausted | Drop clogged tip safely → fresh tip → retry discard only |
| Source empty | No usable source for the remaining requested transfers | Refill, use an approved same-liquid reserve, or revise the run scope; keep sample identity correct |

**Tip recovery invariant:** Do not call `recover_tip_pickup` solely because the next candidate well looks free. Re-check tip budget against remaining protocol pickups first (`tip_wells(action=list)` / `estimate_tip_budget` / rack bookkeeping).

**Resume:** Check the interruption and current state, then use the agreed continuation plan. If a time/quality limitation was already explicitly accepted for this scope, do not ask again.

**Substitution:** A recorded source map alone does not authorize changing wells. Use the operator’s approved reserve plan, including permission already given. If the reserve is short, offer refill or a shorter scope.

**Cleanup invariant:** Maintenance `drop_attached_tip` defaults to trash-centered drop (`alternate_drop_location=false`). Stall/collision during cleanup remains a hard stop.

## Phase 2 / Phase 4 invariants

These rules are implemented in `servers/opentrons-mcp/` and covered by tests under `servers/opentrons-mcp/test/`.

1. **Local simulation is blocking.** Run `health_check(scope=local)` → `simulate_protocol`. LogicPass is the default additional check; an explicit operator waiver uses `run_protocol(skip_logicpass_gate=true)` and records skipped, never passed. Optional probing does not gate an ordinary run; see [safety-policy.md](safety-policy.md#operator-selected-checks).
2. **Reconciliation beats history.** When session state says `needs_reconciliation`, reconcile before autonomous motion even if historical logs show success.
3. **Result logs stay audit-only.** `query_history(scope=experiment_logs)` is narrative evidence, not live deck truth.

## See also

- Simulation failures: [simulation-fails.md](../docs/runbooks/simulation-fails.md)
- MCP startup: [mcp-wont-start.md](../docs/runbooks/mcp-wont-start.md)
- Workflow sequences: [workflows.md](workflows.md)
- Safety policy: [safety-policy.md](safety-policy.md)
