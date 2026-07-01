# MCP tools reference

Auto-generated from `servers/opentrons-mcp/index.js`. Regenerate:

```bash
node scripts/generate-mcp-docs.mjs
```

Server name: `opentrons-lab`. Workflows: [policy/workflows.md](../policy/workflows.md). Glossary: [GLOSSARY.md](GLOSSARY.md).

## Tier overview

| Tier | Focus | Default exposure |
|------|-------|------------------|
| **L0** | Local sim and environment | Always |
| **L1** | Authoring helpers | Always |
| **L2** | Live read-only status | Needs robot IP |
| **L3** | Live control | Explicit opt-in |
| **L4** | Recovery and vision | On demand |

## L0 — Getting started — local simulation and environment

### `doctor_local_runtime` [L0]

Probe whether the local Python environment can import opentrons.simulate.

**Parameters:** `workspace_root` (optional), `api_root` (optional), `shared_data_root` (optional), `python_executable` (optional)

### `health_check` [L0]

Comprehensive environment health check: MCP server, Python venv, opentrons package, git state, session state, and optional robot connectivity.

**Parameters:** `robot_ip` (optional), `python_executable` (optional)

### `parse_simulation_output` [L0]

Classify simulation stdout/stderr into structured repair categories.

**Parameters:** `simulation_output_json` (optional), `stdout` (optional), `stderr` (optional), `exit_code` (optional), `protocol_path` (optional)

### `runtime_recovery_self_test` [L0]

Run no-motion recovery invariants inside the loaded MCP process, including liquidNotFound classification, source-map mismatch handling, and manual-only liquid recovery.

**Parameters:** —

### `simulate_protocol` [L0]

Run local opentrons.simulate against a protocol file and return structured logs. When virtual_lab_steps (or validate_virtual_lab_state=true) is provided, runs deterministic Virtual Lab State validation first and blocks the Python simulation on any violation (Phase 1.5 gate).

**Parameters:** `protocol_path`, `workspace_root` (optional), `api_root` (optional), `shared_data_root` (optional), `python_executable` (optional), `extra_args` (optional), `max_log_chars` (optional), `session_id` (optional), `initial_state` (optional), `virtual_lab_steps` (optional), `validate_virtual_lab_state` (optional), `skip_virtual_lab_state_validation` (optional)

### `validate_labware_name` [L0]

Validate a labware load name against the local Opentrons definition index and return close matches.

**Parameters:** `load_name`, `limit` (optional)

## L1 — Authoring helpers — labware, tips, preflight

### `estimate_tip_budget` [L1]

Heuristically estimate tip usage and flag low-volume transfers below the recommended 10% threshold.

**Parameters:** `protocol_source` (optional), `file_path` (optional), `tip_rack_count` (optional), `tip_rack_capacity` (optional)

### `inspect_labware_definition` [L1]

Inspect a labware load name and return geometry, capacity, and dead-volume guidance from the local definition index.

**Parameters:** `load_name`, `limit` (optional)

### `preflight_run_setup` [L1]

Before play: verify session reconciliation, robot readiness, and (Flex) declared protocol loads vs live deck snapshot. Callable standalone or invoked automatically inside run_protocol after run creation.

**Parameters:** `robot_ip`, `file_path`, `session_id` (optional), `run_id` (optional), `skip_deck_diff` (optional), `strict_empty_labware_slots` (optional)

## L2 — Live read-only — robot and session status

### `apply_liquid_probe_results` [L2]

Apply live probe_wells observations to session liquid_tracking. Records observed_presence and observed_height_mm separately from operator expected_presence. Bookkeeping only; no robot motion.

**Parameters:** `session_id` (optional), `probe_results` (optional), `probe_artifact_path` (optional), `generated_protocol_path` (optional), `slot_name` (optional), `labware_slot` (optional), `labware_load_name` (optional), `run_id` (optional), `mode` (optional)

### `experiment_history` [L2]

Query persisted run, recovery, and reconciliation result logs for recent experiment history.

