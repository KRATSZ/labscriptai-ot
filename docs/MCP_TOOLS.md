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

### `health_check` [L0]

Health and environment checks in one entry. scope=full (default) is the comprehensive check: MCP server, Python venv, opentrons package, git state, session state, plus robot connectivity when robot_ip is given; scope=robot is a quick robot /health connectivity ping (requires robot_ip); scope=local probes whether the local Python environment can import opentrons.simulate.

**Parameters:** `scope` (optional), `robot_ip` (optional), `python_executable` (optional), `workspace_root` (optional), `api_root` (optional), `shared_data_root` (optional)

### `labware_lookup` [L0]

Look up a labware load name in the local Opentrons definition index. action=validate checks existence and returns close matches; action=inspect returns geometry, capacity, and dead-volume guidance.

**Parameters:** `action`, `load_name`, `limit` (optional)

### `logicpass_check` [L0]

Run LogicPass on the shared opentrons analyze JSON (vendored labscriptai.benchmark.logicpass). Returns outcome pass, fail, or unevaluable, plus issues with step_index. Does not re-analyze when simulate_protocol already cached this protocol. Also reports analyze failure reasons (analyze.reason, never a bare failure) and capacity_sources per labware: source=definition means the real per-well max volume from the installed Opentrons definitions; source=name_hint/unknown means the capacity was guessed from the load name — surface capacity_note and guessed_capacity_labware to the user instead of treating those numbers as fact.

**Parameters:** `protocol_path` (optional), `analysis_path` (optional), `sim_pass` (optional), `python_executable` (optional)

### `runtime_recovery_self_test` [L0]

Run no-motion recovery invariants inside the loaded MCP process, including liquidNotFound classification, source-map mismatch handling, and manual-only liquid recovery.

**Parameters:** —

### `simulate_protocol` [L0]

Judge a protocol with one opentrons analyze run and classify the result into structured repair categories (parsed_repair in the response, replacing the former parse_simulation_output call). The analyze JSON is cached and reused by logicpass_check. When virtual_lab_steps (or validate_virtual_lab_state=true) is provided, runs deterministic Virtual Lab State validation first and blocks analysis on any violation (Phase 1.5 gate). extra_args still falls back to opentrons.simulate.

**Parameters:** `protocol_path`, `workspace_root` (optional), `api_root` (optional), `shared_data_root` (optional), `python_executable` (optional), `extra_args` (optional), `max_log_chars` (optional), `session_id` (optional), `initial_state` (optional), `virtual_lab_steps` (optional), `validate_virtual_lab_state` (optional), `skip_virtual_lab_state_validation` (optional)

## L1 — Authoring helpers — labware, tips, preflight

### `estimate_tip_budget` [L1]

Heuristically estimate tip usage and flag low-volume transfers below the recommended 10% threshold.

**Parameters:** `protocol_source` (optional), `file_path` (optional), `tip_rack_count` (optional), `tip_rack_capacity` (optional)

### `preflight_run_setup` [L1]

Before play: verify session reconciliation, robot readiness, and (Flex) declared protocol loads vs live deck snapshot. Callable standalone or invoked automatically inside run_protocol after run creation.

**Parameters:** `robot_ip`, `file_path`, `session_id` (optional), `run_id` (optional), `skip_deck_diff` (optional), `strict_empty_labware_slots` (optional)

## L2 — Live read-only — robot and session status

### `deck_slots` [L2]

Deck slot state. action=occupation returns whether one slot is occupied, unknown, or mismatched against committed session deck state (requires slot_name); action=available lists slots matching criteria (empty, addressable, or all) grouped by availability type.

**Parameters:** `action`, `robot_ip` (optional), `slot_name` (optional), `session_id` (optional), `run_id` (optional), `context_type` (optional), `context_id` (optional), `filter` (optional)

### `get_protocols` [L2]

List protocols stored on the robot.

**Parameters:** `robot_ip` (optional)

### `is_home_safe` [L2]

Return whether auto-home is currently safe and which cleanup actions are still required first.

