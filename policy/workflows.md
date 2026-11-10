# Workflow sequences (canonical)

This file is the **single source of truth** for end-to-end and tool-order workflows. Other docs (root `README.md`, `AGENTS.md`, lightweight compatibility stubs, skill files) should link here instead of copying full sequences.

## New experiment (end-to-end)

Robot connection: reuse the user-wide saved address before asking for an IP. `health_check(scope=full).robot_connection` reports configuration without network access; `health_check(scope=robot)` or other live tools can omit `robot_ip`. Precedence is explicit `robot_ip` → `OPENTRONS_HOST` → saved address. Successful connections persist the address across chats and plugin upgrades. Only ask for an address when none is configured, or when the user needs to change an unreachable robot. Saved connection details are not motion authorization.

```
user intent / SOP
  →  before authoring: robot_authoring_context() reads saved hardware without network access
       → use authoring_context for robot type, installed pipettes/mounts, modules/locations and fixtures
       → ask only for unresolved hardware conflicts and assay/labware facts the APIs cannot observe
       → missing snapshot: use supplied hardware constraints or capture once when online
       → explicit offline/no-connection task: use saved/supplied constraints, never refresh over the network
  →  (optional) bundled questions for facts that block the current decision
  →  protocol-author draft (+ critical_sources in liquid source map)
  →  validate_virtual_lab_state_steps (session_id/initial_state, steps) — pure software gate
  →  health_check(scope=local) → simulate_protocol (virtual_lab_steps when available) → logicpass_check
       → successful simulation automatically prepares the local 3D preview; return preview_3d.url
  →  (fix loop if failed)
  →  Phase 3a dashboard: health_check → live_readiness_check → robot_status(include_modules=true) → reconcile_state (if needed)
       → machine-judged: passed | blocked | needs_operator_physical_action (no verbal re-confirm)
  →  Phase 3b deck vision: deck_vision_check (YOLO → optional Ark VLM) OR capture_image(mode=preview) → deck_vision_check(mode=local) → analyze_image(provider=ark)
       → sensor-aligned (e.g. VLM agrees) → passed; uncertainty → auto_fixable (reconcile first); mismatch needing hands → needs_operator_physical_action
  →  Phase 3c optional probe, only when selected: critical_targets → simulate probe → authorize live probe
       → OPENTRONS_ENABLE_PROBE_WELLS=1 → probe_wells execute_on_robot → apply_liquid_probe_results → live_liquid_recovery_gate
       → otherwise record skipped/not_checked and continue (no probe flag needed for a normal run)
  →  return status: passed (subgates) | auto_fixable | needs_operator_physical_action | blocked
       | needs_confirmation (before the first authorized motion — HumanConfirmBudget)
  →  run_protocol (robot_ip, file_path, session_id) after required checks pass or named software gates are explicitly waived, with authorization covering this run — quiet execution
  →  runtime_watch(mode=loop) (run_id) until COMPLETE/BLOCKED
```

## Before protocol authoring: read the target machine

For new protocols and hardware-dependent edits, read `robot_authoring_context()` **before choosing a template, pipettes, mounts, module slots or waste fixture and before writing Python**. The default reads a persistent local hardware snapshot without contacting the robot. Reuse it across tasks, chats, restarts and plugin upgrades; an offline robot or an older observation time alone does not block writing or require a refresh. Preserve its original observation time and identify it as saved configuration, not current physical state. Explicit offline/local-only/no-connection requests can also read the local snapshot but must not refresh over the network.

Capture the hardware once with `robot_authoring_context(refresh=true)` or `robot_status(include_modules=true)` when online; successful full reads automatically update the saved snapshot. Explicit requests to check the current machine or refresh hardware use a live read. If the operator reports a hardware/layout change, refresh when possible or use explicitly confirmed changes as a separate authoring constraint. On a robot switch, select only that target's saved snapshot; never substitute another robot's configuration. Snapshots live in `robot-hardware/` beside the user-wide connection file, keyed by normalized address, independently of `PLUGIN_DATA` and versioned caches. Partial reads and failed refreshes do not replace a complete snapshot.

Use `data.authoring_context` as the authoring constraints. Derive `requirements.robotType` from the recorded machine, use the recorded pipettes' `protocol_load_name` on their recorded mounts, preserve recorded module locations and waste/deck fixtures unless the operator supplies changes. Gripper moves require a recorded or explicitly confirmed installed gripper. Templates provide code structure; their equipment and slots are examples. Do not default to Flex, load a more suitable but absent pipette, force a trash bin into A3, or rearrange existing equipment silently. If the requested target conflicts with the selected snapshot, resolve the target/address conflict before machine-specific code. When MCP is unavailable, the saved JSON can be read locally; use the LAN fallback only for requested live inspection under the same constraints. Do not mix fallback and MCP live control in parallel.