**Parameters:** `session_id` (optional), `run_id` (optional), `tool_name` (optional), `event_kind` (optional), `status` (optional), `limit` (optional)

### `generate_continuation_protocol` [L2]

Generate a new tip-only continuation protocol from an awaiting-recovery run. This writes a local protocol file but does not stop, play, or move the robot.

**Parameters:** `robot_ip`, `run_id`, `session_id` (optional), `output_path` (optional), `page_length` (optional), `protocol_name` (optional), `use_session_state` (optional)

### `generate_liquid_source_substitution_protocol` [L2]

Generate a fixed no-aspirate validation protocol for a planned same-liquid source substitution. This writes a local protocol file only; it does not upload, run, or resume the robot.

**Parameters:** `session_id` (optional), `failed_source_key`, `failed_slot_name` (optional), `failed_well_name` (optional), `preferred_source_key` (optional), `pipette_name`, `mount`, `tiprack_load_name`, `tiprack_slot`, `output_path` (optional), `api_level` (optional), `robot_type` (optional), `tiprack_namespace` (optional), `tiprack_version` (optional), `labware_namespace` (optional), `labware_version` (optional), `trash_slot` (optional)

### `get_liquid_source_map` [L2]

Read operator-confirmed liquid/source identity from session state. This is bookkeeping only and does not inspect or move the robot.

**Parameters:** `session_id` (optional), `slot_name` (optional), `well_name` (optional)

### `get_protocols` [L2]

List protocols stored on the robot.

**Parameters:** `robot_ip` (optional)

### `get_runs` [L2]

List runs on the robot.

**Parameters:** `robot_ip` (optional)

### `get_slot_occupation` [L2]

Return whether a slot is occupied, unknown, or mismatched against committed session deck state.

**Parameters:** `robot_ip` (optional), `slot_name`, `session_id` (optional), `run_id` (optional), `context_type` (optional), `context_id` (optional)

### `is_home_safe` [L2]

Return whether auto-home is currently safe and which cleanup actions are still required first.

**Parameters:** `robot_ip` (optional), `session_id` (optional)

### `list_available_slots` [L2]

List all available slots matching specific criteria (empty, addressable, suitable for labware/modules). Returns slots grouped by availability type.

**Parameters:** `robot_ip` (optional), `session_id` (optional), `run_id` (optional), `context_type` (optional), `context_id` (optional), `filter` (optional)

### `list_recovery_playbooks` [L2]

List registered fixed recovery playbooks, their gates, allowed watch-mode use, and semantic invariants. This is read-only.

**Parameters:** `include_motion` (optional)

### `list_tip_candidates` [L2]

List remaining candidate tip wells in default search order using session bookkeeping plus current run context.

**Parameters:** `robot_ip` (optional), `session_id` (optional), `run_id` (optional), `tiprack_slots` (optional)

### `live_liquid_recovery_gate` [L2]

Read-only go/no-go gate before live liquid watcher or probe re-runs. Checks loaded recovery self-test, robot/module status, door/estop, source-map readiness, source identity, and attached-tip blockers without moving the robot. Returns an ordered resolution_plan for clearing blockers safely.

**Parameters:** `robot_ip`, `session_id` (optional), `source_plan` (optional), `required_sources` (optional), `allow_observed_mismatch_reprobe` (optional)

### `live_readiness_check` [L2]

Read-only live readiness gate for Flex: combines local runtime health, restart/session guidance, robot/module status, home safety, and optional preflight into pass/warn/fail checks before create_run or play.

**Parameters:** `robot_ip`, `session_id` (optional), `file_path` (optional), `python_executable` (optional), `run_id` (optional)

### `module_status` [L2]

Fetch attached module state and summarize which modules are ready for execution.

**Parameters:** `robot_ip` (optional)

### `plan_liquid_source_substitution` [L2]

Plan a same-liquid source substitution from the recorded source map. This is read-only/no-motion and does not execute or resume a run.

**Parameters:** `session_id` (optional), `failed_source_key` (optional), `failed_slot_name` (optional), `failed_well_name` (optional), `preferred_source_key` (optional)

