# Getting Started with LabscriptAI OT

LabscriptAI OT is a single plugin bundle for **Claude Code**, **Codex**, and **Cursor**. It helps AI agents write Opentrons protocols, run local simulation, and safely assist with live Flex/OT-2 workflows.

**Safety in one line:** simulate first, opt in to live motion, treat vision as observation-only.

## Decision flow

```
Clone repo → Run installer → Verify setup → Enable plugin → Send first command → Simulation passes
```

| Step | Action | Verify |
|------|--------|--------|
| 1 | Clone this repository | You have a local folder path |
| 2 | Run `install-labscriptai-ot.sh` (macOS/Linux) or `install-labscriptai-ot.ps1` (Windows) | `npm install` completes in `servers/opentrons-mcp/` |
| 3 | Run `node scripts/verify-setup.mjs` | No failures; `health_check: runtime capabilities` reports `liquid-source-map-v2`, and `runtime_recovery_self_test` passes |
| 4 | Enable the plugin in your client (see platform sections below) | MCP server `opentrons-lab` appears |
| 5 | Send a [recommended first command](#recommended-first-commands) | Agent responds and uses MCP tools |
| 6 | Reach simulation pass on a protocol | `simulate_protocol` succeeds locally |

Terms: [GLOSSARY.md](GLOSSARY.md). Workflows: [policy/workflows.md](../policy/workflows.md).

---

## Install

### macOS / Linux

```bash
git clone https://github.com/KRATSZ/labscriptai-ot.git
cd labscriptai-ot
bash install-labscriptai-ot.sh
node scripts/verify-setup.mjs
```

### Windows (PowerShell)

```powershell
git clone https://github.com/KRATSZ/labscriptai-ot.git
cd labscriptai-ot
.\install-labscriptai-ot.ps1
node scripts\verify-setup.mjs
```

### Python for simulation (optional but recommended)

The installer sets up Node/MCP only. For local simulation you also need Python with Opentrons:

```bash
# from repo root, if you use uv:
uv venv .venv
uv sync --extra protocol
export OPENTRONS_PYTHON="$(pwd)/.venv/bin/python"   # Git Bash / macOS / Linux
```

```powershell
# Windows example after creating .venv:
$env:OPENTRONS_PYTHON = "$PWD\.venv\Scripts\python.exe"
```

Re-run `node scripts/verify-setup.mjs` until Opentrons imports cleanly.

### Environment variables

| Variable | Purpose |
|----------|---------|
| `OPENTRONS_PLUGIN_ROOT` | Absolute path to this repo |
| `OPENTRONS_PROTOCOL_LIBRARY_PATH` | Defaults to `bundled-library/` |
| `PLUGIN_DATA` | Writable state directory (default: `.plugin-data/`) |
| `OPENTRONS_PYTHON` | Python with `opentrons` for simulation |

---

## Platform setup

### Claude Code

1. Add the marketplace and install:

   ```text
   /plugin marketplace add KRATSZ/labscriptai-ot
   /plugin install labscriptai-ot@labscriptai-ot-marketplace
   ```

2. Or clone locally and point Claude Code at this repo as a plugin source.

3. Manifest: `.claude-plugin/plugin.json`, MCP: `.claude-plugin/mcp.json`.

4. After install, try a [recommended first command](#recommended-first-commands).

### Codex

1. Use this repository as a local plugin source (path to clone root).

2. Manifest: `.codex-plugin/plugin.json`, MCP: `.mcp.json`.

3. `.mcp.json` should resolve the server entry through `${PLUGIN_ROOT}/servers/opentrons-mcp/index.js`. If this repository also has `.codex/config.toml`, use absolute paths there; that file is the local Codex desktop runtime config and can keep an old relative-path MCP process alive. After reload, `health_check` should report `mcp_server.entrypoint` under the same clone root; otherwise Codex is still using a stale or wrong plugin copy.

4. Default prompts are pre-configured in the manifest interface.

5. Run verify-setup if MCP tools fail to load.

### Cursor

1. Copy project config into your workspace (adjust paths to your clone location):

   ```text
   .cursor/mcp.json          → your project/.cursor/mcp.json
   .cursor/rules/labscriptai-ot.mdc → your project/.cursor/rules/
   ```

2. Edit `.cursor/mcp.json` — replace `${workspaceFolder}/plugins/labscriptai-ot` with the **actual path** to your clone:

   ```json
   "args": ["C:/path/to/labscriptai-ot/servers/opentrons-mcp/index.js"],
   "env": {
     "OPENTRONS_PLUGIN_ROOT": "C:/path/to/labscriptai-ot",
     "OPENTRONS_PROTOCOL_LIBRARY_PATH": "C:/path/to/labscriptai-ot/bundled-library"
   }
   ```

3. Reload Cursor MCP (Settings → MCP) and confirm `opentrons-lab` is connected.

4. Manifest reference: `.cursor-plugin/plugin.json`.

---

## Recommended first commands

Copy one of these as your first message:

1. **New Flex experiment (full flow):**
   *"Help me design a Flex serial dilution experiment from scratch — review intent first, then write and simulate the protocol."*

2. **Validate existing protocol:**
   *"Check whether this Opentrons protocol can pass local simulation safely."*

3. **Robot status / recovery prep:**
   *"What state is the robot in? Run safety checks before any recovery action."*

These map to the `opentrons-experiment-run` orchestration skill. See [examples/01-flex-serial-dilution](../examples/01-flex-serial-dilution/README.md) for a guided walkthrough.

---

## Deck vision

Lab-trained deck vision (camera → YOLO → slot layout) is documented in **[docs/deck-vision.md](deck-vision.md)** — setup, daily MCP/CLI use, machine layout, maintenance, and troubleshooting.

Quick verify: `node scripts/verify-setup.mjs`

---

## Quick verification (manual)

```bash
cd servers/opentrons-mcp
OPENTRONS_PLUGIN_ROOT="$(cd ../.. && pwd)" npm test
```

Or from repo root: `node scripts/verify-setup.mjs`.

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

The loaded `health_check` should also include `mcp_server.required_runtime_tools.all_present=true`. The required runtime tools are the minimum self-recovery surface: `runtime_recovery_self_test`, `safe_next_action`, `restart_review`, `validate_virtual_lab_state_steps`, `live_liquid_recovery_gate`, `robot_status`, `module_status`, `is_home_safe`, `experiment_history`, `runtime_watch_loop`, and the liquid source-map tools. If this block is missing, reload or reinstall the plugin before trusting live runtime recovery.

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
node scripts/live-liquid-recovery-gate.mjs --robot-ip 192.168.66.102
```

The gate writes a JSON artifact under `runs/self-recovery/artifacts/`, appends a `live_liquid_recovery_gate_cli` result-log entry, and exits non-zero when prerequisites are not met, for example an attached tip remains or the MCP client still needs a reload check. A non-zero result is a stop signal for live liquid watcher/probe re-runs, not a script failure. The artifact and result-log entry include self-test coverage so the operator can confirm the loaded recovery logic covers both expected-empty and expected-present liquid-probe failures.

When the MCP client is unavailable or you only need the physical robot snapshot, use the standalone read-only status exporter first:

```bash
node scripts/export-real-machine-readonly-status.mjs \
  --robot-ip 192.168.66.102 \
  --session-id self-recovery-liquid \
  --out runs/self-recovery/artifacts/real-machine-readonly-status-latest.json \
  --markdown-out runs/self-recovery/artifacts/real-machine-readonly-status-latest.md
```

This does not use MCP and does not move the robot. It queries only robot HTTP status endpoints, writes a JSON/Markdown artifact, and appends a `real_machine_readonly_status_cli` result-log entry. Treat `blockers` such as `attached_tip:left`, an open door, or engaged estop as a hard stop before live liquid tests.

For the current liquid recovery validation set, use the same named source plan from the command line:

```bash
node scripts/live-liquid-recovery-gate.mjs \
  --robot-ip 192.168.66.102 \
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

This records `observed_presence`, `observed_run_id`, and `observed_source=live_probe` while preserving `expected_presence`. If an expected-present source probes as absent, `summarize_liquid_source_map` reports `observed_presence_mismatch_count>0` and `ready_for_semantic_recovery=false` until the mismatch is resolved or deliberately corrected.

When the only source-map problem is an expected-present source whose latest live observation is `observed_presence=false`, the normal live-liquid gate still blocks resume. To collect more evidence, use the narrower re-probe gate:

```bash
node scripts/live-liquid-recovery-gate.mjs \
  --robot-ip 192.168.66.102 \
  --session-id self-recovery-liquid \
  --source-plan c3_d3_liquid_recovery \
  --allow-observed-mismatch-reprobe
```

This may downgrade the source-map check from `fail` to `warn` only for targeted no-aspirate `probe_wells` evidence collection. The gate output lists `allowed_probe_targets`; do not use this mode for `runtime_watch_poll`, `run_protocol` resume, aspirate, or dispense.

For expected-present sources, the gate also warns when the source map only says generic `operator-confirmed-liquid` or omits `sample_id`. This warning does not mean liquid probing is unsafe by itself, but it does mean semantic recovery such as changing sources or resuming sample-dependent work needs human confirmation before any live action.

To inspect this before a gate fails, use the read-only MCP tool `summarize_liquid_source_map`. It reports how many expected-present sources still need a specific `liquid_name` or `sample_id`, whether the current source map is ready for semantic recovery, and a `record_liquid_source_map_template` with the exact wells that need operator-filled identity fields.

If the MCP client has not been reloaded yet, use the equivalent local no-motion CLI from the repo root:

```bash
node scripts/summarize-liquid-source-map.mjs \
  --session-id self-recovery-liquid
```

It calls the local MCP handlers directly, writes a JSON artifact under `runs/self-recovery/artifacts/`, appends a `summarize_liquid_source_map` result-log entry, and exits non-zero when the source map is not ready for semantic recovery. Use `--slot D3` or `--well A1` to narrow the summary without contacting the robot.

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

Apply output includes `summary_result_log_entry_id` and the latest `summary_result_log_entry`, so the identity update can be audited through `experiment_history` as well as the saved `--report-out` artifact.

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

To prepare the registered fixed recovery playbook from inside the MCP runtime, use `prepare_liquid_source_substitution_recovery` with the same source and pipette inputs. This plans the replacement, generates the fixed validation protocol, runs local simulation, writes a recovery bundle, and records `event_kind=liquid_source_substitution_recovery_bundle`. It still does not upload, play, resume, aspirate, dispense, or move the robot. The recovery bundle should report `status=prepared`, `fixed_script_prepared=true`, `liquid_guard_analysis.status=pass`; `auto_resume_eligible=true` is allowed only for same-liquid replacement with validated presence, while `live_execution_allowed=false` remains mandatory until `live_liquid_recovery_gate` and operator opt-in are satisfied.

When a runtime liquid-probe failure has same-liquid alternatives in the source map, the recovery suggestion and runtime-watch alert expose the fixed playbook as structured fields: `same_liquid_source_substitution_next_tool=prepare_liquid_source_substitution_recovery`, `same_liquid_source_substitution_playbook=liquid_source_substitution_continuation_protocol`, and `same_liquid_source_substitution_required_gates=["live_liquid_recovery_gate","run_protocol_only_after_operator_opt_in"]`. These fields mean the plugin has a deterministic next tool to prepare recovery; they do not mean the robot may automatically resume.

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
  --robot-ip 192.168.66.102 \
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

Add `--robot-ip 192.168.66.102` when you want the same handoff to include a live, read-only home-safety preview. This still must not move the robot; it only records blockers such as `tip_attached:left` alongside the persisted liquid recovery plan.

The exported JSON artifact includes `rationale_zh`, `operator_steps_zh`, the latest operator-request artifact paths, a liquid identity input summary, and any live home blockers when `--robot-ip` is provided. The optional Markdown artifact is a short Chinese-first operator handoff with the current no-motion boundary and exact wells that still need liquid identity metadata. The result log uses `tool_name=safe_next_action_cli` and `event_kind=resume_guidance`, so it can be read back with `experiment_history`.

For active monitoring, use `runtime_recovery_monitor` from MCP or the CLI wrapper. This is a bounded monitor tick, not a hidden daemon. It combines four levels:

| Level | What it checks | Motion boundary |
|---|---|---|
| L1 | loaded recovery self-test, `health_check`, `robot_status`, `module_status` | no robot motion |
| L2 | current run state and, in observe mode, recovery guidance for `awaiting-recovery` / failed runs | observe mode has no robot motion |
| L3 | `safe_next_action`, optional `live_liquid_recovery_gate`, prepared recovery bundles | no robot motion |
| L4 | guarded execution boundary for self-recovery | only delegates existing `runtime_watch_poll` L0 fixes when explicitly enabled |

Before trusting a runtime recovery path, inspect the fixed playbook registry:

```json
{"include_motion": true}
```

Call `list_recovery_playbooks` and confirm the intended recovery class is registered. The registry states whether watch mode may call the playbook, whether it can move the robot, which gates are required, and which semantic invariants must hold. Liquid source substitution is registered as a no-motion preparation playbook; it does not authorize automatic aspirate, dispense, or resume.

Before simulation or live recovery, call `validate_virtual_lab_state_steps` for the proposed bookkeeping changes. It is pure software: it checks tip state, source volume, dead volume, destination capacity, and unsupported steps without writing session state or moving the robot. Treat any violation as a stop sign before uploading or playing a live run. The same checks run inline as a pre-simulation gate when you pass `virtual_lab_steps` to `simulate_protocol` (Phase 1.5 gate); the simulation is blocked with `blocked_by: "virtual_lab_state_validation"` instead of spawning Python.

For unattended live runs, arm `runtime_watch_loop` after `run_protocol` returns a `run_id`. It reuses `runtime_watch_poll` on a budgeted schedule, persists `goal-state.json` per run, and emits outbox sentinels so the host IDE can auto-wake. Default `self_fix_mode=observe`; guarded L0 self-fix requires `allow_l4_execution=true` and `operator_opt_in=true`.

Default mode is observe-only:

```bash
node scripts/runtime-recovery-monitor.mjs \
  --session-id self-recovery-liquid \
  --robot-ip 192.168.66.102 \
  --source-plan c3_d3_liquid_recovery \
  --out runs/self-recovery/artifacts/runtime-recovery-monitor-latest.json \
  --markdown-out runs/self-recovery/artifacts/runtime-recovery-monitor-latest.md
```

To keep watching for multiple ticks, add `--cycles` and `--interval-ms`. A typical low-noise monitor wakes only on meaningful status changes or required attention:

```bash
node scripts/runtime-recovery-monitor.mjs \
  --session-id self-recovery-liquid \
  --robot-ip 192.168.66.102 \
  --run-id <run-id> \
  --cycles 20 \
  --interval-ms 30000 \
  --out runs/self-recovery/artifacts/runtime-recovery-monitor-latest.json \
  --markdown-out runs/self-recovery/artifacts/runtime-recovery-monitor-latest.md
```

Only use L0 self-fix mode when the operator has opted in and the intended recovery class is one of the existing `runtime_watch_poll` whitelist cases, such as missing-tip retry or module-wait recovery:

```bash
node scripts/runtime-recovery-monitor.mjs \
  --session-id self-recovery-liquid \
  --robot-ip 192.168.66.102 \
  --run-id <run-id> \
  --self-fix-mode l0 \
  --allow-l4-execution \
  --operator-opt-in
```

This still does not authorize liquid source changes, aspirate/dispense retries, deck relocation, or arbitrary resume. Liquid recovery remains gated by `live_liquid_recovery_gate` and operator opt-in. The monitor writes a `runtime_recovery_monitor` result-log entry with `notifications`, `recommended_next_tools`, `acceptance`, and `no_robot_motion`, so the agent can use `experiment_history` to resume after restart.

The monitor also publishes requires-attention and resolved-state notifications into a durable alert/outbox layer. `runtime_get_alerts` reads watcher alerts plus monitor-derived alerts; `runtime_get_outbox` reads host-delivery events; `runtime_ack_alert` and `runtime_ack_outbox` mark handled items. This is the plugin-owned event trigger path. A Codex heartbeat can still consume it, but the message does not depend on heartbeat storage.

Host delivery is adapter based:

| Adapter | Behavior |
|---|---|
| `claudecode` | append JSONL events to a Claude Code mailbox under the host-adapter directory |
| `codex` | append JSONL events to a Codex mailbox under the host-adapter directory |
| `cursor` | append JSONL events to a Cursor mailbox under the host-adapter directory |
| `cli` | return a short printable notification message in the delivery result |
| `webhook` | POST the outbox event to `--webhook-url` or `OPENTRONS_RUNTIME_ALERT_WEBHOOK_URL` |

MCP cannot force every host UI to open a new chat message by itself; each host must either expose a notification API or run a small hook/adapter that consumes the outbox. The plugin side is still self-contained: it owns event generation, dedupe, ack, and durable delivery state.

Example low-noise monitor with host delivery:

```bash
node scripts/runtime-recovery-monitor.mjs \
  --session-id self-recovery-liquid \
  --robot-ip 192.168.66.102 \
  --levels L1,L3,L4 \
  --source-plan c3_d3_liquid_recovery \
  --enable-liquid-gate \
  --notify-adapters claudecode,codex,cursor,cli \
  --out runs/self-recovery/artifacts/runtime-recovery-monitor-latest.json \
  --markdown-out runs/self-recovery/artifacts/runtime-recovery-monitor-latest.md
```

By default only attention, hard-stop, and important resolved-state events enter the outbox. Use `--include-info-notifications` to publish all monitor notifications, or `--no-publish-notifications` when you need a pure inspection tick with no local alert/outbox writes.

For real-machine validation, require `acceptance.metrics.unapproved_motion_count=0` and `acceptance.metrics.experiment_intent_violation_count=0`. `l0_auto_fix_count` should increment only when `self_fix_mode=l0`, `allow_l4_execution=true`, and `operator_opt_in=true` are all present. If those gates are missing, the monitor must report `l0_self_fix_gate_blocked` and must not delegate self-fix execution to `runtime_watch_poll`.

For a shorter go/no-go bundle after a restart, combine the latest live-liquid gate artifact with safe-next:

```bash
node scripts/export-runtime-recovery-readiness.mjs \
  --session-id self-recovery-liquid \
  --robot-ip 192.168.66.102 \
  --gate-artifact runs/self-recovery/artifacts/live-liquid-recovery-gate-source-plan-latest.json \
  --real-machine-artifact runs/self-recovery/artifacts/real-machine-readonly-status-latest.json \
  --validation-bundle-artifact runs/self-recovery/artifacts/liquid-source-substitution-validation-bundle-latest.json \
  --recovery-bundle-artifact runs/self-recovery/artifacts/liquid-source-substitution-recovery-bundle-latest.json \
  --out runs/self-recovery/artifacts/runtime-recovery-readiness-latest.json \
  --markdown-out runs/self-recovery/artifacts/runtime-recovery-readiness-latest.md
```

This is also read-only. The JSON/Markdown bundle reports `live_liquid_tests_allowed`, `next_tool`, `no_robot_motion`, the latest gate result-log id, whether a local `node ...opentrons-mcp/index.js` server process is running, the latest real-machine blockers, the latest liquid source-substitution validation bundle, the fixed recovery playbook bundle, and any wells still missing liquid identity. The process check intentionally ignores `node -e` / `--input-type=module` commands that merely import `opentrons-mcp/index.js` during tests or local scripts. Treat `live_liquid_tests_allowed=false` or `no_robot_motion=true` as a stop signal for live liquid watcher/probe tests. If `mcp_process.running=false`, reload the MCP client before trying MCP tools again; this usually corresponds to a `Transport closed` client error. If `real_machine.blockers` includes `attached_tip:left`, clear or confirm that physical state before any liquid motion. A source-substitution validation or recovery bundle may report `auto_resume_eligible=true` when a fixed playbook can automatically choose a same-liquid replacement after validation, but readiness still fails closed if the bundle claims `live_execution_allowed=true` or `live_protocol_run_allowed=true` before the live gate and operator opt-in. The result log uses `tool_name=runtime_recovery_readiness_cli` and `event_kind=readiness_bundle`.

---

## Common failures (quick reference)

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| MCP server won't start | Wrong `OPENTRONS_PLUGIN_ROOT` or missing `npm install` | [runbooks/mcp-wont-start.md](runbooks/mcp-wont-start.md) |
| `simulate_protocol` fails | Python/opentrons not installed | Set `OPENTRONS_PYTHON`, install deps |
| Tools list empty in Cursor | Bad path in `mcp.json` | Use absolute paths; reload MCP |
| Simulation errors in protocol | Labware name, trash, volumes | [runbooks/simulation-fails.md](runbooks/simulation-fails.md) |
| Live tools unreachable | Robot IP, network, or door/estop | `robot_status`, check LAN |
| Parallel control errors | MCP + HTTP fallback on same robot | Use one control path only |

Full runbooks: [docs/runbooks/](runbooks/).

---

## Next steps

- [GLOSSARY.md](GLOSSARY.md) — deck truth, simulate gate, reconcile_state
- [deck-vision.md](deck-vision.md) — lab-trained deck vision setup and daily use
- [MCP_TOOLS.md](MCP_TOOLS.md) — tool reference by tier (L0–L4)
- [policy/workflows.md](../policy/workflows.md) — canonical workflow sequences
- [examples/](../examples/) — end-to-end example prompts
- [AGENTS.md](../AGENTS.md) — agent behavior contract

## Citation

Public use requires citing the LabscriptAI bioRxiv preprint (DOI: [10.1101/2025.09.30.679666](https://doi.org/10.1101/2025.09.30.679666)). See [LICENSE](../LICENSE) and [README.md](../README.md).