**Parameters:** `robot_ip` (optional), `session_id` (optional)

### `liquid_source_map` [L2]

Read the operator-confirmed liquid/source map from session state (bookkeeping only; does not inspect or move the robot). action=get returns recorded sources with optional slot/well filters; action=summarize returns source-map completeness/readiness for semantic recovery; action=critical_targets lists critical wells for preflight LPD probing (wash buffer, enzyme, etc.). Use record_liquid_source_map to write and apply_liquid_probe_results to write probe observations.

**Parameters:** `action`, `session_id` (optional), `slot_name` (optional), `well_name` (optional), `critical_sources` (optional), `include_all_expected_present_fallback` (optional)

### `liquid_source_substitution` [L2]

Same-liquid source substitution recovery in three stages. action=plan (read-only) picks a replacement source from the recorded source map; action=generate_protocol writes a fixed no-aspirate validation protocol locally (no upload, run, or resume); action=prepare_recovery runs the registered playbook end to end — plan, generate protocol, local simulation, auditable recovery bundle — and stops before any robot motion. generate_protocol and prepare_recovery additionally require failed_source_key plus pipette_name, mount, tiprack_load_name, and tiprack_slot.

**Parameters:** `action`, `session_id` (optional), `failed_source_key` (optional), `failed_slot_name` (optional), `failed_well_name` (optional), `preferred_source_key` (optional), `pipette_name` (optional), `mount` (optional), `tiprack_load_name` (optional), `tiprack_slot` (optional), `output_path` (optional), `output_protocol_path` (optional), `python_executable` (optional), `api_level` (optional), `robot_type` (optional), `tiprack_namespace` (optional), `tiprack_version` (optional), `labware_namespace` (optional), `labware_version` (optional), `trash_slot` (optional)

### `list_recovery_playbooks` [L2]

List registered fixed recovery playbooks, their gates, allowed watch-mode use, and semantic invariants. This is read-only.

**Parameters:** `include_motion` (optional)

### `live_liquid_recovery_gate` [L2]

Read-only go/no-go gate before live liquid watcher or probe re-runs. Checks loaded recovery self-test, robot/module status, door/estop, source-map readiness, source identity, and attached-tip blockers without moving the robot. Returns an ordered resolution_plan for clearing blockers safely.

**Parameters:** `robot_ip`, `session_id` (optional), `source_plan` (optional), `required_sources` (optional), `allow_observed_mismatch_reprobe` (optional), `recovery_steps` (optional), `error_step_index` (optional), `failed_source_key` (optional), `failed_slot_name` (optional), `failed_well_name` (optional), `preferred_source_key` (optional)

### `live_readiness_check` [L2]

Read-only live readiness gate for Flex: combines local runtime health, restart/session guidance, robot/module status, home safety, and optional preflight into pass/warn/fail checks before create_run or play.

**Parameters:** `robot_ip`, `session_id` (optional), `file_path` (optional), `python_executable` (optional), `run_id` (optional)

### `query_history` [L2]

Query run and experiment history. scope=robot_runs lists runs on the robot (requires robot_ip); scope=run_commands returns one run's state plus recent command history in an agent-friendly format (requires robot_ip and run_id); scope=experiment_logs queries persisted run, recovery, and reconciliation result logs (local, filterable by session/run/tool/event kind/status).

**Parameters:** `scope`, `robot_ip` (optional), `run_id` (optional), `page_length` (optional), `session_id` (optional), `tool_name` (optional), `event_kind` (optional), `status` (optional), `limit` (optional)

### `reconcile_state` [L2]

Compare committed session deck state with live hardware and current run context, then persist a proposed reconciliation snapshot.

**Parameters:** `robot_ip` (optional), `session_id` (optional), `run_id` (optional), `context_type` (optional), `context_id` (optional), `observed_liquid_containers` (optional), `observed_liquid_tracking` (optional)

### `record_liquid_source_map` [L2]

Record operator-confirmed liquid/sample identity and optional live probe observations for source wells in session state. This is bookkeeping only and does not move the robot.

**Parameters:** `session_id` (optional), `sources`

