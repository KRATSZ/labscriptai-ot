---
name: opentrons-experiment-run
description: Default entry for new experiments, "what's the robot doing?", resume, and recovery — orchestrates MCP state machine from intent through simulation gate to live execution.
type: prompt-only
mcp_tools:
  - robot_status
  - module_status
  - reconcile_state
  - run_protocol
  - runtime_watch_poll
  - runtime_watch_loop
  - runtime_get_outbox
  - runtime_ack_outbox
  - runtime_get_alerts
  - runtime_ack_alert
  - parse_error
  - suggest_recovery_action
  - execute_protocol_recovery
  - recover_tip_pickup
  - live_readiness_check
  - live_liquid_recovery_gate
  - probe_wells
  - apply_liquid_probe_results
  - list_critical_probe_targets
  - safe_next_action
  - restart_review
  - experiment_history
  - is_home_safe
  - health_check
  - camera_status
  - capture_preview_image
  - vision_check
  - analyze_image_with_ark
  - deck_vision_check
---

# Experiment Run (MCP State Machine)

Phases are **ordered**. Finish each gate before the next. If a gate fails,
**stop** and fix or escalate.

## User-Facing Contract

Hide internal complexity from the operator. The default interaction model is:

1. One user input
2. At most one blocking clarification round
3. **One** confirmation before live execution (`run_protocol` / play) — not one per preflight subgate

If a runnable protocol exists, the default next step is the simulation gate. Do
not wait for the user to explicitly ask for simulate.

**Do not over-ask.** After a Phase 3a/3b/3c tool returns `passed` (or skip-pass
for zero critical wells), continue to the next subphase without verbal
re-confirmation. Emit status JSON; do not pause the chat to ask “does this look
good?” when the gate already cleared.

### Phase 0 — Intent (multi-well / pattern / ambiguous mapping)

- If wells or spatial layout not confirmed: `opentrons-experiment-intent-review`
  to obtain `target_wells` / `plate_mask`, `tip_policy`, and `critical_sources`.
- If intent already fixed: skip to Phase 1.
- Ask only the minimum blocking questions. Prefer a documented default for
  non-critical preferences.
- **Do not** default to `opentrons-protocol-library` for new authoring. Use it **only** if the user explicitly wants to search the reference catalog or find an existing protocol example.

### Phase 1 — Protocol

- Author or revise Python with `opentrons-protocol-author`.
- Code must match Phase 0 outputs (requirements, labware slots, pipette names,
  trash on Flex, volumes).
- Record `critical_sources` into the session liquid source map (`record_liquid_source_map`)
  with `critical: true` or roles such as `wash_buffer` / `enzyme`.
- Protocols should expose `dry_run_on` (default `False`). It changes only tip
  disposal: returned to the pickup position in dry mode, discarded normally in
  wet mode.

### Phase 2 — Simulation Gate (blocking)

- `doctor_local_runtime` -> `simulate_protocol` -> `parse_simulation_output`
- Before `simulate_protocol`, when you have proposed protocol steps, pass
  `virtual_lab_steps` (plus `session_id` / `initial_state`) so the Virtual Lab
  State gate runs deterministically **before** Python spawns: it blocks overflow,
  source depletion (aspirate > volume − dead_volume), single-use tip reuse, and
  missing prerequisites. Use `skip_virtual_lab_state_validation=true` only inside
  `opentrons-simulation-repair` when intentionally simulating a known-bad protocol.
- Or `opentrons-simulation-repair` for the edit loop.
- **Failure here -> STOP for live.** No workaround.
- If simulation fails, keep ownership of the repair loop when possible instead of
  pushing the user back to raw logs without guidance.

### Phase 3 — Live Preflight (3a → 3b → 3c, mandatory order)

Finish each sub-gate before the next. Emit `output-contract` status JSON with
`subphase`: `dashboard` | `deck_vision` | `critical_probe`.

#### Continue-vs-ask (agents must follow)

