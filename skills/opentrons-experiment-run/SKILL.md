---
name: opentrons-experiment-run
description: Default entry for experiment setup, running, monitoring and recovery. Uses saved target hardware for offline-capable authoring, then simulates locally and refreshes live state before execution.
---

# Run an experiment

Help the user get the requested experiment done. Use the steps that apply; a small task does not need the whole workflow. Canonical rules: `policy/safety-policy.md`, `policy/workflows.md`, `policy/error-response.md`.

## Working with the user

- Speak in the user’s language. Lead with what happened and the next useful action. Keep phase numbers, gates, ledger names and JSON out of routine chat.
- For a new experiment, read `robot_authoring_context()` before hardware questions or authoring. It reads saved hardware locally, including during offline/local-only/no-connection work. Reuse snapshots across chats/restarts without requiring a live connection; then ask a short initial round only for unresolved assay, mapping, labware and tip-policy facts. Do not ask the user to retype recorded pipettes, mounts, modules or robot type. If no snapshot exists, use supplied hardware constraints or capture once when online. See `policy/workflows.md` § Before protocol authoring.
- Wait for answers to blocking questions before dependent authoring or actions; continue independent read-only checks while waiting. If the request already specifies the necessary facts (for example, “simulate this OT-2 script locally”), proceed without a ceremonial confirmation. Do not repeat answered questions or treat silence as an answer.
- When the user says to proceed, do the authorized work. Do not turn every suggestion, optional check, missing API reading or bookkeeping limitation into a refusal.
- Explain an actual problem once, with a practical way forward. Skip repeated warnings and requests to recite risk acceptance.
- Record compact progress at major changes per `policy/output-contract.md`. Do not create a design report or make the user fill out a form just to run a test.

## 1. Prepare only what is needed

- Before choosing a template or writing machine-specific Python, use the saved `authoring_context` to constrain robot type, pipettes/mounts, modules/locations and waste fixtures. Templates do not override the target hardware. Resolve target mismatches or missing critical hardware facts; an unavailable connection alone does not block writing. Record the snapshot's observation time and supplied changes. Use `robot_authoring_context(refresh=true)` for requested refreshes; never refresh over the network for an explicit no-connection task. Always use fresh live state before execution.
- For ambiguous wells or volumes, use `opentrons-experiment-intent-review`. For writing/editing, use `opentrons-protocol-author`. Use the library only when reference protocols are wanted.
- Existing runnable protocol → simulate it. Do not require rewriting it into a preferred template.
- Keep the requested liquids, well mapping, modules and tip strategy. Suggest improvements without silently changing the experiment.
- `dry_run_on` defaults off when offered. “Test experiment” alone does not mean liquid-free or authorize returning used tips.
- Source maps help tracking and recovery. Record known values; do not invent amounts or demand a complete map for work that does not need one.
- Record the machine snapshot and user-confirmed additions in `design-notes.json.hardware_context`. Ordinary labware/remaining tips/liquid contents and unreported passive modules are not established by status APIs or old runs; ask only for the relevant unknowns. A fresh pre-run status check is still required because the machine may change after drafting.

## 2. Check the protocol locally

- Use `health_check(scope=local)` when runtime readiness is unknown, then `simulate_protocol`. Repair a simulation error before live execution.
- `simulate_protocol` automatically returns `experiment_figure` plus inline PNG content. Present the image using the returned `png_path` in a Markdown image embed, and link `page_path` for all image pages and the exact well table. When opening the 3D viewer, also link `experiment_figure.url`; its toolbar provides the same setup-image entry. Do not ask users to remember a new command. Figures show declared starting setup, not guessed final composition; a drawing failure does not change simulation results or block the existing workflow. Keep the image concise: Chinese sans-serif, graphical wells/slots, no “design preview”, “not onsite”, preview dates or similar boilerplate.
- Run `logicpass_check` on the same cached analysis. It checks supported liquid-volume rules; it does not establish gripper or physical robot readiness.
- `pass` → continue. `fail` → explain the actual issue and suggest a fix. `unevaluable` → say what the tool cannot check; do not present this as an observed experimental failure.
- If the operator explicitly waives the liquid check, use `run_protocol(skip_logicpass_gate=true)`. Record skipped, not passed. The tool still runs local simulation.
- When proposed `virtual_lab_steps` are available, validate them during simulation. Missing optional step annotations alone do not require inventing a second protocol representation.
- After a successful `simulate_protocol`, show the returned `preview_3d.url` together with the setup-image link. Preview is automatic for OT-2 and Flex; do not stop at “simulation passed”, ask whether to generate it, or call `flex3d_open_viewer` again when a ready URL is already returned. If the user explicitly declines preview, pass `generate_3d_preview=false`. If preview is unavailable, report the returned reason once and preserve the simulation verdict; do not retry the same unavailable preview without a relevant change. See `policy/workflows.md` § Automatic 3D preview.
- `flex3d_preflight_check` remains a separate optional geometry/liquid/targets/clearance check; a playable preview does not mean those checks passed. Use the analyzed robot type. OT-2 uses its own pipettes, numbered deck slots and supported module set; do not offer Flex gripper or liquid-presence sensing on OT-2.