### `robot_status` [L2]

Fetch the live hardware snapshot needed before physical actions: health, instruments, door, estop, and deck configuration. With include_modules=true (default) the attached module state and execution-readiness summary is embedded in the same snapshot.

**Parameters:** `robot_ip` (optional), `include_modules` (optional)

### `runtime_alerts` [L2]

Runtime watch and monitor alerts. action=list reads alerts plus latest watch state; action=ack marks one alert handled after the operator has supplied the requested decision (requires run_id and alert_id).

**Parameters:** `action`, `run_id` (optional), `session_id` (optional), `alert_id` (optional), `note` (optional), `selection` (optional), `limit` (optional), `include_acked` (optional), `watch_dir` (optional)

### `runtime_recovery_monitor` [L2]

Active L1-L4 runtime recovery monitor tick. L1 checks runtime/robot/module health, L2 watches a run, L3 coordinates recovery gates and safe-next guidance, and L4 only delegates whitelisted L0 self-fixes when explicitly enabled.

**Parameters:** `robot_ip` (optional), `session_id` (optional), `run_id` (optional), `levels` (optional), `self_fix_mode` (optional), `allow_l4_execution` (optional), `operator_opt_in` (optional), `source_plan` (optional), `required_sources` (optional), `enable_liquid_gate` (optional), `allow_observed_mismatch_reprobe` (optional), `max_block_ms` (optional), `poll_interval_ms` (optional), `timeout_ms` (optional), `page_length` (optional), `tiprack_slots` (optional), `tip_binding_mode` (optional), `protocol_source` (optional), `file_path` (optional), `protocol_path` (optional), `watch_dir` (optional), `record_result_log` (optional), `publish_notifications` (optional), `include_info_notifications` (optional), `notify_adapters` (optional), `notify_limit` (optional), `outbox_dir` (optional), `webhook_url` (optional)

### `safe_next_action` [L2]

Single-entry restart summary: persisted session state plus recent result logs with structured guidance. detail=summary (default) adds safe_next_action (recommended_next_tool, operator_steps, tool_sequence) on top of the same payload; detail=full returns the complete restart_review guidance object. suggested_tool_order includes query_history(scope=run_commands) and parse_error when session last_run_id is set. Logs are historical only; pass robot_ip optionally to include a live is_home_safe preview (narrative warns if auto-home is blocked).

**Parameters:** `detail` (optional), `session_id` (optional), `limit` (optional), `robot_ip` (optional)

### `tip_wells` [L2]

Tip well bookkeeping. action=list returns remaining candidate tip wells in default search order (session bookkeeping plus current run context); action=suggest_next picks the next viable well after skipping previously failed or depleted wells.

**Parameters:** `action`, `robot_ip` (optional), `session_id` (optional), `run_id` (optional), `tiprack_slots` (optional), `tiprack_slot` (optional), `failed_well` (optional), `failure_status` (optional)

### `validate_virtual_lab_state_steps` [L2]

Run deterministic Virtual Lab State checks against proposed protocol steps before local simulation. Pure software only; it does not write session state or move the robot.

**Parameters:** `session_id` (optional), `initial_state` (optional), `steps`

## L3 — Live control — opt-in motion and runs

### `apply_liquid_probe_results` [L3]

Write live probe observations into session liquid container state with trust_level=observed. Supports single-well writeback or batch apply from probe_wells artifacts. Bookkeeping only; does not move the robot. Call after probe_wells when pending_state_writeback is true.

**Parameters:** `session_id` (optional), `slot_name` (optional), `well_name` (optional), `labware_load_name` (optional), `labware_slot` (optional), `actual_volume_ul` (optional), `height_mm` (optional), `run_id` (optional), `observed_presence` (optional), `force` (optional), `probe_results` (optional), `probe_artifact_path` (optional), `generated_protocol_path` (optional), `mode` (optional)

### `cleanup_motion` [L3]

Execute openGripperJaw, moveToMaintenancePosition, and conditional home in a maintenance context.