| Tool / gate result | Agent action |
|--------------------|--------------|
| `passed` or skip-pass (incl. zero critical wells) | **CONTINUE** next subphase. No verbal re-confirm. |
| Vision mismatch / `deck_truth_requires_reconcile` / needs reconcile | Call `reconcile_state` (and other allowed auto tools) **before** asking the human. |
| Bookkeeping failure (source map missing, pending probe writeback) with tools available | Run the tools (`record_liquid_source_map`, `apply_liquid_probe_results`, …). Do **not** escalate to human as the first reaction. |
| Hard stop / door / estop / empty critical after tools | **STOP**; escalate with a clear next physical action. |
| Ready for motion (`run_protocol` / live `probe_wells`) | **One** final human confirmation for go-live. Fold any needed live-probe opt-in (`OPENTRONS_ENABLE_PROBE_WELLS=1`) into that same confirm when Phase 3c requires live probe. |

Keep the simulation gate, hard-stops, and vision **observation-only**. Never treat YOLO/VLM as committed deck truth.

#### Phase 3a — Dashboard (no camera, no VLM)

- `health_check` -> `live_readiness_check` (robot_ip, session_id?, file_path?)
- `robot_status`, `module_status` — door closed, estop clear, modules ready
- If `guidance.reconcile_first` or session needs reconciliation -> `reconcile_state` (tool-first; do not ask first)
- **Do not** call `camera_status`, `capture_preview_image`, `vision_check`, or any VLM here
- **Fail** on `DOOR_OPEN`, `ESTOP_ENGAGED`, `MODULE_NOT_READY` (hard blockers)
- On `passed` / warn-continue -> proceed to 3b **without** asking the operator to re-confirm dashboard

#### Phase 3b — Eyes on deck (YOLO first, Ark VLM second opinion)

- Default: `deck_vision_check` (robot_ip, session_id, expected_layout)
  OR manual chain: `camera_status` -> `capture_preview_image` -> `vision_check`
- YOLO is the first opinion. Escalate to `analyze_image_with_ark` (Doubao) only when:
  - `uncertainties` include low confidence / ambiguity
  - `mismatches` against `expected_layout`
  - operator sets `force_vlm=true`
- Skip when `OPENTRONS_PREFLIGHT_VISION=off`
- Vision is **observation-only** — never treat as deck truth
- On consensus `passed` (YOLO clear, or VLM second opinion agrees / no actionable mismatch) -> continue to 3c **without** verbal re-confirm
- On mismatch / needs reconcile -> call `reconcile_state` **before** asking the human; only escalate if still blocked after reconcile and allowed auto tools
- Setup: `policy/workflows.md` *Preflight deck vision*

#### Phase 3c — Critical wells only (no VLM)

- `list_critical_probe_targets` (session_id, critical_sources from intent)
- If the list is empty (zero critical) -> treat as **skip-pass** and continue toward the single go-live confirm; do not invent a full-plate scan or ask for probe permission
- Probe **only** returned critical wells — never full-plate scan
- `probe_wells` simulate first. Live probe still requires `OPENTRONS_ENABLE_PROBE_WELLS=1` + explicit opt-in, but **do not** add a separate chat confirm for every subgate — fold probe opt-in into the Phase 4 go-live confirmation when possible
- After live probe: `apply_liquid_probe_results` -> `live_liquid_recovery_gate` (bookkeeping/writeback is tool-first; do not ask the human to “please apply results” when the tool is available)
- Default mode for go/no-go: `require_presence`
- Empty critical source after probe/gate -> **blocked**, do not `run_protocol`

- After MCP/host restart or when the operator is lost: prefer **`safe_next_action`**
  for `recommended_next_tool` and `operator_steps`; fall back to **`restart_review`**
  for the full raw bundle.
- Before `home`: `is_home_safe`.

### Phase 4 — Execute (quiet by default)

