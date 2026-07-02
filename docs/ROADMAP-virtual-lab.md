# Roadmap — Virtual Lab State & Auto-Wake

This roadmap supersedes the earlier handoff that described the Virtual Lab State as a prototype with five open gaps. An audit of `servers/opentrons-mcp/lib/state.js`, `lib/decision.js`, and `lib/runtime-watch/` showed that Phase V1 was already implemented and tested. This document records the real state of progress and the remaining work.

## Background

`labscriptai-ot` is an Opentrons (Flex/OT-2) protocol-authoring, simulation, and safe runtime-assistance plugin. The pipeline is `intent → protocol-author → simulate gate → opt-in live execution → runtime recovery`. Its strongest asset is the runtime recovery layer (structured error classification, fixed recovery playbooks, read-only gates, `reconcile_state`, liquid source map, audit artifacts). A Virtual Lab State layer (`lib/state.js` persistent session state + `lib/live-state.js` live snapshot) underpins it.

## What is already done (verified in code)

### Phase V1 — Virtual Lab State (complete + tested)

- **V1.1 Quantitative volume + trust enum.** `LIQUID_TRUST_LEVELS = ["declared","simulated","observed","reconciled"]`; containers carry `volume_ul / capacity_ul / dead_volume_ul / liquid_class`. (`lib/state.js`)
- **V1.2 Sources generalized to containers.** `liquid_tracking.containers` is the canonical store; `sources` is a backward-compatible read view filtered by `role==="source"`. Legacy `sources` JSON is upgraded on read. (`lib/state.js`, `normalizeLiquidTracking`)
- **V1.3 `applyStep` + deterministic checks.** `applyStep(state, step) -> {state, violations[]}` and `validateVirtualLabStateSteps` sequence runner. Checks: `liquid_volume_exceeds_capacity`, `aspirate_exceeds_available_volume` (volume − dead), `tip_reuse_violation`, `missing_attached_tip`, `missing_required_prerequisite`, `missing_required_field`, `unsupported_step_type`. Exposed as `validate_virtual_lab_state_steps` (L2, no robot motion).
- **V1.4 Append-only `state_history`.** `appendStateHistoryEntry({step, field, oldValue, newValue, why, trustLevel})` records every container-field change; capped at `MAX_STATE_HISTORY_ENTRIES = 2000` (newest kept).
- **V1.5 `reconcile_state` compares volume + trust.** `compareLiquidTracking` emits `liquid_volume_mismatch` (>0.1 uL) and `liquid_trust_mismatch` diffs; commits with `trust_level="reconciled"`. (`lib/decision.js`)

### Phase 1.5 — Virtual Lab State as a simulation gate (complete + tested)

`simulate_protocol` now runs the Virtual Lab State gate before spawning Python when `virtual_lab_steps` (or `validate_virtual_lab_state=true`) is supplied. On violation it returns `blocked_by: "virtual_lab_state_validation"` with `no_robot_motion: true` and never starts the simulator. `skip_virtual_lab_state_validation=true` is the explicit escape hatch for the simulation-repair loop.

### Phase 1.6 — Broader `applyStep` coverage (complete + tested)

Added `mix`, `blow_out`, `load_labware`, `load_pipette`, and no-op handling for `comment / pause / air_gap / touch_tip / moveToAddressableArea / module actions`. Added `auto_declare` (auto-creates missing source/target containers with unknown volume) and `strict_volumes` (restores the missing-volume prerequisite error). Unknown volumes now skip the volume check by default; declared volumes are still enforced.

### Phase Q2 — Auto-wake loop (complete + tested)