**Parameters:** `robot_ip` (optional), `context_id`, `mount` (optional), `maintenance_position` (optional), `allow_home` (optional), `home_axes` (optional), `session_id` (optional), `timeout_ms` (optional), `poll_interval_ms` (optional)

### `control_module` [L3]

Control an attached module in an active run or maintenance context. module_type=temperature supports set_target_temperature / wait_for_temperature / deactivate (celsius). module_type=heater_shaker supports heater actions plus set_shake_speed / set_and_wait_for_shake_speed / deactivate_shaker / open_labware_latch / close_labware_latch (celsius, rpm). module_type=thermocycler supports block/lid temperature, open_lid / close_lid, and run_profile (celsius, hold_time_seconds, ramp_rate, profile).

**Parameters:** `module_type`, `action`, `robot_ip` (optional), `context_type` (optional), `context_id`, `module_id`, `celsius` (optional), `rpm` (optional), `ensure_latch_closed` (optional), `hold_time_seconds` (optional), `block_max_volume_ul` (optional), `ramp_rate` (optional), `profile` (optional), `intent` (optional), `key` (optional), `session_id` (optional), `timeout_ms` (optional), `poll_interval_ms` (optional)

### `control_run` [L3]

Play, pause, stop, or resume-from-recovery for a run.

**Parameters:** `robot_ip` (optional), `run_id`, `action`, `page_length` (optional), `session_id` (optional), `tiprack_slots` (optional)

### `create_run` [L3]

Create a run for a protocol already on the robot. Automatically attaches stored labware offsets from the robot unless labware_offsets is provided.

**Parameters:** `robot_ip` (optional), `protocol_id`, `run_time_parameters` (optional), `labware_offsets` (optional), `page_length` (optional)

### `create_run_context` [L3]

Create either a protocol run context or a maintenance-run context before enqueueing commands. Automatically attaches stored labware offsets unless labware_offsets is provided.

**Parameters:** `robot_ip` (optional), `context_type` (optional), `protocol_id` (optional), `run_time_parameters` (optional), `labware_offsets` (optional), `session_id` (optional)

### `drop_attached_tip` [L3]

Safely drop an already attached pipette tip in a maintenance context after a stopped or recovery run. Refuses when robot_status does not confirm a tip on the requested mount. Defaults to trash-centered drop (alternate_drop_location=false) to avoid offsetting outside the chute.

**Parameters:** `robot_ip` (optional), `context_id`, `mount` (optional), `pipette_name` (optional), `pipette_id` (optional), `labware_id` (optional), `well_name` (optional), `alternate_drop_location` (optional), `session_id` (optional), `timeout_ms` (optional), `poll_interval_ms` (optional)

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

Upload, create and optionally play a protocol, then poll to a terminal or intervention state. Local simulation is required. LogicPass and software preflight gate by default; honor explicit operator waivers with the corresponding skip flags and record skipped checks. Liquid probing is optional and its enable flag is not required for this tool.

**Parameters:** `robot_ip` (optional), `file_path`, `protocol_kind` (optional), `key` (optional), `run_time_parameters` (optional), `labware_offsets` (optional), `auto_play` (optional), `timeout_ms` (optional), `poll_interval_ms` (optional), `page_length` (optional), `session_id` (optional), `skip_logicpass_gate` (optional), `skip_preflight` (optional), `skip_preflight_deck_diff` (optional), `strict_preflight_labware_slots` (optional), `tiprack_slots` (optional)

### `runtime_outbox` [L3]

Durable runtime event log for watcher/monitor alerts. action=list reads events; action=ack marks one event handled (requires outbox_id); action=deliver optionally sends pending events to stdout or a configured webhook.

**Parameters:** `action`, `session_id` (optional), `run_id` (optional), `outbox_id` (optional), `note` (optional), `selection` (optional), `adapters` (optional), `limit` (optional), `include_acked` (optional), `include_delivered` (optional), `outbox_dir` (optional), `webhook_url` (optional)

### `runtime_watch` [L3]