## 3. Read the live state; choose optional checks

- Reuse the saved robot connection across chats. Before asking for an IP, inspect `health_check(scope=full).robot_connection` (local metadata only), or call the requested read-only robot tool without `robot_ip`; it resolves explicit address → `OPENTRONS_HOST` → saved user address. Ask once only when none exists. A successful connection saves the address outside plugin caches; a newly supplied address replaces it after success. If the saved robot is unreachable, report that address and ask whether it changed rather than demanding it again. Saving an address does not authorize motion.
- Use `robot_status(include_modules=true)` and read-only readiness tools as needed. Reconcile an actual session/deck conflict with `reconcile_state` before relying on that state.
- Report known faults accurately. Door open, an engaged estop or a collision is different from an endpoint that returned no reading. Missing door/estop readings are `not_checked` warnings.
- A module heating/cooling toward its target is not automatically a startup blocker: check whether the protocol waits for it. Do not require unused modules to be ready.
- Vision is optional, observation-only, enabled when configured/requested. If declined/unavailable, record not checked and continue with the user’s known deck setup.
- **Liquid probing is optional.** A critical-source list is a list of suggested targets, not a command to probe. If declined, disabled or unavailable, skip it and continue the ordinary run. Do not demand `OPENTRONS_ENABLE_PROBE_WELLS=1` to call `run_protocol`.
- For a selected live probe only: simulate `probe_wells`; obtain permission for that motion; require `OPENTRONS_ENABLE_PROBE_WELLS=1`; then probe selected wells → `apply_liquid_probe_results` → `live_liquid_recovery_gate`. A failed selected probe needs review; do not erase its result.
- Before a separate maintenance `home`, use `is_home_safe`. Do not add maintenance homing just because a run was requested.

## 4. Run under the user’s existing permission

- Motion needs authorization for this protocol and action. “Start this test; I am here and can stop it” is authorization for that unchanged test. Do not ask again just because an optional check was skipped.
- Use `run_protocol(file_path, robot_ip, session_id)` with only the skip flags that match the user’s request:
  - Liquid ledger waived → `skip_logicpass_gate=true`.
  - Software preflight waived → `skip_preflight=true`.
  - Only deck comparison waived → `skip_preflight_deck_diff=true`.
- Say what was skipped once. Keep hardware interlocks and actual fault states intact. Never call a skipped check passed.
- Example: “跳过液体账本和液位探测，开始这次测试，我会手动停” → omit probing, call `run_protocol(skip_logicpass_gate=true)` using the already known file/robot. A suitable reply is “按你说的跳过这两项，开始本次测试；跳过项会留记录。” Say “已启动” only after the tool actually starts it.
- Monitor with `runtime_watch(mode=poll)` after a returned run ID. Report completion, an actionable problem, or loss of connection. Do not flood chat with polling details or photograph every step.
- For requested continued monitoring, use the bounded `runtime_watch(mode=loop)` workflow in `policy/workflows.md`. Use its existing opt-in options for automatic recovery; do not silently enable them.

## 5. Handle a real interruption

- Read the error → `parse_error` → `suggest_recovery_action`; use supported recovery tools. A collision, hardware fault or engaged estop needs a physical check; do not blindly retry motion.
- For ordinary recoverable problems, explain the specific options: fresh tip, refill, an approved reserve, revised remaining steps, or continuing with an accepted quality limitation. Respect a choice already made for that scope.
- Time-window overrun or uncertain liquid amount is a quality question, not proof the robot is broken. Present the consequence plainly; an explicitly accepted limitation should not trigger the same confirmation again.
- Do not guess a missing delivered volume or silently swap samples. Use the agreed recovery plan; ask only when the next action really depends on new information.
- Tip counts matter for completing the requested scope. If there are too few, offer replenishment or a shorter run; do not claim the full protocol can finish.
- Source substitution, contamination and partial-dispense details: see `policy/error-response.md`. Use the recovery channel tools only when relevant; a normal startup does not need the entire recovery pipeline.
- After restart/context loss, use `safe_next_action` to recover current progress. History is an audit aid, not a substitute for current robot state.

## Finish

Report the actual result, any action still needed, and useful protocol/preview links. A local check does not mean a robot experiment ran. Keep supporting logs in the project.
