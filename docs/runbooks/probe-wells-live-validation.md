# Runbook: Flex `probe_wells` live validation

Validate Opentrons Flex **Liquid Presence Detection (LPD)** on real hardware before relying on it in recovery or pre-run workflows.

## Prerequisites

- Opentrons Flex with apiLevel **≥ 2.24**
- Conductive Flex tips loaded on deck
- Source well contains a conductive aqueous liquid (e.g. water in `nest_12_reservoir_15ml` well A1)
- MCP server running (`health_check` → `required_runtime_tools.all_present=true`)
- Operator available for explicit live-motion confirmation

## Safety

- Live probe motion is **opt-in only**. Set `OPENTRONS_ENABLE_PROBE_WELLS=1` in the MCP server environment.
- Always simulate first (`execute_on_robot=false`). Do not live-probe if simulation fails.
- `probe_wells` generates a temporary protocol that picks up tips, probes, and drops tips — no aspirate/dispense of sample liquid.

## Step 1 — Simulate locally

Call MCP `probe_wells` with:

| Parameter | Example |
|-----------|---------|
| `pipette_name` | `flex_1channel_1000` |
| `mount` | `left` |
| `tiprack_load_name` | `opentrons_flex_96_tiprack_1000ul` |
| `tiprack_slot` | deck slot of tip rack |
| `labware_load_name` | `nest_12_reservoir_15ml` |
| `labware_slot` | deck slot of source labware |
| `wells` | `["A1"]` |
| `mode` | `detect_presence` (then repeat for other modes) |
| `execute_on_robot` | `false` |

Confirm `parsed_simulation_output.success=true`.

## Step 2 — Enable live probe

1. Confirm deck layout matches parameters above (`reconcile_state`, `robot_status`).
2. Set environment variable on MCP host: `OPENTRONS_ENABLE_PROBE_WELLS=1`
3. Reload MCP client if the server was already running.

## Step 3 — Live probe

Before motion, confirm a person is at the robot and obtain authorization for the live probe (and optionally the planned experiment conditional on all checks passing). Then re-run `probe_wells` with:

- `execute_on_robot=true`
- `robot_ip=<flex-ip>`
- `session_id=<your-session>`
- `auto_apply_to_session=true` (recommended — writes results to session state)

## Step 4 — Verify results

Check `probe_results` in the tool response:

```json
{"well":"A1","mode":"detect_presence","success":true,"value":true}
```

| Mode | Expected `value` |
|------|------------------|
| `detect_presence` | `true` if liquid present, `false` if empty |
| `require_presence` | `true` when liquid present; run fails if empty |
| `measure_height` | positive number (mm from well top) when liquid present |

If `auto_apply_to_session=true`, confirm `apply_liquid_probe_results.applied_count ≥ 1` and call `liquid_source_map(action=get)` to see `observed_presence` / `observed_height_mm`.

## Step 5 — Recovery gate

```
live_liquid_recovery_gate (session_id, robot_ip)
```

Gate should pass when observed presence matches expected sources, or provide actionable `allowed_next_tools` (`probe_wells`, `apply_liquid_probe_results`).

## Troubleshooting

| Symptom | Likely cause | Action |
|---------|--------------|--------|
| `Live probe_wells execution is disabled` | Missing env flag | Set `OPENTRONS_ENABLE_PROBE_WELLS=1` |
| Simulation pass, live false negative | Non-conductive tips or empty well | Verify tips and source volume |
| `measure_height` returns unexpected values | Foam, volatile liquid, wrong labware definition | Try aqueous water first; document liquid class |
| Attached tip blocks rerun | Prior run left tip on pipette | Drop tip manually or use recovery tooling before reprobe |
| Gate still blocked after apply | `expected_presence` mismatch | Review `liquid_source_map(action=get)`; update source map or re-probe |

## Record results

Archive a dated note under `runs/liquid-probe/` with:

- Robot serial / software version
- apiLevel, pipette, tip type, labware
- Three mode results (detect / require / measure)
- Gate outcome after `apply_liquid_probe_results`

## Related

- MCP tools: `probe_wells`, `apply_liquid_probe_results`, `live_liquid_recovery_gate`
- Workflow: [policy/workflows.md](../../policy/workflows.md) — *Optional Flex liquid probe*
- Authoring: [liquid-presence-detection-flex.md](../../skills/opentrons-protocol-author/references/liquid-presence-detection-flex.md)