Bounded runtime watch for a live protocol run. mode=poll runs one bounded poll (run status plus narrow L0 self-fix branches only; returns running/completed/needs_user/hard_stop/unreachable). mode=loop reuses those polls on a budgeted schedule (max_turns / max_runtime_ms / interval_ms), records outbox events, and persists a goal-state.json per run (resume=true continues an active goal; goal status COMPLETE/BLOCKED/BUDGET_LIMITED). Safety model is shared: only L0 whitelist fixes auto-execute; needs_user/hard_stop stop the loop and record a BLOCKED event. Default self_fix_mode=observe (no robot motion).

**Parameters:** `mode`, `robot_ip` (optional), `run_id`, `session_id` (optional), `goal_id` (optional), `goal_prompt` (optional), `max_turns` (optional), `max_runtime_ms` (optional), `interval_ms` (optional), `max_block_ms` (optional), `poll_interval_ms` (optional), `timeout_ms` (optional), `page_length` (optional), `tiprack_slots` (optional), `tip_binding_mode` (optional), `protocol_source` (optional), `file_path` (optional), `protocol_path` (optional), `module_wait_timeout_ms` (optional), `module_poll_interval_ms` (optional), `max_attempts_per_failed_command` (optional), `unreachable_threshold` (optional), `resume` (optional), `self_fix_mode` (optional), `allow_l4_execution` (optional), `operator_opt_in` (optional), `watch_dir` (optional), `outbox_dir` (optional), `notify_adapters` (optional), `notify_limit` (optional), `webhook_url` (optional)

### `upload_protocol` [L3]

Upload a local protocol file to the robot.

**Parameters:** `robot_ip` (optional), `file_path`, `protocol_kind` (optional), `key` (optional), `run_time_parameters` (optional)

## L4 — Recovery and vision — on demand

### `analyze_image` [L4]

Analyze a local robot/deck image with a multimodal VLM (observation-only; does not mutate session state). provider=ark uses Volcengine Ark (Doubao) via the Responses API — default model endpoint from ARK_MODEL_ENDPOINT or ep-20260716144817-n6rgn, API key from ARK_API_KEY or automation/.env. provider=kimi uses SiliconFlow Kimi-K2.5 (or another OpenAI-compatible multimodal model) via chat completions — API key from SILICONFLOW_API_KEY or automation/.env.

**Parameters:** `provider`, `image_path`, `api_key` (optional), `base_url` (optional), `model` (optional), `model_endpoint` (optional), `prompt` (optional), `system_prompt` (optional), `detail` (optional), `temperature` (optional), `max_tokens` (optional), `expected_layout` (optional), `max_output_tokens` (optional)

### `camera_settings` [L4]

Built-in robot camera configuration. action=status reads camera enablement and livestream state; action=configure enables/tunes the camera (/camera booleans plus optional /camera/cameraSettings image parameters; requires at least one state field or image setting).

**Parameters:** `action`, `robot_ip` (optional), `camera_enabled` (optional), `live_stream_enabled` (optional), `error_recovery_camera_enabled` (optional), `camera_id` (optional), `resolution_width` (optional), `resolution_height` (optional), `zoom` (optional), `contrast` (optional), `brightness` (optional), `saturation` (optional), `pan_x` (optional), `pan_y` (optional)

### `capture_image` [L4]

Capture a robot image and save it locally, returning the artifact path for human or model analysis. mode=preview captures directly via the camera preview endpoint (no run required); mode=run captures through the robot command queue in an active context and downloads the resulting data file (requires context_id).

**Parameters:** `mode`, `robot_ip` (optional), `context_type` (optional), `context_id` (optional), `output_path` (optional), `file_name` (optional), `camera_id` (optional), `resolution_width` (optional), `resolution_height` (optional), `zoom` (optional), `contrast` (optional), `brightness` (optional), `saturation` (optional), `pan_x` (optional), `pan_y` (optional), `intent` (optional), `key` (optional), `timeout_ms` (optional), `poll_interval_ms` (optional)

### `data_files` [L4]

Robot data files (including historical camera images). action=list shows generated or uploaded files available on the robot; action=download downloads one file by id and saves it locally (requires data_file_id).

