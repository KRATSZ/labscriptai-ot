---
name: opentrons-experiment-run
description: Default entry for new experiments, "what's the robot doing?", resume, and recovery — orchestrates MCP state machine from intent through simulation gate to live execution.
type: prompt-only
mcp_tools:
  - robot_status
  - robot_status
  - simulate_protocol
  - logicpass_check
  - reconcile_state
  - run_protocol
  - runtime_watch(mode=poll)
  - runtime_watch(mode=loop)
  - runtime_outbox(action=list)
  - runtime_outbox(action=ack)
  - runtime_alerts(action=list)
  - runtime_alerts(action=ack)
  - parse_error
  - suggest_recovery_action
  - execute_protocol_recovery
  - recover_tip_pickup
  - tip_wells(action=list)
  - estimate_tip_budget
  - tip_wells(action=suggest_next)
  - live_readiness_check
  - live_liquid_recovery_gate
  - probe_wells
  - apply_liquid_probe_results
  - liquid_source_map(action=critical_targets)
  - liquid_source_substitution(action=plan)
  - liquid_source_substitution(action=prepare_recovery)
  - drop_attached_tip
  - safe_next_action
  - safe_next_action(detail=full)
  - query_history(scope=experiment_logs)
  - is_home_safe
  - health_check
  - camera_settings(action=status)
  - capture_image(mode=preview)
  - deck_vision_check(mode=local)
  - analyze_image(provider=ark)
  - deck_vision_check
  - control_run
  - query_history(scope=robot_runs)
  - query_history(scope=run_commands)
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

- `health_check(scope=local)` -> `simulate_protocol` (its response already includes `parsed_repair`)
- Then `logicpass_check` on the same protocol. It reuses the analyze JSON from `simulate_protocol`. `outcome: pass` is required before live; `fail` goes back to the repair loop; `unevaluable` stops and reports the missing evidence.
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
- `robot_status(include_modules=true)` — door closed, estop clear, modules ready
- If `guidance.reconcile_first` or session needs reconciliation -> `reconcile_state` (tool-first; do not ask first)
- **Do not** call `camera_settings(action=status)`, `capture_image(mode=preview)`, `deck_vision_check(mode=local)`, or any VLM here
- **Fail** on `DOOR_OPEN`, `ESTOP_ENGAGED`, `MODULE_NOT_READY` (hard blockers)
- On `passed` / warn-continue -> proceed to 3b **without** asking the operator to re-confirm dashboard

#### Phase 3b — Eyes on deck (YOLO first, Ark VLM second opinion)

- When configured or requested: `deck_vision_check` (robot_ip, session_id, expected_layout)
  OR manual chain: `camera_settings(action=status)` -> `capture_image(mode=preview)` -> `deck_vision_check(mode=local)`
- YOLO is the first opinion. Escalate to `analyze_image(provider=ark)` (Doubao) only when:
  - `uncertainties` include low confidence / ambiguity
  - `mismatches` against `expected_layout`
  - operator sets `force_vlm=true`
- Vision is optional. Enable the configured path with `OPENTRONS_PREFLIGHT_VISION=on`; otherwise skip it. If unavailable, report it as **not checked** and include a physical deck-layout check in the final go-live confirmation. Never label a missing vision check as passed.
- Vision is **observation-only** — never treat as deck truth
- On consensus `passed` (YOLO clear, or VLM second opinion agrees / no actionable mismatch) -> continue to 3c **without** verbal re-confirm
- On mismatch / needs reconcile -> call `reconcile_state` **before** asking the human; only escalate if still blocked after reconcile and allowed auto tools
- Setup: `policy/workflows.md` *Preflight deck vision*

#### Phase 3c — Critical wells only (no VLM)

- `liquid_source_map(action=critical_targets)` (session_id, critical_sources from intent)
- If the list is empty (zero critical) -> treat as **skip-pass** and continue toward the single go-live confirm; do not invent a full-plate scan or ask for probe permission
- Probe **only** returned critical wells — never full-plate scan
- `probe_wells` simulate first. Live probe still requires `OPENTRONS_ENABLE_PROBE_WELLS=1` + explicit opt-in, but **do not** add a separate chat confirm for every subgate — fold probe opt-in into the Phase 4 go-live confirmation when possible
- After live probe: `apply_liquid_probe_results` -> `live_liquid_recovery_gate` (bookkeeping/writeback is tool-first; do not ask the human to “please apply results” when the tool is available)
- Default mode for go/no-go: `require_presence`
- Empty critical source after probe/gate -> **blocked**, do not `run_protocol`

- After MCP/host restart or when the operator is lost: prefer **`safe_next_action`**
  for `recommended_next_tool` and `operator_steps`; fall back to **`safe_next_action(detail=full)`**
  for the full raw bundle.
- Before `home`: `is_home_safe`.

### Phase 4 — Execute (quiet by default)

