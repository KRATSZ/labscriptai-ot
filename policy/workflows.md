# Workflow sequences (canonical)

This file is the **single source of truth** for end-to-end and tool-order workflows. Other docs (root `README.md`, `AGENTS.md`, lightweight compatibility stubs, skill files) should link here instead of copying full sequences.

## New experiment (end-to-end)

```
user intent / SOP
  →  (optional) one blocking clarification round
  →  protocol-author draft
  →  validate_virtual_lab_state_steps (session_id/initial_state, steps) — pure software gate
  →  doctor_local_runtime → simulate_protocol (virtual_lab_steps) → parse_simulation_output
  →  (fix loop if failed)
  →  live_readiness_check (robot_ip, session_id?, file_path?) when the operator wants a read-only live gate
  →  (optional Flex LPD) probe_wells simulate → operator confirm + OPENTRONS_ENABLE_PROBE_WELLS=1
       → probe_wells execute_on_robot → apply_liquid_probe_results → live_liquid_recovery_gate
  →  return status: ready | needs_confirmation | blocked
  →  run_protocol (robot_ip, file_path, session_id) only after confirmation
  →  runtime_watch_loop (run_id) for unattended auto-wake until COMPLETE/BLOCKED
```

## Protocol validation only (no live robot)

```
doctor_local_runtime → simulate_protocol → parse_simulation_output
```
Script equivalent: `verify_protocol.py doctor` then `verify_protocol.py analyze <file>`.

Before simulating a new draft, it is worth calling `validate_labware_name` on unfamiliar load names, `inspect_labware_definition` when geometry or dead volume matters, and `estimate_tip_budget` on the draft protocol source. Those checks catch the highest-frequency authoring mistakes before the slower sim step.
If the user only wants validation or labware inspection, stop after the check and report findings; do not fabricate a full `protocol.py`.

## User-facing defaults

- If code exists and is runnable, simulate is the default next action.
- Ask at most one clarification round before drafting.
- Only block on missing information that would change safety, deck truth, robot compatibility, or module choice.
- New protocols expose `dry_run_on=false`. Before a physical run, report the
  resolved value. If true, confirm the deck and labware are clean and liquid-free;
  returned tips must be segregated or replaced before a wet run.

## Error recovery (live robot)

```
parse_error (robot_ip, run_id) → suggest_recovery_action (error_category, target_slot)
  → execute_protocol_recovery (run_id, robot_ip, recovery_branch, ...)
```

## Live readiness gate (read-only)

```
health_check
  → live_readiness_check (robot_ip, session_id?, file_path?, run_id?)
  → if fail: stop and follow recommended_next_tools
  → if pass/warn: create_run or run_protocol only after operator confirmation
```

`health_check` is the developer/environment probe. `live_readiness_check` is the operator-facing live gate.

## After MCP restart or host reboot

```
safe_next_action (session_id, robot_ip?)   # same data as restart_review + recommended_next_tool / operator_steps
  OR restart_review (session_id, robot_ip?)
  → reconcile_state (if reconcile_first)
  → robot_status → module_status → is_home_safe (before any home)
```

`safe_next_action` is a thin wrapper: one call returns full `restart_review` data plus `safe_next_action.recommended_next_tool` (usually `reconcile_state` or `robot_status`) and numbered `operator_steps`. Atomic tools are unchanged.

## Active runtime recovery monitor

```
runtime_recovery_monitor (session_id, robot_ip?, run_id?, self_fix_mode=observe)
  → L1: self-test + health_check + robot_status + module_status
  → L2: run observer; use self_fix_mode=l0 only for runtime_watch_poll whitelist fixes
  → L3: safe_next_action + optional live_liquid_recovery_gate + prepared recovery bundle summary
  → L4: report whether guarded L0 execution is blocked, ready, or already applied
```

