# Workflow sequences (canonical)

This file is the **single source of truth** for end-to-end and tool-order workflows. Other docs (root `README.md`, `AGENTS.md`, lightweight compatibility stubs, skill files) should link here instead of copying full sequences.

## New experiment (end-to-end)

```
user intent / SOP
  →  (optional) one blocking clarification round
  →  protocol-author draft (+ critical_sources in liquid source map)
  →  validate_virtual_lab_state_steps (session_id/initial_state, steps) — pure software gate
  →  health_check(scope=local) → simulate_protocol (virtual_lab_steps) → simulate_protocol
  →  (fix loop if failed)
  →  Phase 3a dashboard: health_check → live_readiness_check → robot_status → robot_status → reconcile_state (if needed)
       → machine-judged: passed | blocked | needs_operator_physical_action (no verbal re-confirm)
  →  Phase 3b deck vision: deck_vision_check (YOLO → optional Ark VLM) OR capture_image(mode=preview) → deck_vision_check(mode=local) → analyze_image(provider=ark)
       → sensor-aligned (e.g. VLM agrees) → passed; uncertainty → auto_fixable (reconcile first); mismatch needing hands → needs_operator_physical_action
  →  Phase 3c critical probe: liquid_source_map(action=critical_targets) → probe_wells simulate
       → OPENTRONS_ENABLE_PROBE_WELLS=1 hard gate (blocked if unset; not a verbal subgate confirm)
       → probe_wells execute_on_robot → apply_liquid_probe_results → live_liquid_recovery_gate
  →  return status: passed (subgates) | auto_fixable | needs_operator_physical_action | blocked
       | needs_confirmation (final go-live only — HumanConfirmBudget)
  →  run_protocol (robot_ip, file_path, session_id) only after that single confirmation — quiet execution, no vision during run
  →  runtime_watch(mode=loop) (run_id) for unattended auto-wake until COMPLETE/BLOCKED
```

## HumanConfirmBudget (go-live)

Phase **3a / 3b / 3c** statuses are machine-judged. Agents must **not** verbally re-confirm each passed subgate.

The **only** go-live verbal confirmation is the final `run_protocol` / play confirmation. It may bundle `dry_run_on` and whether the live-probe env opt-in is already set. Do **not** remove the `OPENTRONS_ENABLE_PROBE_WELLS=1` (or equivalent) hard gate — unset env → `blocked`, not a chat substitute.

Escalate vs auto-fix: `auto_fixable` (agent tools, prefer reconcile) → `needs_operator_physical_action` (hands-on) → `needs_confirmation` (final live only) → `blocked`. See [output-contract.md](output-contract.md).


## Protocol validation only (no live robot)

```
health_check(scope=local) → simulate_protocol → simulate_protocol
```
Script equivalent: `verify_protocol.py doctor` then `verify_protocol.py analyze <file>`.

Before simulating a new draft, it is worth calling `labware_lookup(action=validate)` on unfamiliar load names, `labware_lookup(action=inspect)` when geometry or dead volume matters, and `estimate_tip_budget` on the draft protocol source. Those checks catch the highest-frequency authoring mistakes before the slower sim step.
If the user only wants validation or labware inspection, stop after the check and report findings; do not fabricate a full `protocol.py`.

## User-facing defaults

- If code exists and is runnable, simulate is the default next action.
- Ask at most one clarification round before drafting.
- Only block on missing information that would change safety, deck truth, robot compatibility, or module choice.
- New protocols expose `dry_run_on=false`. Before a physical run, report the
  resolved value as part of the **single** final go-live confirmation (HumanConfirmBudget).
  If true, that confirm must cover clean/liquid-free deck and labware; returned tips
  must be segregated or replaced before a wet run.

## Error recovery (live robot)

```
parse_error (robot_ip, run_id) → suggest_recovery_action (error_category, target_slot)
  → execute_protocol_recovery (run_id, robot_ip, recovery_branch, ...)
```