### `prepare_liquid_source_substitution_recovery` [L2]

Prepare the registered same-liquid source-substitution recovery playbook: plan replacement, generate the fixed validation protocol, run local simulation, write an auditable bundle, and stop before any robot motion.

**Parameters:** `session_id` (optional), `failed_source_key`, `failed_slot_name` (optional), `failed_well_name` (optional), `preferred_source_key` (optional), `pipette_name`, `mount`, `tiprack_load_name`, `tiprack_slot`, `output_path` (optional), `output_protocol_path` (optional), `python_executable` (optional), `api_level` (optional), `robot_type` (optional), `tiprack_namespace` (optional), `tiprack_version` (optional), `labware_namespace` (optional), `labware_version` (optional), `trash_slot` (optional)

### `reconcile_state` [L2]

Compare committed session deck state with live hardware and current run context, then persist a proposed reconciliation snapshot.

**Parameters:** `robot_ip` (optional), `session_id` (optional), `run_id` (optional), `context_type` (optional), `context_id` (optional), `observed_liquid_containers` (optional), `observed_liquid_tracking` (optional)

### `record_liquid_source_map` [L2]

Record operator-confirmed liquid/sample identity and optional live probe observations for source wells in session state. This is bookkeeping only and does not move the robot.

**Parameters:** `session_id` (optional), `sources`

### `restart_review` [L2]

After MCP or host restart: summarize persisted session state plus recent result logs with structured guidance. suggested_tool_order includes run_history and parse_error when session last_run_id is set. Logs are historical only; pass robot_ip optionally to include a live is_home_safe preview (narrative warns if auto-home is blocked).

**Parameters:** `session_id` (optional), `limit` (optional), `robot_ip` (optional)

### `robot_health` [L2]

Check robot connectivity and health via /health.

**Parameters:** `robot_ip` (optional)

### `robot_status` [L2]

Fetch the live hardware snapshot needed before physical actions: health, instruments, door, estop, and deck configuration.

**Parameters:** `robot_ip` (optional)

### `run_history` [L2]

Get run state plus recent command history in an agent-friendly format.

**Parameters:** `robot_ip` (optional), `run_id`, `page_length` (optional)

### `runtime_ack_alert` [L2]

Mark a runtime watch alert handled after the operator has supplied the requested decision.

**Parameters:** `run_id`, `alert_id`, `note` (optional), `selection` (optional), `watch_dir` (optional)

### `runtime_ack_outbox` [L2]

Mark a runtime notification outbox event handled after the operator or host adapter has acted on it.

**Parameters:** `session_id` (optional), `outbox_id`, `note` (optional), `selection` (optional), `outbox_dir` (optional)

### `runtime_deliver_outbox` [L2]

Deliver pending runtime outbox events to configured host adapters: claudecode, codex, cursor, cli, or webhook.

**Parameters:** `session_id` (optional), `run_id` (optional), `adapters` (optional), `limit` (optional), `include_delivered` (optional), `outbox_dir` (optional), `host_adapter_dir` (optional), `webhook_url` (optional)

### `runtime_get_alerts` [L2]

Read runtime watch and monitor alerts plus latest watch state. Intended for hook/insurance paths and current-dialog notification checks.

**Parameters:** `run_id` (optional), `session_id` (optional), `limit` (optional), `include_acked` (optional), `watch_dir` (optional)

### `runtime_get_outbox` [L2]

Read pending runtime notification outbox events created from watcher/monitor alerts for host adapters.

**Parameters:** `session_id` (optional), `run_id` (optional), `limit` (optional), `include_acked` (optional), `include_delivered` (optional), `outbox_dir` (optional), `host_adapter_dir` (optional)

### `runtime_recovery_monitor` [L2]

Active L1-L4 runtime recovery monitor tick. L1 checks runtime/robot/module health, L2 watches a run, L3 coordinates recovery gates and safe-next guidance, and L4 only delegates whitelisted L0 self-fixes when explicitly enabled.