Default `self_fix_mode=observe` is read-only for run watching. `self_fix_mode=l0` may execute only the existing `runtime_watch_poll` L0 whitelist and now gates before delegation: without both `allow_l4_execution=true` and `operator_opt_in=true`, the monitor must not call `runtime_watch_poll` for self-fix execution. Do not use monitor output to bypass `live_liquid_recovery_gate`, simulation gates, liquid identity checks, or operator opt-in.

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
  → runtime_watch_loop (run_id, session_id, goal_prompt,
                        max_turns, max_runtime_ms, interval_ms,
                        self_fix_mode=observe,
                        notify_adapters=[cursor|claudecode|codex|cli|webhook])
  → each tick: runtime_watch_poll + append outbox sentinel + update goal-state.json
  → goal_status: COMPLETE | BLOCKED | BUDGET_LIMITED
  → on BLOCKED (needs_user/hard_stop): runtime_get_alerts → operator decision → runtime_ack_alert → resume=true
  → on COMPLETE: experiment_history to confirm
```

`runtime_watch_loop` reuses `runtime_watch_poll` and inherits its safety model: only the L0 whitelist auto-executes; `needs_user`/`hard_stop` stop the loop. `COMPLETE` requires a `completed` tick or the verify callback. Default `self_fix_mode=observe` (no robot motion); guarded L0 self-fix requires both `allow_l4_execution=true` and `operator_opt_in=true`. The loop does not bypass `live_liquid_recovery_gate`, simulation gates, or liquid identity checks. State persists in `goal-state.json` so the goal survives IDE restart / operator rotation; resume with `resume=true` + `goal_id`.

## Check robot status (quick)

```
robot_status → module_status → reconcile_state (if anything looks wrong)
```

## Optional Flex liquid probe (LPD, opt-in live motion)

Use when source wells have uncertain fill height, recovery needs observed liquid evidence, or the operator requests pre-run probing. **Default off** — requires explicit operator confirmation for live motion.

```
probe_wells (execute_on_robot=false) → parse simulation
  → operator confirm + OPENTRONS_ENABLE_PROBE_WELLS=1
  → probe_wells (execute_on_robot=true, auto_apply_to_session=true optional)
  → apply_liquid_probe_results (if not auto-applied)
  → live_liquid_recovery_gate
  → run_protocol (only after gate pass + operator opt-in)
```

Bookkeeping only until `execute_on_robot=true`: `apply_liquid_probe_results` never moves the robot. See [probe-wells-live-validation.md](../docs/runbooks/probe-wells-live-validation.md).

## Optional deck vision (observation-only)

Use this **only when the operator explicitly asks** for a visual deck check, camera preview, or image-based confirmation. Vision does **not** replace committed deck truth — compare results with **`reconcile_state`** and robot APIs (see `policy/safety-policy.md`).

**Setup (once per machine):** See [docs/deck-vision.md](../docs/deck-vision.md).

**Tool sequence (MCP `opentrons-lab-mcp`):**

```
camera_status → capture_preview_image → vision_check (image_path = path returned by capture)
```

- If the camera API is unavailable on a given Flex build, `camera_status` / capture may fail — surface the error; do not silently skip.
- For offline validation without a robot, call `vision_check` with a local image path only (see [docs/deck-vision.md](../docs/deck-vision.md)).

## Protocol Reference Library

Default location: `bundled-library/` (L0 Flex templates plus curated L1 protocols). For the full 833-protocol catalog, set `OPENTRONS_PROTOCOL_LIBRARY_PATH`.

Always use catalog, never scan all folders:
- Search: `python skills/opentrons-protocol-library/scripts/search_protocols.py search "keywords"`
- Inspect: `python skills/opentrons-protocol-library/scripts/search_protocols.py show <slug>`
- Snippets: `python skills/opentrons-protocol-library/scripts/search_protocols.py snippet <slug> <keywords>`
- Rebuild curated bundle from the monorepo: `python scripts/build_curated_library.py`