- **Single go-live confirmation** happens here (once): short ready-state summary + ask to start `run_protocol` / play. A person must be at the robot and say so in this conversation. Simulation and LogicPass do not authorize motion. If that confirmation is missing, stop. Do not call `run_protocol` or `control_run(play)` on a non-loopback robot. If live critical probe is still pending and allowed, include probe opt-in + `OPENTRONS_ENABLE_PROBE_WELLS=1` in **this same** confirmation — do not stack earlier Phase 3 chat confirms.
- `run_protocol` (file_path, robot_ip, session_id).
- Simulation gate also runs inside this tool.
- After a successful `run_protocol` call that returns a `run_id`, immediately call `runtime_watch(mode=poll)` for that run.
- If `runtime_watch(mode=poll).status == "running"`, immediately call `runtime_watch(mode=poll)` again and do not emit user-facing text between poll windows.
- Only report when `runtime_watch(mode=poll)` returns `completed`, `needs_user`, `hard_stop`, or `unreachable`.
- **Quiet execution contract:** while the run is active, do **not** call
  `capture_image(mode=preview)`, `deck_vision_check(mode=local)`, `analyze_image(provider=ark)`, `deck_vision_check`,
  or `probe_wells` unless Phase 5 recovery routing explicitly requires it.
- **For "keep going until done" runs**, arm `runtime_watch(mode=loop)` instead of repeated manual polls. Use it only when the operator asks for continued monitoring; one-shot checks use `runtime_watch(mode=poll)`. The loop has a finite turn/time budget, persists its goal state, and records events for MCP review. Default `self_fix_mode=observe`; guarded L0 self-fix requires `self_fix_mode="l0"`, `allow_l4_execution=true`, and `operator_opt_in=true`.

#### Continuous monitoring and resume

- `runtime_watch(mode=loop)` is the source of truth for a continued run. Stop and report `needs_user`, `hard_stop`, or `unreachable`; never auto-retry a hard stop.
- Claim completion only after the loop reports complete and `query_history(scope=experiment_logs)` confirms success.
- If the budget expires while the run is still active, report that and resume by `goal_id` with an explicit budget. After a human resolves a blocker, acknowledge the alert and reconcile state before resuming.
- Before this phase, give the operator a short ready-state summary rather than a
  long internal trace.
- Include the resolved `dry_run_on` value in that summary. If `True`, require
  operator confirmation that no liquids are loaded and that the returned-tip
  rack will be replaced or segregated before any wet run (same go-live turn when possible).

### Phase 5 — Failure / Recovery (trigger routing)

- Default path after `run_protocol` is the bounded `runtime_watch(mode=poll)` loop above.
- `query_history(scope=run_commands)` -> `parse_error` -> `suggest_recovery_action`.
- Use `recovery_channel` from `suggest_recovery_action` to route:

| Channel | Trigger examples | Tools |
|---------|------------------|-------|
| **dashboard** | door open, estop, module not ready | `robot_status(include_modules=true)`, `live_readiness_check` |
| **vision** | deck moved, labware mismatch (appearance doubt) | `deck_vision_check` or capture+vision+ark, then **`reconcile_state` before asking human** |
| **reconcile** | SESSION_NEEDS_RECONCILIATION / state mismatch | `reconcile_state` first — not camera/VLM-first |
| **manual** | DECK_COLLISION (hard-stop) | stop; physical check; re-run live_readiness — **does not enter vision channel** |
| **probe** | liquidNotFound, INSUFFICIENT_VOLUME | `live_liquid_recovery_gate`, targeted `probe_wells` only; then **same-identity reserve proposal** (below) |
| **tip** | TIP_PHYSICALLY_MISSING | tip-budget gate (below) → only then `recover_tip_pickup` / L0 retry |

- Execute only branches that come back with `auto_executable: true`: `execute_protocol_recovery` / `recover_tip_pickup`.
- Hard stops (`DECK_COLLISION`, etc.) and DESTINATION_OCCUPIED human-review rules per `policy/safety-policy.md` and `policy/error-response.md`. `DECK_COLLISION` is manual hard-stop — do **not** route it to vision.
- After door/module recovery, re-run Phase 3a before resume; deck appearance doubt -> Phase 3b; liquid doubt -> targeted probe only.

#### FIX / STOP decision gates (required before motion)

These gates override “tool says auto_executable” and override casual user “just continue” pressure. Canonical detail: `policy/error-response.md` § Agent FIX/STOP decision gates.

**1) Tip budget (STOP before depleting later steps)**

Before any `recover_tip_pickup` / `retry_pick_up_tip_with_next_candidate`:

1. Count **remaining** protocol `pick_up_tip` / tip-consuming steps still needed (including the failed one).
2. Call `tip_wells(action=list)` / `estimate_tip_budget` (or rack bookkeeping from run history) for usable tips left.
3. Allow auto tip recovery **only if** `usable_tips_remaining ≥ remaining_tip_pickups`.
4. If short → **STOP**; escalate with tip count math; do **not** burn the last tips on retries that still cannot finish the protocol.

**2) Hold / time window (STOP on strict timeout)**

