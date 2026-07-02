# LabscriptAI OT outbox wake acceptance - GPT-5.5

Date: 2026-07-01
Repo: `/Users/gaoyuan/Documents/test/Flexagent/labscriptai-ot`
Branch context: `main`

## 1. Conclusion

**PARTIAL.** The core outbox wake implementation tests pass and the five adapter names are present in consumer/runtime delivery, but the operator-facing unattended-wake entry points still describe or arm only the original three hosts in key places, so five-host acceptance is not fully operator-ready.

## 2. Full test result

Command run from `servers/opentrons-mcp`:

```bash
node --test
```

| Result | Count |
|---|---:|
| Pass | 300 |
| Fail | 0 |
| Skipped | 0 |
| Todo | 0 |
| Cancelled | 0 |
| Suites | 1 |
| Duration | 5323.860417 ms |

Failure reasons: none.

## 3. Five-host wiring check

| Host | Files / commands checked | Alignment |
|---|---|---|
| Cursor | `hooks/cursor/hooks.json`; `sessionStart` and `stop` both call `scripts/consume-runtime-outbox.mjs --host cursor`; `stop` maps through consumer to `followup_message`; `loop_limit: null` set. | PASS |
| Claude Code | `hooks/claude/hooks.json` has `SessionStart`, `UserPromptSubmit`, `Stop`; `Stop` calls `--host claudecode --hook-event Stop`; `hooks/claude/monitors.json` runs `runtime-recovery-monitor.mjs --notify-adapters claudecode`. | PASS |
| Codex | `hooks/codex/hooks.json` calls `--host codex`; `scripts/install-codex-hooks.mjs` rewrites plugin-root paths; `install-labscriptai-ot.sh` can write `~/.codex/hooks.json` when absent. | PASS with caveat: installer prints manual merge when `~/.codex/hooks.json` already exists. |
| Pi | `hooks/piagent/README.md`, `pi-outbox-wake.ts`, `settings.fragment.json`, and `runtime-outbox-agent-end.sh` exist; consumer accepts `--host piagent`; runtime delivery writes adapter `piagent`. | PARTIAL: hook files and adapter are present, but default arm/install path does not create or notify `piagent`. |
| OpenCode | `hooks/opencode/README.md`, `labscriptai-outbox-wake.ts`, `opencode.fragment.jsonc`, and `docs/outbox-wake-pi-opencode.md` exist; consumer accepts `--host opencode`; runtime delivery writes adapter `opencode`. | PARTIAL: hook files and adapter are present, but default arm/install path does not create or notify `opencode`. |

Adapter consistency:

| Check | Result |
|---|---|
| `scripts/consume-runtime-outbox.mjs` valid hosts | `cursor`, `claudecode`, `codex`, `piagent`, `opencode` |
| `servers/opentrons-mcp/lib/runtime-outbox.js` file delivery adapters | `claudecode`, `codex`, `cursor`, `piagent`, `opencode` plus `cli`/`webhook` and `claude` alias normalization |
| MCP `runtime_watch_loop` / `runtime_deliver_outbox` schemas | Include `piagent` and `opencode` |
| `scripts/runtime-recovery-monitor.mjs` configurable/autodetect adapters | Include `piagent` and `opencode` |
| `scripts/arm-runtime-watch.sh` | Exists, but hardcodes only `cursor,claudecode,codex` and only creates those three mailbox directories |

## 4. Targeted tests and smoke

| Check | Command | Result |
|---|---|---|
| Consumer targeted test | `node --test test/consume-runtime-outbox.test.js` | PASS: 14 pass, 0 fail, 0 skipped |
| Runtime outbox targeted test | `node --test test/runtime-outbox.test.js` | PASS: 5 pass, 0 fail, 0 skipped |
| Cursor empty mailbox smoke | `PLUGIN_DATA=<tmp> OPENTRONS_SESSION_ID=smoke-empty node scripts/consume-runtime-outbox.mjs --poll-once --host cursor` | PASS: exit 0, stdout `NO_WAKE` |
| Claude synthetic wake smoke | synthetic `host-adapters/claudecode/smoke-claude.jsonl`, then `node scripts/consume-runtime-outbox.mjs --host claudecode --hook-event Stop --session-id smoke-claude --dry-run --source adapter` | PASS: exit 0, continuation includes `GOAL_STATUS`, `runtime_get_outbox`, `notify_adapters=["claudecode"]`, and `no_robot_motion=true` |

## 5. GETTING_STARTED unattended wake

`docs/GETTING_STARTED.md` has an `Unattended wake (three-host self-watch)` section that is followable for Cursor, Claude Code, and Codex. The smoke command is correct for Cursor and documents that consume only injects continuation prompts.

Gap: the section is not a five-host operator guide. It does not mention Pi/OpenCode setup, and step 2 says the monitor delivers to "all three adapters". For the new five-host scope, operators must also read `docs/outbox-wake-pi-opencode.md`; however that document suggests `bash scripts/arm-runtime-watch.sh --notify-adapters piagent,cli` / `opencode,cli`, while `arm-runtime-watch.sh` appends its own hardcoded `--notify-adapters cursor,claudecode,codex`, so those commands are not reliable as written.