## Recovery diagnostics and CLI reference

Run `node scripts/verify-setup.mjs --verbose` from the plugin root. These advanced diagnostics are optional for local authoring and preview; use them when recovering or validating a real Flex robot. Replace the example robot IP with your own.

The verifier imports the local MCP server entry and runs `runtime_recovery_self_test` without robot motion. This catches stale or incomplete local installs before live work.

After reloading an MCP client, also run the MCP `health_check` tool itself. The loaded server is current only if:

```json
"mcp_server": {
  "capabilities": {
    "runtime_build": "liquid-source-map-v2"
  }
}
```

If this field is missing, the client is still running an older MCP process even if the local files have been updated.

The loaded `health_check` should also include `mcp_server.required_runtime_tools.all_present=true`. The required runtime tools are the minimum self-recovery surface: `runtime_recovery_self_test`, `safe_next_action`, `safe_next_action(detail=full)`, `validate_virtual_lab_state_steps`, `live_liquid_recovery_gate`, `robot_status(include_modules=true)`, `is_home_safe`, `query_history(scope=experiment_logs)`, `runtime_watch(mode=loop)`, and the liquid source-map tools. If this block is missing, reload or reinstall the plugin before trusting live runtime recovery.

Then run `runtime_recovery_self_test` in the same MCP client. It should return:

```json
{
  "status": "pass",
  "runtime_build": "liquid-source-map-v2"
}
```

This self-test is no-motion and no-network. It checks that the loaded MCP process treats empty-source liquid detection as `INSUFFICIENT_VOLUME`, keeps liquid recovery manual-only, preserves source-map context, and reports attached-tip cleanup instead of inventing an automatic liquid-source change. It covers both an expected-empty source (`D3.A12`, `expected_presence=false`) and an expected-present source that probes as empty (`D3.A1`, `expected_presence=true`, `observed_liquid_presence=false`).

`health_check` accepts either an absolute Python path or a PATH executable such as `python3`. A valid PATH Python with the `opentrons` package installed should report `venv.status="ok"`; it should not be treated as missing just because it is not an absolute path.

Before repeating live liquid recovery tests, run the read-only gate from the repo root:

```bash
node scripts/live-liquid-recovery-gate.mjs --robot-ip 192.168.1.10
```

The gate writes a JSON artifact under `<PLUGIN_DATA>/runs/self-recovery/artifacts/` (default; pass `--out` to override), appends a `live_liquid_recovery_gate_cli` result-log entry, and exits non-zero when prerequisites are not met, for example an attached tip remains or the MCP client still needs a reload check. A non-zero result is a stop signal for live liquid watcher/probe re-runs, not a script failure. The artifact and result-log entry include self-test coverage so the operator can confirm the loaded recovery logic covers both expected-empty and expected-present liquid-probe failures.

When the MCP client is unavailable or you only need the physical robot snapshot, use the standalone read-only status exporter first:

```bash
node scripts/export-real-machine-readonly-status.mjs \
  --robot-ip 192.168.1.10 \
  --session-id self-recovery-liquid \
  --out runs/self-recovery/artifacts/real-machine-readonly-status-latest.json \
  --markdown-out runs/self-recovery/artifacts/real-machine-readonly-status-latest.md
```

This does not use MCP and does not move the robot. It queries only robot HTTP status endpoints, writes a JSON/Markdown artifact, and appends a `real_machine_readonly_status_cli` result-log entry. Treat `blockers` such as `attached_tip:left`, an open door, or engaged estop as a hard stop before live liquid tests.

For the current liquid recovery validation set, use the same named source plan from the command line:

```bash
node scripts/live-liquid-recovery-gate.mjs \
  --robot-ip 192.168.1.10 \
  --session-id self-recovery-liquid \
  --source-plan c3_d3_liquid_recovery \
  --operator-request-md-out runs/self-recovery/artifacts/live-liquid-operator-request-latest.md \
  --operator-request-json-out runs/self-recovery/artifacts/live-liquid-operator-request-latest.json
```

The standalone gate expands the plan to `C3.A1` present, `D3.A1-H1` present, and `D3.A12` absent; checks those entries against the session source map; and prints `recommended_next_action`, `allowed_next_tools`, and `human_required`.