## Live readiness gate (read-only) — Phase 3a dashboard

```
health_check
  → live_readiness_check (robot_ip, session_id?, file_path?, run_id?)
  → robot_status → robot_status
  → reconcile_state (if guidance.reconcile_first or deck drift)
  → if fail: stop and follow recommended_next_tools
  → if pass/warn: continue to Phase 3b deck vision
```

`health_check` is the developer/environment probe. `live_readiness_check` is the operator-facing live gate. **No camera or VLM in this step.**

## Preflight deck vision — Phase 3b (YOLO first, Ark VLM second opinion)

Default pre-run visual check (observation-only). Never deck truth — compare with `reconcile_state` and robot APIs (see `policy/safety-policy.md`). On uncertainty, auto-reconcile / re-check before asking a human.

**Setup (once per machine):** See [docs/deck-vision.md](../docs/deck-vision.md).

**Preferred orchestration:**

```
deck_vision_check (robot_ip, session_id?, expected_layout?)
  → internally: capture_image(mode=preview) → deck_vision_check(mode=local)
  → if uncertain/mismatched: analyze_image(provider=ark) (Doubao; ARK_API_KEY in automation/.env)
  → if VLM/sensors align with expected layout: status=passed (continue; no human re-confirm)
  → if still uncertain vs session: status=auto_fixable → reconcile_state first
  → if physical rearrange/refill needed: status=needs_operator_physical_action
```

**Manual chain (equivalent):**

```
camera_settings(action=status) → capture_image(mode=preview) → deck_vision_check(mode=local)
  → if escalate: analyze_image(provider=ark) (or analyze_image(provider=kimi) when OPENTRONS_VLM_PROVIDER=kimi)
```

Escalate to VLM when YOLO reports low confidence, ambiguity, or layout mismatches. Sensor-aligned agreement (e.g. VLM agrees) is a **pass**, not `needs_confirmation`. Skip entire step with `OPENTRONS_PREFLIGHT_VISION=off`. Camera API failure is a surfaced error — do not silently skip.

## Critical-source liquid probe — Phase 3c (no VLM)

Probe only critical source wells (wash buffer, enzyme, etc.) — not full-plate scan. Machine-judged; do not add a separate verbal “confirm probe?” before the final go-live confirm.

```
liquid_source_map(action=critical_targets) (session_id, critical_sources?)
  → probe_wells (execute_on_robot=false, wells=[...]) → parse simulation
  → require OPENTRONS_ENABLE_PROBE_WELLS=1 (hard gate; blocked if unset)
  → probe_wells (execute_on_robot=true) → apply_liquid_probe_results
  → live_liquid_recovery_gate
  → continue; final verbal confirm only at run_protocol / play (HumanConfirmBudget)
```

Bookkeeping only until `execute_on_robot=true`. See [probe-wells-live-validation.md](../docs/runbooks/probe-wells-live-validation.md).

## Quiet execution — Phase 4

While `run_protocol` / `runtime_watch(mode=poll)` / `runtime_watch(mode=loop)` is active:

- Do **not** call `capture_image(mode=preview)`, `deck_vision_check(mode=local)`, `analyze_image(provider=ark)`, `deck_vision_check`, or `probe_wells` unless Phase 5 recovery routing requires it.
- Rely on error codes, `parse_error`, `suggest_recovery_action`, and registered playbooks.

## Recovery trigger routing — Phase 5

After `parse_error` → `suggest_recovery_action`, follow `recovery_channel`:

| Channel | Error leaves (examples) | Next tools |
|---------|-------------------------|------------|
| dashboard | DOOR_OPEN, ESTOP_ENGAGED, MODULE_NOT_READY, ROBOT_UNREACHABLE | robot_status, robot_status, live_readiness_check |
| vision | LABWARE_MISMATCH, DESTINATION_UNAVAILABLE, SLOT_NOT_ADDRESSABLE | deck_vision_check, reconcile_state |
| reconcile | SESSION_NEEDS_RECONCILIATION, STATE_MISMATCH | reconcile_state first (not camera/VLM-first) |
| manual | DECK_COLLISION (hard-stop) | stop; physical check; re-run live_readiness_check — does **not** enter vision channel |
| probe | INSUFFICIENT_VOLUME, AIR_BUBBLE, LIQUID_PROPERTY_ERROR | live_liquid_recovery_gate, liquid_source_map(action=critical_targets), targeted probe_wells |
| tip | TIP_PHYSICALLY_MISSING | tip-budget gate → `recover_tip_pickup` only if remaining tips ≥ remaining pickups; else STOP |

After door/module recovery, re-run Phase 3a before resume. Deck appearance doubt → vision channel. Session/state mismatch → reconcile-first. `DECK_COLLISION` is hard-stop/manual (no vision auto-recovery). Liquid doubt → targeted probe only.

**FIX/STOP gates** (tip budget, time window, contamination, precious mid-fault, waste-path retry, same-identity reserve proposal) are defined in [error-response.md](error-response.md) § Agent FIX/STOP decision gates and mirrored in `skills/opentrons-experiment-run/SKILL.md` Phase 5. Channel routing alone is not enough.

On probe-channel `INSUFFICIENT_VOLUME` / `liquidNotFound`: call `live_liquid_recovery_gate`, then `liquid_source_substitution(action=plan)` when a same-identity reserve may exist; present the FIX proposal for operator confirmation — never silent swap. Short reserve → STOP.

## Optional Flex liquid probe (recovery / re-probe)

Use during recovery or when source fill is uncertain after a run has started. **Not** a substitute for Phase 3c preflight on new runs.

```
probe_wells (execute_on_robot=false) → parse simulation
  → require OPENTRONS_ENABLE_PROBE_WELLS=1 (hard gate; blocked if unset)
  → probe_wells (execute_on_robot=true, auto_apply_to_session=true optional)
  → apply_liquid_probe_results (if not auto-applied)
  → live_liquid_recovery_gate
  → run_protocol only after gate pass + final go-live confirmation (HumanConfirmBudget)
```

Bookkeeping only until `execute_on_robot=true`: `apply_liquid_probe_results` never moves the robot. See [probe-wells-live-validation.md](../docs/runbooks/probe-wells-live-validation.md).

## Legacy optional deck vision (ad-hoc outside default preflight)

Default Phase 3b already runs observation-only vision during preflight. For ad-hoc visual checks outside that sequence, the same tool chain applies:

```
camera_settings(action=status) → capture_image(mode=preview) → deck_vision_check(mode=local) (image_path = path returned by capture)
```

- If the camera API is unavailable on a given Flex build, `camera_settings(action=status)` / capture may fail — surface the error; do not silently skip.
- For offline validation without a robot, call `deck_vision_check(mode=local)` with a local image path only (see [docs/deck-vision.md](../docs/deck-vision.md)).

## After MCP restart or host reboot

```
safe_next_action (session_id, robot_ip?)   # same data as safe_next_action(detail=full) + recommended_next_tool / operator_steps
  OR safe_next_action(detail=full) (session_id, robot_ip?)
  → reconcile_state (if reconcile_first)
  → robot_status → robot_status → is_home_safe (before any home)
```

`safe_next_action` is a thin wrapper: one call returns full `safe_next_action(detail=full)` data plus `safe_next_action.recommended_next_tool` (usually `reconcile_state` or `robot_status`) and numbered `operator_steps`. Atomic tools are unchanged.

## Active runtime recovery monitor

```
runtime_recovery_monitor (session_id, robot_ip?, run_id?, self_fix_mode=observe)
  → L1: self-test + health_check + robot_status + robot_status
  → L2: run observer; use self_fix_mode=l0 only for runtime_watch(mode=poll) whitelist fixes
  → L3: safe_next_action + optional live_liquid_recovery_gate + prepared recovery bundle summary
  → L4: report whether guarded L0 execution is blocked, ready, or already applied
```