- **Single go-live confirmation** happens here (once): short ready-state summary + ask to start `run_protocol` / play. If live critical probe is still pending and allowed, include probe opt-in + `OPENTRONS_ENABLE_PROBE_WELLS=1` in **this same** confirmation — do not stack earlier Phase 3 chat confirms.
- `run_protocol` (file_path, robot_ip, session_id).
- Simulation gate also runs inside this tool.
- After a successful `run_protocol` call that returns a `run_id`, immediately call `runtime_watch_poll` for that run.
- If `runtime_watch_poll.status == "running"`, immediately call `runtime_watch_poll` again and do not emit user-facing text between poll windows.
- Only report when `runtime_watch_poll` returns `completed`, `needs_user`, `hard_stop`, or `unreachable`.
- **Quiet execution contract:** while the run is active, do **not** call
  `capture_preview_image`, `vision_check`, `analyze_image_with_ark`, `deck_vision_check`,
  or `probe_wells` unless Phase 5 recovery routing explicitly requires it.
- **For unattended / "keep going until done" runs**, arm `runtime_watch_loop` instead of repeated manual polls (see `opentrons-experiment-goal`). It reuses `runtime_watch_poll` on a budgeted schedule, persists `goal-state.json`, and emits outbox sentinels so the host IDE can auto-wake. Default `self_test_mode=observe`; guarded L0 self-fix requires `allow_l4_execution=true` + `operator_opt_in=true`.
- Before this phase, give the operator a short ready-state summary rather than a
  long internal trace.
- Include the resolved `dry_run_on` value in that summary. If `True`, require
  operator confirmation that no liquids are loaded and that the returned-tip
  rack will be replaced or segregated before any wet run (same go-live turn when possible).

### Phase 5 — Failure / Recovery (trigger routing)

- Default path after `run_protocol` is the bounded `runtime_watch_poll` loop above.
- `run_history` -> `parse_error` -> `suggest_recovery_action`.
- Use `recovery_channel` from `suggest_recovery_action` to route:

| Channel | Trigger examples | Tools |
|---------|------------------|-------|
| **dashboard** | door open, estop, module not ready | `robot_status`, `module_status`, `live_readiness_check` |
| **vision** | deck moved, labware mismatch (appearance doubt) | `deck_vision_check` or capture+vision+ark, then **`reconcile_state` before asking human** |
| **reconcile** | SESSION_NEEDS_RECONCILIATION / state mismatch | `reconcile_state` first — not camera/VLM-first |
| **manual** | DECK_COLLISION (hard-stop) | stop; physical check; re-run live_readiness — **does not enter vision channel** |
| **probe** | liquidNotFound, INSUFFICIENT_VOLUME | `live_liquid_recovery_gate`, targeted `probe_wells` only |
| **tip** | TIP_PHYSICALLY_MISSING | `recover_tip_pickup` / L0 retry |

- Execute only branches that come back with `auto_executable: true`: `execute_protocol_recovery` / `recover_tip_pickup`.
- Hard stops (`DECK_COLLISION`, etc.) and DESTINATION_OCCUPIED human-review rules per `policy/safety-policy.md` and `policy/error-response.md`. `DECK_COLLISION` is manual hard-stop — do **not** route it to vision.
- After door/module recovery, re-run Phase 3a before resume; deck appearance doubt -> Phase 3b; liquid doubt -> targeted probe only.

### Phase 6 — Audit

- `experiment_history` (session_id, run_id, tool_name, status, limit).
- `restart_review` again if operators rotate or context lost.

## Safety Refusals — Offer Alternative Path

When refusing an unsafe request, **always immediately offer the corrective action**:

| User asks | Agent refuses AND offers |
|-----------|-------------------------|
| "绕过仿真直接跑" | "不能跳过仿真。把报错信息给我，我现在帮你修" |
| "collision 了自动重试" | "碰撞后不能自动重试。请先：1) 检查 deck 有无移位 2) 确认 pipette 完好 3) 完成后我跑 reconcile_state" |
| "不管报错继续跑" | "硬件故障需要人工检查。检查完告诉我结果，我帮你判断下一步" |
| "运行中每步都拍照" | "正式运行默认安静，靠错误码和恢复流程；出事了才按触发器调眼睛/手指" |

## Handoff

- Sim-stuck: `opentrons-simulation-repair` or `opentrons-protocol-author`.
- No MCP: `opentrons-robot-lan` (explicit fallback only).
- Search existing Opentrons examples: `opentrons-protocol-library` (user-requested only).