**Parameters:** `robot_ip` (optional), `session_id` (optional), `run_id` (optional), `levels` (optional), `self_fix_mode` (optional), `allow_l4_execution` (optional), `operator_opt_in` (optional), `source_plan` (optional), `required_sources` (optional), `enable_liquid_gate` (optional), `allow_observed_mismatch_reprobe` (optional), `max_block_ms` (optional), `poll_interval_ms` (optional), `timeout_ms` (optional), `page_length` (optional), `tiprack_slots` (optional), `tip_binding_mode` (optional), `protocol_source` (optional), `file_path` (optional), `protocol_path` (optional), `watch_dir` (optional), `record_result_log` (optional), `publish_notifications` (optional), `include_info_notifications` (optional), `notify_adapters` (optional), `notify_limit` (optional), `outbox_dir` (optional), `host_adapter_dir` (optional), `webhook_url` (optional)

### `runtime_watch_loop` [L2]

Auto-wake runtime watch loop: reuses runtime_watch_poll on a budgeted schedule (max_turns / max_runtime_ms / interval_ms) and emits one outbox sentinel per tick for host-adapter wake (claudecode/cursor/codex/cli/webhook). Persists a goal-state.json per run (resume=true continues an active goal). Goal status is COMPLETE/BLOCKED/BUDGET_LIMITED; COMPLETE requires either a completed tick or a verify callback. Safety model is inherited from runtime_watch_poll: only L0 whitelist fixes auto-execute; needs_user/hard_stop stop the loop and emit a BLOCKED sentinel. Default self_fix_mode=observe (no robot motion).

**Parameters:** `robot_ip` (optional), `run_id`, `session_id` (optional), `goal_id` (optional), `goal_prompt` (optional), `max_turns` (optional), `max_runtime_ms` (optional), `interval_ms` (optional), `max_block_ms` (optional), `poll_interval_ms` (optional), `page_length` (optional), `tiprack_slots` (optional), `tip_binding_mode` (optional), `protocol_source` (optional), `file_path` (optional), `protocol_path` (optional), `module_wait_timeout_ms` (optional), `module_poll_interval_ms` (optional), `max_attempts_per_failed_command` (optional), `unreachable_threshold` (optional), `resume` (optional), `self_fix_mode` (optional), `allow_l4_execution` (optional), `operator_opt_in` (optional), `watch_dir` (optional), `outbox_dir` (optional), `notify_adapters` (optional), `notify_limit` (optional), `host_adapter_dir` (optional), `webhook_url` (optional)

### `safe_next_action` [L2]

Single-entry operator summary after MCP/host restart: same payload as restart_review plus safe_next_action (recommended_next_tool, operator_steps, tool_sequence). Prefer this when the user wants one call instead of reading the full guidance object. Atomic tools are unchanged.

**Parameters:** `session_id` (optional), `limit` (optional), `robot_ip` (optional)

### `suggest_next_tip_well` [L2]

Suggest the next viable tip well after skipping previously failed or depleted wells.

**Parameters:** `robot_ip` (optional), `session_id` (optional), `run_id` (optional), `tiprack_slots` (optional), `tiprack_slot` (optional), `failed_well` (optional), `failure_status` (optional)

### `summarize_liquid_source_map` [L2]

Summarize liquid source-map completeness for semantic recovery. This is read-only and does not inspect or move the robot.

**Parameters:** `session_id` (optional), `slot_name` (optional)

### `validate_virtual_lab_state_steps` [L2]

Run deterministic Virtual Lab State checks against proposed protocol steps before local simulation. Pure software only; it does not write session state or move the robot.

**Parameters:** `session_id` (optional), `initial_state` (optional), `steps`

## L3 — Live control — opt-in motion and runs

### `cleanup_motion` [L3]

Execute openGripperJaw, moveToMaintenancePosition, and conditional home in a maintenance context.

**Parameters:** `robot_ip` (optional), `context_id`, `mount` (optional), `maintenance_position` (optional), `allow_home` (optional), `home_axes` (optional), `session_id` (optional), `timeout_ms` (optional), `poll_interval_ms` (optional)