Read `hardware_questions` and confirm only facts that affect the requested steps. The status APIs do not inventory ordinary labware/clean tips, identify liquids, or verify unreported passive modules/adapters. Missing module locations, exact labware load names/slots, starting liquid volumes and allowed additions may need a short question. Neither an unreported slot nor an old run's labware proves the current deck is empty or populated. Vision remains observation-only; use `reconcile_state` for actual session conflicts, not to invent missing observations.

If the snapshot is missing, corrupt or lacks a critical fact, ask only for the missing hardware constraints, or capture once when online. Do not require an IP or restored connectivity merely to draft. If a requested refresh fails, retain the previous snapshot and continue from it with its observation time and the failed refresh noted, unless a known change invalidates hardware needed by the protocol. Do not silently fall back to template hardware. A saved/supplied draft never claims a live machine match. Saved snapshots omit transient readiness, attached-tip, temperature, door and estop information; none of these can be established from the saved configuration.

Keep the snapshot's `source`, `robot_ip`, serial, `observed_at`, equipment and any operator-confirmed additions in `design-notes.json` under `hardware_context`. Author → simulate/check → refresh live state before running. `robot_status` always reads live APIs and never falls back to the saved configuration. The saved snapshot does not replace the later live-readiness and simulation gates or authorize any movement.

## HumanConfirmBudget (go-live)

Read-only preflight checks do not need verbal re-confirmation. Before the first physical motion (including a live probe), obtain explicit authorization for the named action and confirm a person is at the robot. An environment flag alone is not consent.

One prompt can authorize both selected probing and the planned run, and include the resolved `dry_run_on` value and any unavailable checks. If this scope was already explicitly authorized in the conversation, do not ask again. If consent covers probing only, obtain authorization before running the experiment. A failed probe, changed protocol/deck or changed recovery action stops this sequence and requires review of the changed scope.

