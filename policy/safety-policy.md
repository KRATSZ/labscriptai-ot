# Safety policy (canonical)

This file is the **single source of truth** for safety rules and hard bans in this repository. `AGENTS.md`, compatibility stubs, and the root `README.md` only summarize and link here.

## Hard bans (do not violate)

1. **Simulation gate is blocking before unattended live execution.** If `simulate_protocol` or `health_check(scope=local)` fails, fix the protocol or environment before live play. Read-only diagnostics may still run to understand the robot state.
2. **Live execution prefers MCP, with HTTP fallback as a formal route.** Use MCP `run_protocol` by default. Use `opentrons-robot-lan` / robot HTTP when MCP is unavailable, when debugging MCP itself, or when the operator explicitly chooses the HTTP route. Do not run MCP and HTTP control commands against the same robot at the same time.
3. **Hardware errors → MCP recovery pipeline.** `parse_error` → `suggest_recovery_action` → `execute_protocol_recovery`. No improvised commands.
4. **Logs are audit-only.** `query_history(scope=experiment_logs)` is post-hoc review. Current deck truth: `reconcile_state` and `robot_status`.
5. **No parallel MCP + HTTP/scripts on the same robot.**
6. **Actual hardware stops require review.** Do not blindly retry a collision, hardware fault or unknown runtime error. Unsupported software analysis and unavailable optional readings are not hardware faults.

## Additional safety rules

- **Read-only live gate first when requested**: use `live_readiness_check` before `create_run` or `play` when the operator asks for a cautious live readiness pass. `health_check` alone is not enough for live go/no-go decisions.
- **DESTINATION_OCCUPIED**: Alternative slots are always human-reviewed. No automatic reroute outside `execute_protocol_recovery`.
- **Safe home**: `home` only when there are no blockers, no tip cleanup pending, and `needs_reconciliation` is false (use `is_home_safe` before homing when applicable).
- **Simulation** should use the project venv: `.venv/bin/python` (or `uv run python`) for normal simulate paths. If another Opentrons runtime is selected, record the path in the command or run notes.
- **Physical deck**: Never assume layout — read actual state via MCP or the configured `PLUGIN_DATA/session-state/` JSON.
- **Modules**: Do not `load_module` for hardware you are not using.
- **Dry-run returned tips**: `dry_run_on` defaults to false. Enable it only for
  clean, liquid-free physical motion tests. Every tip must return to its original
  pickup position via `return_tip()`. Returned tips remain used/potentially
  contaminated and must be segregated or replaced before any wet protocol.

## Vision and camera

Vision / `deck_vision_check(mode=local)` / `deck_vision_check` is **observation-only**. It does not mutate session state or override `reconcile_state`. Never treat vision as committed deck truth — always compare with robot APIs and reconciled deck state.

**Optional Phase 3b uses observation-only vision** when configured or requested (`OPENTRONS_PREFLIGHT_VISION=on`). An unavailable vision check is reported as not checked; include deck-layout confirmation in the scoped motion authorization. Ad-hoc vision outside preflight remains available when useful (see [workflows.md](workflows.md)).

On vision uncertainty or soft mismatch: prefer **auto-reconcile** (`reconcile_state`, re-check APIs) before any human ask. Sensor-aligned agreement (e.g. VLM agrees with expected layout) is a machine **pass**, not a prompt to confirm the subgate. See HumanConfirmBudget in [output-contract.md](output-contract.md).

## Operator-selected checks

- Liquid probing and deck vision are optional. A critical-source list recommends probe targets; it does not mandate probing. If probing is disabled, unavailable or declined, record `not_checked` / `skipped` and continue the ordinary run workflow. `OPENTRONS_ENABLE_PROBE_WELLS=1` gates **live probe motion only**, not `run_protocol`. Do not ask to enable it when the operator has declined probing.
- LogicPass `unevaluable` means unsupported analysis, not an observed liquid-handling fault. Report the reason once. When the operator explicitly says to skip the ledger for this run/test, use `run_protocol(skip_logicpass_gate=true)`. When they explicitly waive the software preflight, use `skip_preflight=true`; use `skip_preflight_deck_diff=true` for a deck-diff-only waiver. Apply only the requested scope. These existing tool options are supported actions, not forbidden workarounds.
- “Skip these checks and start this test; I will stop it manually” authorizes that unchanged run and the named omissions. Do not require special wording, another risk-acceptance prompt, or a probe environment flag. Record what was skipped without changing it to passed. “Test” does not imply `dry_run_on=true` or justify silently editing the protocol.
- A missing door/estop reading is `not_checked`, not closed/clear and not a detected fault. Surface it briefly for operator awareness. Known hardware faults, an engaged estop and robot interlocks retain their actual state; never disable interlocks or fabricate a successful check. Local simulation remains required by `run_protocol`.

## Runtime defaults

- Open-ended experiment or robot questions → start from `opentrons-experiment-run`.
- Live readiness / staged bring-up questions → prefer `live_readiness_check`, then `create_run`, then the smallest safe live run.
- After MCP or host restart → prefer `safe_next_action` (or `safe_next_action(detail=full)`) before chaining `reconcile_state` and live status tools.

## Interaction defaults

- Default operator experience: bundle blocking questions, then use scoped authorization before the first physical motion, including a live probe; see [HumanConfirmBudget](workflows.md#humanconfirmbudget-go-live). Follow up if a required fact remains unknown.
- Do **not** stack verbal confirms on passing checks or repeat authorization for the same protocol/deck/action. Follow explicit operator choices about optional checks; see below.
- Escalate vs auto-fix: `auto_fixable` → agent tools; `needs_operator_physical_action` → physical fix; `needs_confirmation` → authorization before uncovered motion; `blocked` → stop with reason.
- If a runnable protocol exists, simulation is the default next step.
- Only block on missing information that changes safety, deck truth, robot type, labware compatibility, or required modules.
- Safety refusals must include a compliant alternative path.

## See also

- Workflows: [workflows.md](workflows.md)
- Error taxonomy and recovery: [error-response.md](error-response.md)
- Operator UX: [output-contract.md](output-contract.md)