### `control_heater_shaker` [L3]

Control Heater-Shaker temperature, shaker speed, or latch in an active context.

**Parameters:** `robot_ip` (optional), `context_type` (optional), `context_id`, `module_id`, `action`, `celsius` (optional), `rpm` (optional), `ensure_latch_closed` (optional), `intent` (optional), `key` (optional), `session_id` (optional), `timeout_ms` (optional), `poll_interval_ms` (optional)

### `control_run` [L3]

Play, pause, stop, or resume-from-recovery for a run.

**Parameters:** `robot_ip` (optional), `run_id`, `action`, `page_length` (optional), `session_id` (optional), `tiprack_slots` (optional)

### `control_temperature_module` [L3]

Control a Temperature Module in an active run or maintenance context.

**Parameters:** `robot_ip` (optional), `context_type` (optional), `context_id`, `module_id`, `action`, `celsius` (optional), `intent` (optional), `key` (optional), `session_id` (optional), `timeout_ms` (optional), `poll_interval_ms` (optional)

### `control_thermocycler` [L3]

Control Thermocycler block/lid temperature or lid state in an active context.

**Parameters:** `robot_ip` (optional), `context_type` (optional), `context_id`, `module_id`, `action`, `celsius` (optional), `hold_time_seconds` (optional), `block_max_volume_ul` (optional), `ramp_rate` (optional), `profile` (optional), `intent` (optional), `key` (optional), `session_id` (optional), `timeout_ms` (optional), `poll_interval_ms` (optional)

### `create_run` [L3]

Create a run for a protocol already on the robot. Automatically attaches stored labware offsets from the robot unless labware_offsets is provided.

**Parameters:** `robot_ip` (optional), `protocol_id`, `run_time_parameters` (optional), `labware_offsets` (optional), `page_length` (optional)

### `create_run_context` [L3]

Create either a protocol run context or a maintenance-run context before enqueueing commands. Automatically attaches stored labware offsets unless labware_offsets is provided.

**Parameters:** `robot_ip` (optional), `context_type` (optional), `protocol_id` (optional), `run_time_parameters` (optional), `labware_offsets` (optional), `session_id` (optional)

### `drop_attached_tip` [L3]

Safely drop an already attached pipette tip in a maintenance context after a stopped or recovery run. Refuses when robot_status does not confirm a tip on the requested mount.

**Parameters:** `robot_ip` (optional), `context_id`, `mount` (optional), `pipette_name` (optional), `pipette_id` (optional), `labware_id` (optional), `well_name` (optional), `session_id` (optional), `timeout_ms` (optional), `poll_interval_ms` (optional)

### `execute_protocol_recovery` [L3]

Execute a supported protocol recovery branch from live recovery guidance, then resume the run when appropriate.

**Parameters:** `robot_ip` (optional), `run_id`, `session_id` (optional), `expected_action` (optional), `tiprack_slots` (optional), `recovery_well` (optional), `tiprack_slot` (optional), `tip_binding_mode` (optional), `protocol_source` (optional), `file_path` (optional), `protocol_path` (optional), `destination_slot` (optional), `allow_low_confidence_destination` (optional), `module_wait_timeout_ms` (optional), `module_poll_interval_ms` (optional), `timeout_ms` (optional), `poll_interval_ms` (optional), `page_length` (optional)

### `load_labware` [L3]

Enqueue loadLabware into a run or maintenance context and poll to terminal status.

**Parameters:** `robot_ip` (optional), `context_type` (optional), `context_id`, `slot_name`, `load_name`, `namespace`, `version`, `labware_id` (optional), `display_name` (optional), `intent` (optional), `key` (optional), `session_id` (optional), `timeout_ms` (optional), `poll_interval_ms` (optional)

### `load_module` [L3]

Enqueue loadModule into a run or maintenance context and poll to terminal status.

**Parameters:** `robot_ip` (optional), `context_type` (optional), `context_id`, `module_model`, `slot_name`, `module_id` (optional), `intent` (optional), `key` (optional), `session_id` (optional), `timeout_ms` (optional), `poll_interval_ms` (optional)