Default `self_fix_mode=observe` is read-only for run watching. `self_fix_mode=l0` may execute only the existing `runtime_watch(mode=poll)` L0 whitelist and now gates before delegation: without both `allow_l4_execution=true` and `operator_opt_in=true`, the monitor must not call `runtime_watch(mode=poll)` for self-fix execution. Do not use monitor output to bypass `live_liquid_recovery_gate`, simulation gates, liquid identity checks, or operator opt-in.

Use `list_recovery_playbooks` when an agent needs to know which fixed recovery scripts exist. The registry is the runtime contract: it lists the executor tool, whether watch mode may call it, whether robot motion is possible, required gates, and semantic invariants. If an error class is not covered by a registered playbook, stop at `safe_next_action` / human review instead of inventing a new action.

For live liquid recovery work after a restart, prefer the local read-only bundle exporter before any motion:

```
export-real-machine-readonly-status.mjs
  → if blockers include attached_tip, door, estop, or robot_unreachable: stop; no robot motion
  → writes robot HTTP snapshot + result log even when MCP transport is closed
export-runtime-recovery-readiness.mjs
  → read latest real-machine-readonly-status artifact and latest gate artifact
  → if mcp_process.running=false: reload MCP client
  → if real_machine.blockers is non-empty: stop and refresh/clear physical state
  → if live_liquid_tests_allowed=false or no_robot_motion=true: stop and follow next_tool
  → if ready: re-run live_liquid_recovery_gate in the loaded MCP client
```

The real-machine status exporter is deck-adjacent safety evidence from robot HTTP, not a permission to move. The readiness bundle is an artifact convenience layer over the latest live-liquid gate result and `safe_next_action`; it is not deck truth.

## Goal-driven auto-wake loop

For unattended live runs ("keep going until done" / auto-recover), arm the loop instead of repeating manual polls:

```
run_protocol → (run_id)
  → runtime_watch(mode=loop) (run_id, session_id, goal_prompt,
                        max_turns, max_runtime_ms, interval_ms,
                        self_fix_mode=observe,
                        notify_adapters=[cursor|claudecode|codex|cli|webhook])
  → each tick: runtime_watch(mode=poll) + append outbox sentinel + update goal-state.json
  → goal_status: COMPLETE | BLOCKED | BUDGET_LIMITED
  → on BLOCKED (needs_user/hard_stop): runtime_alerts(action=list) → operator decision → runtime_alerts(action=ack) → resume=true
  → on COMPLETE: query_history(scope=experiment_logs) to confirm
```

`runtime_watch(mode=loop)` reuses `runtime_watch(mode=poll)` and inherits its safety model: only the L0 whitelist auto-executes; `needs_user`/`hard_stop` stop the loop. `COMPLETE` requires a `completed` tick or the verify callback. Default `self_fix_mode=observe` (no robot motion); guarded L0 self-fix requires both `allow_l4_execution=true` and `operator_opt_in=true`. The loop does not bypass `live_liquid_recovery_gate`, simulation gates, or liquid identity checks. State persists in `goal-state.json` so the goal survives IDE restart / operator rotation; resume with `resume=true` + `goal_id`.

## Check robot status (quick)

```
robot_status → robot_status → reconcile_state (if anything looks wrong)
```

## Protocol Reference Library

Default location: `bundled-library/` (L0 Flex templates plus curated L1 protocols). For the full 833-protocol catalog, set `OPENTRONS_PROTOCOL_LIBRARY_PATH`.

Always use catalog, never scan all folders:
- Search: `python skills/opentrons-protocol-library/scripts/search_protocols.py search "keywords"`
- Inspect: `python skills/opentrons-protocol-library/scripts/search_protocols.py show <slug>`
- Snippets: `python skills/opentrons-protocol-library/scripts/search_protocols.py snippet <slug> <keywords>`
- Rebuild curated bundle from the monorepo: `python scripts/build_curated_library.py`