When `--operator-request-md-out` or `--operator-request-json-out` is provided, the standalone gate also writes a short human handoff request derived from `operator_request`. Use this artifact when the agent needs help clearing a physical blocker, filling liquid/sample identity, or reloading the MCP client.

Unknown source plans are blocking errors. The gate refuses to treat a typo as an empty source requirement set.

For one-off checks, `--required-source` accepts `slot.well=present` or `slot.well=absent` values, for example `--required-source D3.A1=present`. Unsupported values are blocking errors.

When running repeated `probe_wells` live checks with the same physical tip rack, set `starting_tip` to the first known fresh tip for that run. This prevents a new run from defaulting back to a tip already consumed by an earlier probe run.

After a live probe run, apply the observation artifact back to the source map without changing the expected source-map intent:

```bash
node scripts/apply-liquid-probe-results.mjs \
  --session-id self-recovery-liquid \
  --probe-artifact runs/self-recovery/artifacts/probe-d3-first-column-live-result-latest.json \
  --slot D3 \
  --labware-load-name corning_96_wellplate_360ul_flat \
  --out runs/self-recovery/artifacts/apply-liquid-probe-results-d3-first-column-latest.json
```

This records `observed_presence`, `observed_run_id`, and `observed_source=live_probe` while preserving `expected_presence`. If an expected-present source probes as absent, `liquid_source_map(action=summarize)` reports `observed_presence_mismatch_count>0` and `ready_for_semantic_recovery=false` until the mismatch is resolved or deliberately corrected.

When the only source-map problem is an expected-present source whose latest live observation is `observed_presence=false`, the normal live-liquid gate still blocks resume. To collect more evidence, use the narrower re-probe gate:

```bash
node scripts/live-liquid-recovery-gate.mjs \
  --robot-ip 192.168.1.10 \
  --session-id self-recovery-liquid \
  --source-plan c3_d3_liquid_recovery \
  --allow-observed-mismatch-reprobe
```

This may downgrade the source-map check from `fail` to `warn` only for targeted no-aspirate `probe_wells` evidence collection. The gate output lists `allowed_probe_targets`; do not use this mode for `runtime_watch(mode=poll)`, `run_protocol` resume, aspirate, or dispense.

For expected-present sources, the gate also warns when the source map only says generic `operator-confirmed-liquid` or omits `sample_id`. This warning does not mean liquid probing is unsafe by itself, but it does mean semantic recovery such as changing sources or resuming sample-dependent work needs human confirmation before any live action.

To inspect this before a gate fails, use the read-only MCP tool `liquid_source_map(action=summarize)`. It reports how many expected-present sources still need a specific `liquid_name` or `sample_id`, whether the current source map is ready for semantic recovery, and a `record_liquid_source_map_template` with the exact wells that need operator-filled identity fields.

If the MCP client has not been reloaded yet, use the equivalent local no-motion CLI from the repo root:

```bash
node scripts/summarize-liquid-source-map.mjs \
  --session-id self-recovery-liquid
```

It calls the local MCP handlers directly, writes a JSON artifact under `<PLUGIN_DATA>/runs/self-recovery/artifacts/` (default; pass `--out` to override), appends a `liquid_source_map(action=summarize)` result-log entry, and exits non-zero when the source map is not ready for semantic recovery. Use `--slot D3` or `--well A1` to narrow the summary without contacting the robot.

To generate operator-fillable identity drafts, add template outputs:

```bash
node scripts/summarize-liquid-source-map.mjs \
  --session-id self-recovery-liquid \
  --template-json-out runs/self-recovery/artifacts/liquid-source-identity-draft.json \
  --template-tsv-out runs/self-recovery/artifacts/liquid-source-identity-draft.tsv \
  --template-md-out runs/self-recovery/artifacts/liquid-source-identity-draft.md
```

Use the Markdown draft for human review or direct validation/apply, and use JSON/TSV when another tool is filling the fields. All three files are generated from the same source-map draft.

After filling the JSON draft with specific `liquid_name` and `sample_id` values, validate it without changing session state:

```bash
node scripts/summarize-liquid-source-map.mjs \
  --validate-template-json runs/self-recovery/artifacts/liquid-source-identity-draft.json
```