Before `control_run(play)` / resume after pause or operator hold:

1. Parse protocol comments, RTP, or `design-notes` for `max_hold_minutes` / “must complete within N minutes” / `strict_window`.
2. Compute elapsed wall time since the hold-sensitive phase started (or since pause if that is the annotated start).
3. If elapsed **>** allowed window → default **STOP**. Offer: discard / re-prep time-critical reagent / operator override with explicit risk acceptance. Do **not** silently `play`.
4. If hold-tolerant / short pause within window → status check (`robot_status`) then resume is OK.

**3) Contamination (STOP sample-wet tip into common stock)**

If the attached tip contacted a **sample** or **waste** well, refuse any command that aspirates from a shared stock / reservoir with that tip. Required path: drop tip → fresh tip → then stock access. Same-reagent re-probe / continue on the **same** reagent well may keep the tip only when policy and protocol allow.

**4) Precious / mid-dispense fault (STOP — no blind top-up)**

If a precious or quantitative destination already received a partial aliquot and the next aliquot / dispense failed (overpressure, clog, collision): **STOP**. Do **not** re-aspirate and “make up” the missing volume. Escalate concentration / quantification risk to the operator.

**5) Low-stakes waste / discard path clog (FIX)**

When the failed step is clearly wash/discard/waste (not mid precious dispense):

1. Do **not** resume the failed liquidProbe/aspirate on the clogged tip.
2. Stop or leave recovery as needed; clear clogged tip safely (`drop_attached_tip` with trash-centered drop — see cleanup note).
3. If tip budget allows: fresh tip → retry **only** the unfinished discard/wash step (continuation / validated recovery path).
4. If drop/cleanup hits stall/collision → **hard stop**; physical clear before any further motion.

**Cleanup note:** Prefer protocol-context drop when still valid. Maintenance `drop_attached_tip` must use trash-centered drop (`alternate_drop_location=false`). After overpressure at a low Z, prefer operator physical tip removal if path is uncertain — do not invent motor “wiggle” fixes.

**6) Primary empty + same-identity reserve (FIX proposal — never silent swap)**

On `liquidNotFound` / `INSUFFICIENT_VOLUME` for a mapped primary source:

1. Call `live_liquid_recovery_gate` (and targeted probe if needed).
2. Call `liquid_source_substitution(action=plan)` (and/or `liquid_source_substitution(action=prepare_recovery)` when preparing a validated continuation).
3. If a **same-liquid / same-identity** reserve has **enough volume** for the remaining demand → present a clear FIX proposal to the operator (failed well, candidate reserve, remaining µL needed, confirmation required).
4. **Never** auto-switch source wells or auto-resume substitution. Short reserve → **STOP** (do not “add a little anyway”).
5. Wrong-identity wells (wash vs assay, enzyme vs buffer) are never candidates.

### Resume gate (paused → play)

Any user “continue / resume / finish phase 2” request still runs gates **2** (time window), **3** (contamination), and a quick `robot_status` check before `control_run(play)`.

### Phase 6 — Audit

- `query_history(scope=experiment_logs)` (session_id, run_id, tool_name, status, limit).
- `safe_next_action(detail=full)` again if operators rotate or context lost.

## Safety Refusals — Offer Alternative Path

When refusing an unsafe request, **always immediately offer the corrective action**:

| User asks | Agent refuses AND offers |
|-----------|-------------------------|
| "绕过仿真直接跑" | "不能跳过仿真。把报错信息给我，我现在帮你修" |
| "collision 了自动重试" | "碰撞后不能自动重试。请先：1) 检查 deck 有无移位 2) 确认 pipette 完好 3) 完成后我跑 reconcile_state" |
| "不管报错继续跑" | "硬件故障需要人工检查。检查完告诉我结果，我帮你判断下一步" |
| "运行中每步都拍照" | "正式运行默认安静，靠错误码和恢复流程；出事了才按触发器调眼睛/手指" |
| "tip 不够也再试一根 / 换孔继续" | "剩余 tip 不足以完成后续取 tip 步骤，不能再耗 tip 重试。需要补 tip 或缩步骤后再开；我可以按 tip budget 算给你看" |
| "超时了也继续加酶 / 接着跑 Phase 2" | "已超过协议时间窗，默认停止。可选：作废本孔、换新时效试剂后重开、或你明确接受风险后我再 resume" |
| "tip 还挂着直接去吸母液 / 用当前 tip 补 buffer" | "当前 tip 已碰过样品，不能进公共母液。必须先丢 tip，换新 tip 后再吸 stock" |
| "贵样少加了再补一枪" | "中途故障后不能盲补加，浓度会偏。先停；由你决定作废、计量重做或接受偏差" |

## Handoff

- Sim-stuck: `opentrons-simulation-repair` or `opentrons-protocol-author`.
- No MCP: `opentrons-robot-lan` (explicit fallback only).
- Search existing Opentrons examples: `opentrons-protocol-library` (user-requested only).