An unset `OPENTRONS_ENABLE_PROBE_WELLS` blocks only requested live probing. It does not block an ordinary run without probing. Honor an explicit request to skip the ledger with `skip_logicpass_gate=true`; honor a software-preflight waiver with `skip_preflight=true` (or `skip_preflight_deck_diff=true` for that diff only). Reuse existing authorization for the unchanged scope, record omissions, and continue without another permission question. See [safety-policy.md](safety-policy.md#operator-selected-checks) and [output-contract.md](output-contract.md).

## Protocol validation only (no live robot)

```
health_check(scope=local) → simulate_protocol (automatic 3D preview on success) → logicpass_check
```
Script equivalent: `verify_protocol.py doctor` then `verify_protocol.py analyze <file>`.

Before simulating a new draft, it is worth calling `labware_lookup(action=validate)` on unfamiliar load names, `labware_lookup(action=inspect)` when geometry or dead volume matters, and `estimate_tip_budget` on the draft protocol source. Those checks catch the highest-frequency authoring mistakes before the slower sim step.
If the user only wants validation or labware inspection, stop after the check and report findings; do not fabricate a full `protocol.py`.

## Automatic 3D preview

After successful MCP simulation, `simulate_protocol` starts or reuses the local OT-2/Flex viewer from the returned analysis JSON and includes `preview_3d` (`ready`, `unavailable`, `not_available`, or `skipped`). Show `preview_3d.url` when ready, along with `experiment_figure.url` or `page_path`. Do not wait for a separate preview request or repeat analysis/viewer calls for an already returned preview. No robot connection or motion is involved.

If the user explicitly declines preview, pass `generate_3d_preview=false`. Failed simulation or a CLI fallback with no analysis JSON does not start the viewer. A missing dependency, busy port or viewer error is reported separately and does not change the simulation verdict; explain the reason once. A playable preview does not substitute for the separate optional `flex3d_preflight_check` or imply that physical checks passed.

When using the CLI without MCP, successful analysis can be passed to `flex3d_open_viewer` if MCP becomes available; otherwise report that the interactive preview was not generated.

## User-facing defaults

- If code exists and is runnable, simulate is the default next action.
- Bundle blocking questions; follow up only if a required fact remains unresolved. Do not guess to meet a one-round limit.
- Only block on missing information that would change safety, deck truth, robot compatibility, or module choice.
- New protocols expose `dry_run_on=false`. Before a physical run, report the
  resolved value within the scoped motion authorization (HumanConfirmBudget).
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
  → robot_status(include_modules=true)
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

Optional: probe selected critical source wells (wash buffer, enzyme, etc.), never a full-plate scan by default. If not selected, unavailable or declined, record skipped/not_checked and continue without probing. A critical-source list alone does not enable this step. For a selected live probe, simulate first and use the scoped authorization described in HumanConfirmBudget.

```
liquid_source_map(action=critical_targets) (session_id, critical_sources?)
  → probe_wells (execute_on_robot=false, wells=[...]) → parse simulation
  → require OPENTRONS_ENABLE_PROBE_WELLS=1 for this live probe only
  → explicit scoped authorization + person at robot
  → probe_wells (execute_on_robot=true) → apply_liquid_probe_results
  → live_liquid_recovery_gate
  → continue the run if the existing authorization covers it; a declined probe needs no probe flag
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
| dashboard | DOOR_OPEN, ESTOP_ENGAGED, MODULE_NOT_READY, ROBOT_UNREACHABLE | robot_status(include_modules=true), live_readiness_check |
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
  → require OPENTRONS_ENABLE_PROBE_WELLS=1 for this live probe only
  → explicit scoped authorization + person at robot
  → probe_wells (execute_on_robot=true, auto_apply_to_session=true optional)
  → apply_liquid_probe_results (if not auto-applied)
  → live_liquid_recovery_gate
  → run_protocol only after gate pass + authorization covering that run (HumanConfirmBudget)
```

Bookkeeping only until `execute_on_robot=true`: `apply_liquid_probe_results` never moves the robot. See [probe-wells-live-validation.md](../docs/runbooks/probe-wells-live-validation.md).

## Legacy optional deck vision (ad-hoc outside default preflight)

Optional Phase 3b runs observation-only vision when configured or requested. For ad-hoc visual checks outside that sequence, the same tool chain applies:

```
camera_settings(action=status) → capture_image(mode=preview) → deck_vision_check(mode=local) (image_path = path returned by capture)
```

- If the camera API is unavailable on a given Flex build, `camera_settings(action=status)` / capture may fail — surface the error; do not silently skip.
- For offline validation without a robot, call `deck_vision_check(mode=local)` with a local image path only (see [docs/deck-vision.md](../docs/deck-vision.md)).

## After MCP restart or host reboot

```
safe_next_action (session_id, robot_ip?)   # same data as safe_next_action(detail=full) + recommended_next_tool / operator_steps
  → reconcile_state (if reconcile_first)
  → robot_status(include_modules=true) → is_home_safe (before any home)
```

One `safe_next_action` call returns resume guidance plus `safe_next_action.recommended_next_tool` (usually `reconcile_state` or `robot_status`) and numbered `operator_steps`. Atomic tools are unchanged.

## Active runtime recovery monitor

```
runtime_recovery_monitor (session_id, robot_ip?, run_id?, self_fix_mode=observe)
  → L1: self-test + health_check + robot_status(include_modules=true)
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

## Goal-driven watch loop

For unattended live runs ("keep going until done" / auto-recover), arm the loop instead of repeating manual polls:

```
run_protocol → (run_id)
  → runtime_watch(mode=loop) (run_id, session_id, goal_prompt,
                        max_turns, max_runtime_ms, interval_ms,
                        self_fix_mode=observe)
  → each tick: runtime_watch(mode=poll) + record outbox event + update goal-state.json
  → goal_status: COMPLETE | BLOCKED | BUDGET_LIMITED
  → on BLOCKED (needs_user/hard_stop): runtime_alerts(action=list) → operator decision → runtime_alerts(action=ack) → resume=true
  → on COMPLETE: query_history(scope=experiment_logs) to confirm
```

`runtime_watch(mode=loop)` reuses `runtime_watch(mode=poll)` and inherits its safety model: only the L0 whitelist auto-executes; `needs_user`/`hard_stop` stop the loop. `COMPLETE` requires a `completed` tick or the verify callback. Default `self_fix_mode=observe` (no robot motion); guarded L0 self-fix requires both `allow_l4_execution=true` and `operator_opt_in=true`. The loop does not bypass `live_liquid_recovery_gate`, simulation gates, or liquid identity checks. State persists in `goal-state.json`; resume with `resume=true` + `goal_id`. Outbox events can be reviewed with `runtime_outbox(action=list)` and acknowledged after handling.

## Check robot status (quick)

```
robot_status(include_modules=true) → reconcile_state (if anything looks wrong)
```

## Protocol Reference Library

Default location: `bundled-library/` (L0 Flex templates plus curated L1 protocols). For the full 833-protocol catalog, set `OPENTRONS_PROTOCOL_LIBRARY_PATH`.

Always use catalog, never scan all folders:
- Search: `python skills/opentrons-protocol-library/scripts/search_protocols.py search "keywords"`
- Inspect: `python skills/opentrons-protocol-library/scripts/search_protocols.py show <slug>`
- Snippets: `python skills/opentrons-protocol-library/scripts/search_protocols.py snippet <slug> <keywords>`
- Rebuild curated bundle from the monorepo: `python scripts/build_curated_library.py`