For a filled TSV draft, use the TSV validator:

```bash
node scripts/summarize-liquid-source-map.mjs \
  --session-id self-recovery-liquid \
  --validate-template-tsv runs/self-recovery/artifacts/liquid-source-identity-draft.tsv
```

For a filled Markdown draft, use:

```bash
node scripts/summarize-liquid-source-map.mjs \
  --validate-template-md runs/self-recovery/artifacts/liquid-source-identity-draft.md
```

Add `--report-out runs/self-recovery/artifacts/liquid-source-identity-validation-latest.json` to save the same validation result as an artifact, including the exact row and field for any missing identity.

When validation passes and the identities are operator-confirmed, record the filled JSON into the session source map:

```bash
node scripts/summarize-liquid-source-map.mjs \
  --apply-template-json runs/self-recovery/artifacts/liquid-source-identity-draft.json
```

Or record a filled TSV draft:

```bash
node scripts/summarize-liquid-source-map.mjs \
  --session-id self-recovery-liquid \
  --apply-template-tsv runs/self-recovery/artifacts/liquid-source-identity-draft.tsv
```

Or record a filled Markdown draft:

```bash
node scripts/summarize-liquid-source-map.mjs \
  --apply-template-md runs/self-recovery/artifacts/liquid-source-identity-draft.md
```

This still does not contact the robot; it only updates local session bookkeeping and then re-runs the source-map readiness summary.

Apply output includes `summary_result_log_entry_id` and the latest `summary_result_log_entry`, so the identity update can be audited through `query_history(scope=experiment_logs)` as well as the saved `--report-out` artifact.

After the MCP client has been reloaded, prefer the MCP tool `live_liquid_recovery_gate` for the same go/no-go check from inside the plugin. It is also read-only and blocks live liquid watcher/probe re-runs when the loaded recovery self-test fails, the robot cannot be read, door/estop is unsafe, modules report blockers, or a pipette still reports an attached tip.

When a liquid source is expected-present and has a specific identity, you can build a no-motion same-liquid substitution validation bundle. This chains source substitution planning, fixed validation protocol generation, local simulation, and result-log recording:

```bash
OPENTRONS_PYTHON=.venv/bin/python \
node scripts/validate-liquid-source-substitution.mjs \
  --session-id self-recovery-liquid \
  --failed-source-key D3.A1 \
  --preferred-source-key C3.A1 \
  --pipette-name flex_1channel_1000 \
  --mount left \
  --tiprack-load-name opentrons_flex_96_tiprack_1000ul \
  --tiprack-slot B2 \
  --python-executable .venv/bin/python \
  --out runs/self-recovery/artifacts/liquid-source-substitution-validation-bundle-latest.json \
  --markdown-out runs/self-recovery/artifacts/liquid-source-substitution-validation-bundle-latest.md
```

The generated protocol only calls `require_liquid_presence` on the replacement source, then drops the tip. It does not aspirate, dispense, upload, play, or resume a failed experiment. The bundle also includes `liquid_guard_analysis`; it should report `status=pass`, `first_aspirate_guarded=true`, and `no_aspirate_or_dispense=true` for this validation protocol. A `passed` bundle means the replacement-source validation protocol passes local simulation; live execution still requires `live_liquid_recovery_gate` and explicit operator opt-in. The bundle may report `auto_resume_eligible=true` when the fixed playbook can automatically choose a same-liquid replacement with validated presence, but `live_execution_allowed` and `live_protocol_run_allowed` must remain false before the live gate and operator opt-in.

To prepare the registered fixed recovery playbook from inside the MCP runtime, use `liquid_source_substitution(action=prepare_recovery)` with the same source and pipette inputs. This plans the replacement, generates the fixed validation protocol, runs local simulation, writes a recovery bundle, and records `event_kind=liquid_source_substitution_recovery_bundle`. It still does not upload, play, resume, aspirate, dispense, or move the robot. The recovery bundle should report `status=prepared`, `fixed_script_prepared=true`, `liquid_guard_analysis.status=pass`; `auto_resume_eligible=true` is allowed only for same-liquid replacement with validated presence, while `live_execution_allowed=false` remains mandatory until `live_liquid_recovery_gate` and operator opt-in are satisfied.