## 6. verify-setup

Command:

```bash
node scripts/verify-setup.mjs
```

Result: usable setup with **19 passed, 1 warning, 0 failures**.

Warning: vision Python deps are not importable (`ultralytics` / `opencv` / `pillow`). This is unrelated to outbox wake, but should be resolved before live vision workflows.

## 7. Safety check

| Check | Result |
|---|---|
| Consumer bypasses simulation gate | No. `consume-runtime-outbox.mjs` reads mailbox/outbox, formats continuation prompts, and optionally acks outbox events; it does not call robot motion or simulation-bypass paths. |
| Hook files trigger robot motion | No direct robot motion found. Hooks call consumer only; monitor/arm path uses runtime monitor delivery and prompts with `self_fix_mode="observe"` / `no_robot_motion=true` language. |
| Live robot actions opt-in | Preserved. Continuation prompt says hard stops block, liquid recovery requires `live_liquid_recovery_gate` and operator opt-in. |

## 8. Gaps Top 3

1. **Five-host docs are split and inconsistent.** `GETTING_STARTED.md` still presents unattended wake as three-host only; Pi/OpenCode require separate docs, so a new operator cannot follow one canonical five-host path.
2. **`arm-runtime-watch.sh` is not five-host-ready.** It creates only `cursor`, `claudecode`, `codex` directories and hardcodes `--notify-adapters cursor,claudecode,codex`; Pi/OpenCode documentation examples that pass `--notify-adapters` to this script are likely overridden by the appended hardcoded value.
3. **Installer wiring remains three-host-first.** `install-labscriptai-ot.sh` creates only three adapter dirs and prints "Unattended wake (three hosts)"; Pi/OpenCode fragments are present but not integrated or surfaced by the default install flow.

## 9. Git change list

`git status --short` reported these modified tracked files:

```text
 M .claude-plugin/plugin.json
 M .codex-plugin/plugin.json
 M docs/GETTING_STARTED.md
 M docs/MCP_TOOLS.md
 M docs/ROADMAP-virtual-lab.md
 M install-labscriptai-ot.sh
 M scripts/runtime-recovery-monitor.mjs
 M servers/opentrons-mcp/index.js
 M servers/opentrons-mcp/lib/liquid-source-substitution.js
 M servers/opentrons-mcp/lib/probe.js
 M servers/opentrons-mcp/lib/runtime-outbox.js
 M servers/opentrons-mcp/lib/runtime-watch/watch-loop.js
 M servers/opentrons-mcp/lib/state.js
 M servers/opentrons-mcp/test/liquid-source-substitution.test.js
 M servers/opentrons-mcp/test/runtime-outbox.test.js
 M servers/opentrons-mcp/test/runtime-watch.test.js
 M servers/opentrons-mcp/test/state.test.js
```

Untracked groups/files relevant to this acceptance:

```text
?? docs/outbox-wake-pi-opencode.md
?? hooks/
?? scripts/arm-runtime-watch.sh
?? scripts/consume-runtime-outbox.mjs
?? scripts/install-codex-hooks.mjs
?? servers/opentrons-mcp/test/consume-runtime-outbox.test.js
?? runs/
```

Other untracked groups are present, including `.DS_Store`, `.codegraph/`, `.codex/`, `cas-siat-report/`, and additional `runs/` artifacts. No `LICENSE`, citation file, or `automation/` path showed changes in the protected-path status check.

## 修复回填（composer-2.5）

| Item | Change |
|---|---|
| `docs/GETTING_STARTED.md` | Renamed section to five-host self-watch; step 2 uses `arm-runtime-watch.sh` default (all five adapters); Pi/OpenCode marked experimental with link to `docs/outbox-wake-pi-opencode.md`; documents `OPENTRONS_NOTIFY_ADAPTERS` override. |
| `scripts/arm-runtime-watch.sh` | Default `--notify-adapters` is `cursor,claudecode,codex,piagent,opencode` (overridable via `OPENTRONS_NOTIFY_ADAPTERS`); creates all five mailbox dirs; printed adapter list matches runtime. |
| `install-labscriptai-ot.sh` | Creates `host-adapters/piagent` and `host-adapters/opencode`; install footer points to five-host GETTING_STARTED anchor plus Pi/OpenCode READMEs and `docs/outbox-wake-pi-opencode.md`. |
| `docs/outbox-wake-pi-opencode.md` | Pi/OpenCode arm examples aligned to same default adapter list as `arm-runtime-watch.sh` (no conflicting per-host `--notify-adapters` on arm script). |

Targeted re-test (`servers/opentrons-mcp`):

```bash
node --test test/consume-runtime-outbox.test.js test/runtime-outbox.test.js
```

Result: **19 pass, 0 fail** (14 consume + 5 runtime-outbox).