`runtime_watch_loop` (`lib/runtime-watch/watch-loop.js`) wraps `runtime_watch_poll` on a budgeted schedule (`max_turns`, `max_runtime_ms`, `interval_ms`), persists `goal-state.json` per run, emits one outbox sentinel per tick (deliverable to `claudecode/cursor/codex/cli/webhook`), and returns `goal_status` ∈ {`COMPLETE`, `BLOCKED`, `BUDGET_LIMITED`}. `COMPLETE` requires a `completed` tick or the verify callback. It inherits the L0–L4 safety model: only L0 whitelist fixes auto-execute; `needs_user`/`hard_stop` stop the loop. Default `self_fix_mode=observe`; guarded L0 self-fix requires `allow_l4_execution=true` + `operator_opt_in=true`. The `opentrons-experiment-goal` prompt-only skill documents the agent protocol.

This is the `/loop` + `/goal` pattern, but the goal runtime lives in the MCP server (state, verify, budget, levels, hard-stop, multi-backend outbox) — not faked in a Skill + CLI. The host IDE watches its adapter outbox file and wakes the agent on each sentinel.

### Phase V1.7 — Trust monotonicity guard (complete + tested)

- **Goal.** Prevent lower-trust volume writes (e.g. `simulated` absolute) from overwriting higher-trust container state (`observed`, `reconciled`). Delta-mode aspirate/dispense may derive a capped trust level but must not silently downgrade committed observations.
- **Key files.** `lib/state.js` (`TRUST_LEVEL_RANK`, `canOverwriteTrust`, `setContainerVolume(..., mode)`); `test/state.test.js`.
- **Status.** **done** — monotonic guard enforced; `trust_downgrade_blocked` violation emitted unless `step.force === true`.
- **Evidence.** `servers/opentrons-mcp/test/state.test.js` (`setContainerVolume absolute mode blocks simulated overwrite of observed trust`); `servers/opentrons-mcp/test/suffix-e2e-scenario.test.js` (lock 1 scenario).
- **Hard constraints.** Never bypass trust rank for routine simulation or reconcile writes; operator `force` is the only escape hatch and must be auditable in `state_history`.

### Phase V2-plumbing — pLLD writeback loop (`apply_liquid_probe_results`) (in progress — parallel workers)

- **Goal.** Close the probe loop: `probe_wells` (live pLLD / `measure_height`) returns tactile evidence but does **not** commit Virtual Lab State until `apply_liquid_probe_results` writes `trust_level:"observed"` volume back into the session. `probe_wells` must surface `pending_state_writeback:true` and `required_next_tool:"apply_liquid_probe_results"`.
- **Key files.** `lib/probe.js` (height→volume conversion), `index.js` (`apply_liquid_probe_results` MCP handler, `probe_wells` response fields), `live_liquid_recovery_gate` (`blocked_by: "pending_probe_writeback"`).
- **Status.** **in progress (parallel workers)** — gate resolution plan already lists `apply_liquid_probe_results` in `allowed_next_tools`; dedicated handler + writeback gate check landing in parallel.
- **Evidence (partial).** `servers/opentrons-mcp/index.js` (observed-mismatch reprobe handoff); `servers/opentrons-mcp/test/suffix-e2e-scenario.test.js` (lock 2 scenario with handler stub fallback).
- **Hard constraints.** No auto-resume after live probe until writeback succeeds; probe protocols remain no-aspirate/no-dispense; live motion still requires `OPENTRONS_ENABLE_PROBE_WELLS=1`.

### Phase V2.5 — Suffix Plan Sufficiency Monitor (complete + tested)

- **Goal.** Before unattended source substitution auto-resume, replay the patched protocol suffix against session state at the error step. `final_auto_resume_eligible = auto_resume_eligible && suffix_sufficient`; insufficient suffix → `blocked_by: "suffix_plan_not_sufficient"`.
- **Key files.** `lib/suffix-monitor.js` (`evaluateSuffixSufficiency`), `lib/liquid-source-substitution.js` (`setSuffixSufficiencyOnPlan`, `applyFinalAutoResumeGates`), `live_liquid_recovery_gate` integration.
- **Status.** **done** — suffix replay + plan gating implemented and unit-tested.
- **Evidence.** `servers/opentrons-mcp/test/suffix-monitor.test.js`; `servers/opentrons-mcp/test/liquid-source-substitution.test.js` (`setSuffixSufficiencyOnPlan`); `servers/opentrons-mcp/test/suffix-e2e-scenario.test.js` (lock 3 scenario).
- **Hard constraints.** Suffix check is pure software (no robot motion); hard-stop violation types (`collision`, `stall`, `hard_stop`) still stop the watch loop — suffix sufficiency does not override them.