When a runtime liquid-probe failure has same-liquid alternatives in the source map, the recovery suggestion and runtime-watch alert expose the fixed playbook as structured fields: `same_liquid_source_substitution_next_tool=liquid_source_substitution(action=prepare_recovery)`, `same_liquid_source_substitution_playbook=liquid_source_substitution_continuation_protocol`, and `same_liquid_source_substitution_required_gates=["live_liquid_recovery_gate","run_protocol_only_after_operator_opt_in"]`. These fields mean the plugin has a deterministic next tool to prepare recovery; they do not mean the robot may automatically resume.

To replay that liquid failure handoff without contacting or moving the robot, export a local recovery-decision artifact:

```bash
node scripts/export-liquid-failure-replay.mjs \
  --session-id self-recovery-liquid \
  --failed-source-key D3.A1 \
  --attached-tip-mount left \
  --run-id synthetic-self-recovery-liquid-d3a1 \
  --out runs/self-recovery/artifacts/liquid-failure-replay-d3a1-latest.json \
  --markdown-out runs/self-recovery/artifacts/liquid-failure-replay-d3a1-latest.md
```

The replay reads the current session source map, synthesizes a `liquidProbe` / `liquidNotFound` failed command for the requested source, runs the same recovery suggestion and action-summary code used by the watcher, writes a `liquid_failure_replay` result-log entry, and exits non-zero if the fixed playbook handoff is missing. `--attached-tip-mount` is optional; use it to verify the handoff still preserves both the liquid recovery path and cleanup such as `drop_tip:left`. This is useful after edits because it proves the current runtime still points D3.A1 water failures at the registered same-liquid recovery path while keeping `same_liquid_auto_resume_eligible=false`.

If MCP transport is down but read-only status confirms an attached tip that blocks liquid reruns, use the CLI fallback in dry-run mode first:

```bash
node scripts/drop-attached-tip.mjs \
  --robot-ip 192.168.1.10 \
  --session-id self-recovery-liquid \
  --mount left \
  --out runs/self-recovery/artifacts/drop-attached-tip-dry-run-latest.json \
  --markdown-out runs/self-recovery/artifacts/drop-attached-tip-dry-run-latest.md
```

Dry-run mode creates no maintenance context and sends no robot commands. It writes `tool_name=drop_attached_tip_cli`, `event_kind=cleanup_dry_run`, and returns `status=dry_run_ready` only when the robot is reachable, the door is closed, estop is disengaged, and the requested mount actually has a detected tip. Re-run with `--execute` only when tip cleanup is intended; execution uses the same MCP handler path as `drop_attached_tip`, records `event_kind=cleanup_action`, and still does not upload, play, resume, aspirate, or dispense.

For liquid tests with known source wells, pass `required_sources` to `live_liquid_recovery_gate`. Each item should include `slot_name`, `well_name`, and optional boolean `expected_presence`. The gate fails when a required source-map entry is missing, when `expected_presence` is not boolean, or when the recorded `expected_presence` does not match the requested value.

For the current liquid recovery validation set, use `source_plan: "c3_d3_liquid_recovery"` instead of listing wells manually. It expands to `C3.A1` present, `D3.A1-H1` present, and `D3.A12` absent.

Use `recommended_next_action`, `allowed_next_tools`, `human_required`, `resolution_plan`, and `operator_request` from the gate response to decide what the agent may do next. `resolution_plan` is an ordered machine-readable checklist; each item names the failed or warning check, the allowed next tools, whether a human is required, and the acceptance criteria for clearing that item. `operator_request` is the human-facing subset of that plan, including physical-state requests, liquid-identity requests, artifact paths, and validation/apply commands. Treat `no_robot_motion=true` as a hard boundary.

When the gate reports an attached-tip blocker, continue only with read-only status/gate/history tools until the operator clears the physical state. When it reports `source_identity_metadata`, record a specific liquid name and sample ID before treating the source map as enough for semantic recovery.

When `source_identity_metadata` is present, the gate check also includes `operator_guidance` with the Markdown draft path plus exact generate, validate, and apply commands for the source-identity table.

After a client or host restart, run `safe_next_action` with the same `session_id`. It reads recent result-log entries and surfaces the latest `resolution_plan` and `operator_request`, so the agent can resume from the same no-motion blocker and ask for the exact human input instead of guessing from old run status.