### `load_pipette` [L3]

Enqueue loadPipette into a run or maintenance context and poll to terminal status.

**Parameters:** `robot_ip` (optional), `context_type` (optional), `context_id`, `pipette_name`, `mount`, `pipette_id` (optional), `tip_overlap_not_after_version` (optional), `liquid_presence_detection` (optional), `intent` (optional), `key` (optional), `session_id` (optional), `timeout_ms` (optional), `poll_interval_ms` (optional)

### `move_labware` [L3]

Enqueue moveLabware with gripper strategy and poll to terminal status.

**Parameters:** `robot_ip` (optional), `context_type` (optional), `context_id`, `labware_id`, `new_slot_name`, `strategy` (optional), `pick_up_offset` (optional), `drop_offset` (optional), `intent` (optional), `key` (optional), `session_id` (optional), `timeout_ms` (optional), `poll_interval_ms` (optional)

### `probe_wells` [L3]

Experimental liquid probing helper that generates a temporary protocol, simulates it locally, and can be explicitly enabled for live robot execution later.

**Parameters:** `robot_ip` (optional), `pipette_name`, `mount`, `tiprack_load_name`, `tiprack_slot`, `starting_tip` (optional), `labware_load_name`, `labware_slot`, `trash_slot` (optional), `wells`, `mode` (optional), `api_level` (optional), `liquid_presence_detection` (optional), `auto_apply_to_session` (optional), `execute_on_robot` (optional), `output_path` (optional), `timeout_ms` (optional), `poll_interval_ms` (optional), `page_length` (optional), `session_id` (optional), `workspace_root` (optional), `api_root` (optional), `shared_data_root` (optional), `python_executable` (optional), `extra_args` (optional)

### `recover_tip_pickup` [L3]

In protocol recovery state, enqueue a fixit pickUpTip on the next viable well and resume the run.

**Parameters:** `robot_ip` (optional), `run_id`, `session_id` (optional), `tiprack_slots` (optional), `recovery_well` (optional), `tiprack_slot` (optional), `timeout_ms` (optional), `poll_interval_ms` (optional), `page_length` (optional)

### `run_protocol` [L3]

Upload a protocol, create a run (auto-attaching stored labware offsets), optionally play it, then poll until the run reaches a terminal or intervention-required state.

**Parameters:** `robot_ip` (optional), `file_path`, `protocol_kind` (optional), `key` (optional), `run_time_parameters` (optional), `labware_offsets` (optional), `auto_play` (optional), `timeout_ms` (optional), `poll_interval_ms` (optional), `page_length` (optional), `session_id` (optional), `skip_preflight` (optional), `skip_preflight_deck_diff` (optional), `strict_preflight_labware_slots` (optional), `tiprack_slots` (optional)

### `runtime_watch_poll` [L3]

Bounded runtime watch poll for a live protocol run. Polls run status, executes only narrow L0 self-fix branches, and returns only running/completed/needs_user/hard_stop/unreachable.

**Parameters:** `robot_ip` (optional), `run_id`, `session_id` (optional), `max_block_ms` (optional), `poll_interval_ms` (optional), `timeout_ms` (optional), `page_length` (optional), `tiprack_slots` (optional), `tip_binding_mode` (optional), `protocol_source` (optional), `file_path` (optional), `protocol_path` (optional), `module_wait_timeout_ms` (optional), `module_poll_interval_ms` (optional), `max_attempts_per_failed_command` (optional), `unreachable_threshold` (optional)

### `upload_protocol` [L3]

Upload a local protocol file to the robot.

**Parameters:** `robot_ip` (optional), `file_path`, `protocol_kind` (optional), `key` (optional), `run_time_parameters` (optional)

## L4 — Recovery and vision — on demand

### `analyze_image_with_kimi` [L4]

Analyze a local robot image with SiliconFlow Kimi-K2.5 or another multimodal model using OpenAI-compatible chat completions.