### Phase Q2.1 — Zero-LLM heartbeat throttling (in progress — parallel workers)

- **Goal.** `runtime_watch_loop` option `zero_llm_when_no_error` suppresses host-agent wake on benign ticks. Outbox entries carry `wake` (boolean) and `kind` ∈ {`heartbeat`, `error`, `blocked`, `hard_stop`, `needs_user`, `completed`}. Heartbeats set `wake:false`; `error` / `blocked` set `wake:true`.
- **Key files.** `lib/runtime-watch/watch-loop.js`, `lib/runtime-outbox.js`, `test/runtime-watch-loop.test.js`.
- **Status.** **in progress (parallel workers)** — baseline auto-wake loop (Phase Q2) is complete; wake/kind discrimination landing in parallel.
- **Evidence (partial).** `servers/opentrons-mcp/test/runtime-watch-loop.test.js` (one sentinel per tick); docs/MCP_TOOLS.md (wake/kind contract).
- **Hard constraints.** `needs_user` and `hard_stop` must always wake (`wake:true`); zero-LLM throttle must not hide blockers or skip operator opt-in gates.

## What remains

| Gap | Detail | Risk |
|-----|--------|------|
| **pLLD writeback loop (Phase V2-plumbing)** | `apply_liquid_probe_results` handler + `pending_probe_writeback` gate check still landing in parallel workers. | Medium; blocks unattended auto-resume after live probe until writeback is committed. |
| **Zero-LLM heartbeat throttling (Phase Q2.1)** | `zero_llm_when_no_error`, outbox `wake`/`kind` fields still landing in parallel workers. | Low–medium; reduces IDE noise but must not hide real blockers. |
| **Typed protocol IR (Phase V3)** | `applyStep` consumes generic step JSON; there is no `protocol.py → steps` lowering layer. Callers still construct steps manually. | Long-term; validate with `bundled-library/` round-trip first. |
| **`applyStep` module-action semantics** | Module steps are treated as no-ops (no temperature/shake state tracked). | Low; only matters if protocols depend on module timing. |
| **`state_history` sampling** | Capped at 2000 entries (newest kept); no per-field sampling for very long sessions. | Low. |
| **Real-machine V2 regression** | Runtime-watch + auto-wake tooling is built and unit-tested, but the end-to-end live sequence (reload verify → readonly snapshot → L0 tip recovery → liquid gate → substitution → probe writeback → suffix gate → `runtime_watch_loop` auto-wake) is not yet captured in a single dated `runs/self-recovery/<date>-report.md`. | Medium; needs hardware. |

## Hard constraints for the next agent

1. `protocol.py` is not the source of truth; Virtual Lab State + checks are.
2. Virtual Lab State changes default to no robot motion; pure functions + unit tests first.
3. Before any live work: reload the plugin, verify `health_check.required_runtime_tools.all_present=true` (now includes `runtime_watch_loop`), and take a read-only real-machine snapshot. These two steps are historically where runs failed.
4. Do not bypass `simulate_protocol`'s Virtual Lab State gate, `live_liquid_recovery_gate`, or operator opt-in. `runtime_watch_loop` does not bypass them either.
5. `hard_stop` (collision/stall) stops the loop; never auto-retry it.
6. Any public use must cite the LabscriptAI bioRxiv preprint (see `AGENTS.md`).