To save that restart guidance as an auditable artifact and result-log entry without contacting the robot, run:

```bash
node scripts/export-safe-next-action.mjs \
  --session-id self-recovery-liquid \
  --out runs/self-recovery/artifacts/safe-next-action-latest.json \
  --markdown-out runs/self-recovery/artifacts/safe-next-action-latest.md
```

Add `--robot-ip 192.168.1.10` when you want the same handoff to include a live, read-only home-safety preview. This still must not move the robot; it only records blockers such as `tip_attached:left` alongside the persisted liquid recovery plan.

The exported JSON artifact includes `rationale_zh`, `operator_steps_zh`, the latest operator-request artifact paths, a liquid identity input summary, and any live home blockers when `--robot-ip` is provided. The optional Markdown artifact is a short Chinese-first operator handoff with the current no-motion boundary and exact wells that still need liquid identity metadata. The result log uses `tool_name=safe_next_action_cli` and `event_kind=resume_guidance`, so it can be read back with `query_history(scope=experiment_logs)`.

For active monitoring, use `runtime_recovery_monitor` from MCP or the CLI wrapper. This is a bounded monitor tick, not a hidden daemon. It combines four levels:

| Level | What it checks | Motion boundary |
|---|---|---|
| L1 | loaded recovery self-test, `health_check`, `robot_status(include_modules=true)` | no robot motion |
| L2 | current run state and, in observe mode, recovery guidance for `awaiting-recovery` / failed runs | observe mode has no robot motion |
| L3 | `safe_next_action`, optional `live_liquid_recovery_gate`, prepared recovery bundles | no robot motion |
| L4 | guarded execution boundary for self-recovery | only delegates existing `runtime_watch(mode=poll)` L0 fixes when explicitly enabled |

Before trusting a runtime recovery path, inspect the fixed playbook registry:

```json
{"include_motion": true}
```

Call `list_recovery_playbooks` and confirm the intended recovery class is registered. The registry states whether watch mode may call the playbook, whether it can move the robot, which gates are required, and which semantic invariants must hold. Liquid source substitution is registered as a no-motion preparation playbook; it does not authorize automatic aspirate, dispense, or resume.

Before simulation or live recovery, call `validate_virtual_lab_state_steps` for the proposed bookkeeping changes. It is pure software: it checks tip state, source volume, dead volume, destination capacity, and unsupported steps without writing session state or moving the robot. Treat any violation as a stop sign before uploading or playing a live run. The same checks run inline as a pre-simulation gate when you pass `virtual_lab_steps` to `simulate_protocol` (Phase 1.5 gate); the simulation is blocked with `blocked_by: "virtual_lab_state_validation"` instead of spawning Python.

For monitored live runs, use `runtime_watch(mode=loop)` after `run_protocol` returns a `run_id`. It reuses `runtime_watch(mode=poll)` on a budgeted schedule, persists `goal-state.json` per run, and records events for MCP review. Default `self_fix_mode=observe`; guarded L0 self-fix requires `allow_l4_execution=true` and `operator_opt_in=true`.

Default mode is observe-only:

```bash
node scripts/runtime-recovery-monitor.mjs \
  --session-id self-recovery-liquid \
  --robot-ip 192.168.1.10 \
  --source-plan c3_d3_liquid_recovery \
  --out runs/self-recovery/artifacts/runtime-recovery-monitor-latest.json \
  --markdown-out runs/self-recovery/artifacts/runtime-recovery-monitor-latest.md
```

To monitor multiple ticks, add `--cycles` and `--interval-ms`. A typical low-noise monitor reports meaningful status changes and required attention:

```bash
node scripts/runtime-recovery-monitor.mjs \
  --session-id self-recovery-liquid \
  --robot-ip 192.168.1.10 \
  --run-id <run-id> \
  --cycles 20 \
  --interval-ms 30000 \
  --out runs/self-recovery/artifacts/runtime-recovery-monitor-latest.json \
  --markdown-out runs/self-recovery/artifacts/runtime-recovery-monitor-latest.md
```

Only use L0 self-fix mode when the operator has opted in and the intended recovery class is one of the existing `runtime_watch(mode=poll)` whitelist cases, such as missing-tip retry or module-wait recovery:

```bash
node scripts/runtime-recovery-monitor.mjs \
  --session-id self-recovery-liquid \
  --robot-ip 192.168.1.10 \
  --run-id <run-id> \
  --self-fix-mode l0 \
  --allow-l4-execution \
  --operator-opt-in
```

This still does not authorize liquid source changes, aspirate/dispense retries, deck relocation, or arbitrary resume. Liquid recovery remains gated by `live_liquid_recovery_gate` and operator opt-in. The monitor writes a `runtime_recovery_monitor` result-log entry with `notifications`, `recommended_next_tools`, `acceptance`, and `no_robot_motion`, so the agent can use `query_history(scope=experiment_logs)` to resume after restart.

The monitor also publishes requires-attention and resolved-state notifications into a durable alert/outbox layer. `runtime_alerts(action=list)` reads watcher and monitor alerts; `runtime_outbox(action=list)` reads the persisted event history; the corresponding `ack` actions mark handled items. You can optionally send pending events to the command line or a webhook with `runtime_outbox(action=deliver)`.

Example low-noise monitor:

```bash
node scripts/runtime-recovery-monitor.mjs \
  --session-id self-recovery-liquid \
  --robot-ip 192.168.1.10 \
  --levels L1,L3,L4 \
  --source-plan c3_d3_liquid_recovery \
  --enable-liquid-gate \
  --out runs/self-recovery/artifacts/runtime-recovery-monitor-latest.json \
  --markdown-out runs/self-recovery/artifacts/runtime-recovery-monitor-latest.md
```

By default only attention, hard-stop, and important resolved-state events enter the outbox. Use `--include-info-notifications` to publish all monitor notifications, or `--no-publish-notifications` when you need a pure inspection tick with no local alert/outbox writes.

For real-machine validation, require `acceptance.metrics.unapproved_motion_count=0` and `acceptance.metrics.experiment_intent_violation_count=0`. `l0_auto_fix_count` should increment only when `self_fix_mode=l0`, `allow_l4_execution=true`, and `operator_opt_in=true` are all present. If those gates are missing, the monitor must report `l0_self_fix_gate_blocked` and must not delegate self-fix execution to `runtime_watch(mode=poll)`.

For a shorter go/no-go bundle after a restart, combine the latest live-liquid gate artifact with safe-next:

```bash
node scripts/export-runtime-recovery-readiness.mjs \
  --session-id self-recovery-liquid \
  --robot-ip 192.168.1.10 \
  --gate-artifact runs/self-recovery/artifacts/live-liquid-recovery-gate-source-plan-latest.json \
  --real-machine-artifact runs/self-recovery/artifacts/real-machine-readonly-status-latest.json \
  --validation-bundle-artifact runs/self-recovery/artifacts/liquid-source-substitution-validation-bundle-latest.json \
  --recovery-bundle-artifact runs/self-recovery/artifacts/liquid-source-substitution-recovery-bundle-latest.json \
  --out runs/self-recovery/artifacts/runtime-recovery-readiness-latest.json \
  --markdown-out runs/self-recovery/artifacts/runtime-recovery-readiness-latest.md
```

This is also read-only. The JSON/Markdown bundle reports `live_liquid_tests_allowed`, `next_tool`, `no_robot_motion`, the latest gate result-log id, whether a local `node ...opentrons-mcp/index.js` server process is running, the latest real-machine blockers, the latest liquid source-substitution validation bundle, the fixed recovery playbook bundle, and any wells still missing liquid identity. The process check intentionally ignores `node -e` / `--input-type=module` commands that merely import `opentrons-mcp/index.js` during tests or local scripts. Treat `live_liquid_tests_allowed=false` or `no_robot_motion=true` as a stop signal for live liquid watcher/probe tests. If `mcp_process.running=false`, reload the MCP client before trying MCP tools again; this usually corresponds to a `Transport closed` client error. If `real_machine.blockers` includes `attached_tip:left`, clear or confirm that physical state before any liquid motion. A source-substitution validation or recovery bundle may report `auto_resume_eligible=true` when a fixed playbook can automatically choose a same-liquid replacement after validation, but readiness still fails closed if the bundle claims `live_execution_allowed=true` or `live_protocol_run_allowed=true` before the live gate and operator opt-in. The result log uses `tool_name=runtime_recovery_readiness_cli` and `event_kind=readiness_bundle`.

---