**Parameters:** `image_path`, `api_key` (optional), `base_url` (optional), `model` (optional), `prompt` (optional), `system_prompt` (optional), `detail` (optional), `temperature` (optional), `max_tokens` (optional), `expected_layout` (optional)

### `camera_status` [L4]

Read built-in camera enablement and livestream state from the robot.

**Parameters:** `robot_ip` (optional)

### `capture_preview_image` [L4]

Capture a robot preview image, save it locally, and return the artifact path for later human or model analysis.

**Parameters:** `robot_ip` (optional), `output_path` (optional), `camera_id` (optional), `resolution_width` (optional), `resolution_height` (optional), `zoom` (optional), `contrast` (optional), `brightness` (optional), `saturation` (optional), `pan_x` (optional), `pan_y` (optional)

### `capture_run_image` [L4]

Capture an image through the robot command queue, download the resulting data file, and save it locally.

**Parameters:** `robot_ip` (optional), `context_type` (optional), `context_id`, `output_path` (optional), `file_name` (optional), `resolution_width` (optional), `resolution_height` (optional), `zoom` (optional), `contrast` (optional), `brightness` (optional), `saturation` (optional), `pan_x` (optional), `pan_y` (optional), `intent` (optional), `key` (optional), `timeout_ms` (optional), `poll_interval_ms` (optional)

### `configure_camera` [L4]

Enable or tune the built-in camera. Supports /camera booleans and optional /camera/cameraSettings image parameters.

**Parameters:** `robot_ip` (optional), `camera_enabled` (optional), `live_stream_enabled` (optional), `error_recovery_camera_enabled` (optional), `camera_id` (optional), `resolution_width` (optional), `resolution_height` (optional), `zoom` (optional), `contrast` (optional), `brightness` (optional), `saturation` (optional), `pan_x` (optional), `pan_y` (optional)

### `download_data_file` [L4]

Download a robot data file by id and save it locally.

**Parameters:** `robot_ip` (optional), `data_file_id`, `output_path` (optional)

### `list_data_files` [L4]

List generated or uploaded data files available on the robot, including historical camera images.

**Parameters:** `robot_ip` (optional)

### `parse_error` [L4]

Parse run or maintenance command failures into structured runtime error categories.

**Parameters:** `robot_ip` (optional), `run_id` (optional), `context_type` (optional), `context_id` (optional), `session_id` (optional), `page_length` (optional)

### `suggest_recovery_action` [L4]

Recommend the next recovery branch from live run errors, robot/module state, and session bookkeeping.

**Parameters:** `robot_ip` (optional), `session_id` (optional), `run_id` (optional), `context_type` (optional), `context_id` (optional), `error_category` (optional), `target_slot` (optional), `failed_well` (optional), `tiprack_slot` (optional), `tip_binding_mode` (optional), `protocol_source` (optional), `file_path` (optional), `protocol_path` (optional), `tiprack_slots` (optional)

### `vision_check` [L4]

Local YOLOE/YOLO vision observation for CHECKDECK or CHECKTIPS (observation-only; does not mutate session state). Uses ultralytics in the project Python env. CHECKDECK maps detections to Flex 12 slots using optional deck homography (deck_corners_norm or labels sidecar optional_deck_corners_norm) or a uniform image-grid fallback; empty slots are geometric (no detection in cell). Default YOLOE prompts are Flex-tuned (colored tip racks, modules, trash). Override with class_prompts + canonical_labels. CHECKTIPS is stubbed pending rack-local analysis.

**Parameters:** `mode` (optional), `image_path`, `expected_layout` (optional), `reference_image_path` (optional), `conf_threshold` (optional), `use_text_prompts` (optional), `weights` (optional), `annotated_output_dir` (optional), `python_executable` (optional), `deck_corners_norm` (optional), `load_labels_sidecar` (optional), `class_prompts` (optional), `canonical_labels` (optional)

## Safety reminders

- Simulation gate is blocking before unattended live runs.
- Vision is observation-only; use `reconcile_state` for deck truth.
- `probe_wells` live motion requires `OPENTRONS_ENABLE_PROBE_WELLS=1`.