**Parameters:** `action`, `robot_ip` (optional), `data_file_id` (optional), `output_path` (optional)

### `deck_vision_check` [L4]

Deck vision observation (observation-only; does not mutate session state; compare with reconcile_state before treating as deck truth). mode=preflight orchestrates capture → YOLO → optional VLM second opinion when uncertain or mismatched (requires robot_ip; enable the optional configured path with OPENTRONS_PREFLIGHT_VISION=on). mode=local runs the YOLOE/YOLO observation directly on a saved image (requires image_path): detections map to Flex 12 slots via optional deck homography or a uniform image-grid fallback; empty slots are geometric. Default YOLOE prompts are Flex-tuned (colored tip racks, modules, trash); override with class_prompts + canonical_labels.

**Parameters:** `mode`, `robot_ip` (optional), `session_id` (optional), `expected_layout` (optional), `output_path` (optional), `force_vlm` (optional), `vlm_provider` (optional), `conf_threshold` (optional), `weights` (optional), `image_path` (optional), `reference_image_path` (optional), `use_text_prompts` (optional), `annotated_output_dir` (optional), `python_executable` (optional), `deck_corners_norm` (optional), `load_labels_sidecar` (optional), `class_prompts` (optional), `canonical_labels` (optional)

### `flex3d_open_viewer` [L4]

Open or close the local interactive Flex 3D preview. action=open (default) requires protocol_path (.py or analyze JSON); returns a browser URL and reuses this plugin's running viewer. Different protocols keep separate keyed URLs (up to four loaded models). action=close stops only the verified viewer owned by this plugin's data directory; protocol_path is unnecessary. A foreign port is left untouched with an actionable error. Online preview only; scene assets and private logs stay under PLUGIN_DATA, with no images or video exports. Local simulation only; no robot connection.

**Parameters:** `action` (optional), `protocol_path` (optional), `port` (optional), `python_executable` (optional)

### `flex3d_preflight_check` [L4]

Flex 3D physical preflight (MuJoCo). Runs automation/flex3d/scripts/render_protocol_3d.py on an opentrons analyze JSON or protocol .py: geometry, liquid, targets, clearance checks with command_index aligned to LogicPass step_index. Flex only (OT-2 refused). Degrades gracefully (ok=false, error=mujoco_missing) when mujoco is not installed. Returns passed/failed/unknown/not_applicable; failed checks set ok=false. Includes the complete warnings array and warnings_count. Uses the shared analysis cache. Checks and scene assets stay under PLUGIN_DATA; no image or video export. For a live 3D look at the deck use flex3d_open_viewer, which returns an online preview URL.

**Parameters:** `source`, `out_dir` (optional), `python_executable` (optional)

### `generate_continuation_protocol` [L4]

Generate a new tip-only continuation protocol from an awaiting-recovery run. This writes a local protocol file but does not stop, play, or move the robot.

**Parameters:** `robot_ip`, `run_id`, `session_id` (optional), `output_path` (optional), `page_length` (optional), `protocol_name` (optional), `use_session_state` (optional)

### `parse_error` [L4]

Parse run or maintenance command failures into structured runtime error categories.

**Parameters:** `robot_ip` (optional), `run_id` (optional), `context_type` (optional), `context_id` (optional), `session_id` (optional), `page_length` (optional)

### `suggest_recovery_action` [L4]

Recommend the next recovery branch from live run errors, robot/module state, and session bookkeeping.

**Parameters:** `robot_ip` (optional), `session_id` (optional), `run_id` (optional), `context_type` (optional), `context_id` (optional), `error_category` (optional), `target_slot` (optional), `failed_well` (optional), `tiprack_slot` (optional), `tip_binding_mode` (optional), `protocol_source` (optional), `file_path` (optional), `protocol_path` (optional), `tiprack_slots` (optional)

## Safety reminders

- Simulation gate is blocking before unattended live runs.
- Vision is observation-only; use `reconcile_state` for deck truth.
- `probe_wells` live motion requires `OPENTRONS_ENABLE_PROBE_WELLS=1`.
