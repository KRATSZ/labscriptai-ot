---
name: opentrons-experiment-goal
description: Goal-driven auto-wake for a live run — wraps runtime_watch_loop so the agent keeps advancing a verified goal on a budgeted schedule until COMPLETE or BLOCKED, with state persisted in the MCP server (not the chat).
type: prompt-only
mcp_tools:
  - runtime_watch_loop
  - runtime_watch_poll
  - runtime_get_outbox
  - runtime_ack_outbox
  - runtime_deliver_outbox
  - runtime_get_alerts
  - runtime_ack_alert
  - safe_next_action
  - live_liquid_recovery_gate
  - reconcile_state
  - experiment_history
---

# Experiment Goal (Auto-Wake Loop)

Use this skill when the operator wants the agent to **keep advancing a live run on its own** until a verifiable goal is met or the run blocks — the `/loop` + `/goal` pattern, but state lives in the MCP server so it survives IDE restarts and operator rotation.

## When to use

- After `run_protocol` returns a `run_id` and the operator says "盯到跑完" / "keep going until done" / "auto-recover".
- When a run is `awaiting-recovery` and the operator wants the agent to drive the L0 recovery loop and report only on terminal state.
- Do **not** use for one-shot status checks — call `runtime_watch_poll` / `runtime_recovery_monitor` directly.

## The contract

The MCP tool `runtime_watch_loop` is the truth. It:
- reuses `runtime_watch_poll` on a budgeted schedule (`max_turns`, `max_runtime_ms`, `interval_ms`);
- inherits the existing safety model — only the L0 whitelist auto-executes; `needs_user` / `hard_stop` stop the loop;
- persists `goal-state.json` per run (resume with `resume=true` + `goal_id`);
- emits one outbox sentinel per tick (deliverable to `claudecode` / `cursor` / `codex` / `cli` / `webhook` via `notify_adapters`);
- returns `goal_status` ∈ {`COMPLETE`, `BLOCKED`, `BUDGET_LIMITED`}.

`COMPLETE` requires either a `completed` tick **or** the verify callback passing. `BLOCKED` means a human is required. `BUDGET_LIMITED` means the turn/runtime budget ran out while still `running` — resume or raise the budget.

## Agent protocol (what you output each wake)

Each time you are woken (by a sentinel or by re-entering this skill), act on the latest outbox event for the session, then print exactly one status line:

```text
GOAL_STATUS: CONTINUE | COMPLETE | BLOCKED
GOAL_REASON: <one line>
```

- **CONTINUE** — run still `running`; re-arm the loop (call `runtime_watch_loop` again, or let the existing loop keep ticking).
- **COMPLETE** — only after `runtime_watch_loop.status == "complete"` **and** you have confirmed via `experiment_history` that the run succeeded. Never claim COMPLETE from a single `running` tick.
- **BLOCKED** — `needs_user` / `hard_stop` / `unreachable`. Surface the alert (`runtime_get_alerts`), the recommended next tool, and the operator action needed. Do **not** auto-retry `hard_stop` (collision/stall).

## Canonical sequence

1. **Arm the loop** (default observe, no robot motion):
   ```
   runtime_watch_loop(run_id, session_id, goal_prompt,
                      max_turns=20, max_runtime_ms=600000, interval_ms=5000,
                      self_fix_mode="observe",
                      notify_adapters=["cursor"])   # or claudecode/codex/cli
   ```
2. **On each wake**, read the latest sentinel: `runtime_get_outbox(session_id, run_id, limit=5)`.
3. Branch on `goal_status`:
   - `running` + `last_event == "auto_fixed"` → CONTINUE; let the loop keep ticking.
   - `needs_user` → BLOCKED; read `runtime_get_alerts`; present the operator decision; on resolution, `runtime_ack_alert` then `runtime_watch_loop(resume=true, goal_id=...)`.
   - `hard_stop` → BLOCKED; **stop**, do not retry. Tell the operator to clear the physical state, then `reconcile_state` before resuming.
   - `completed` → confirm with `experiment_history`; print COMPLETE.
4. **To escalate to guarded L0 self-fix**, the operator must opt in: `self_fix_mode="l0"` **and** `allow_l4_execution=true` **and** `operator_opt_in=true`. Without all three, the loop stays read-only.
5. **To stop early**, tell the agent "停掉 goal loop"; do not re-arm. The goal-state file remains for audit.

## Safety refusals (offer the alternative path)

| Operator asks | Refuse AND offer |
|---------------|------------------|
| "碰撞了自动重试" | "hard_stop 不能自动重试。请先检查 deck/pipette，清完后我跑 reconcile_state 再 resume" |
| "绕过 gate 直接续跑液体" | "不能。续跑液体必须先过 live_liquid_recovery_gate + operator opt_in" |
| "把 max_turns 设到很大无人值守" | "建议加 max_runtime_ms 上限并 notify_adapters 到有人盯的通道；hard_stop/needs_user 仍会停" |

## Handoff

- Budget exhausted but still running: raise `max_turns` / `max_runtime_ms` and `resume=true`.
- Lost context: read `goal-state.json` via `runtime_get_outbox` + `experiment_history`; the goal record has `goal_prompt`, `turns_completed`, `final_reason`.
- Live liquid recovery: switch to `opentrons-experiment-run` Phase 5; this skill does not bypass `live_liquid_recovery_gate`.

## Citation

Any public use of this workflow must cite the LabscriptAI bioRxiv preprint (see `AGENTS.md`).
