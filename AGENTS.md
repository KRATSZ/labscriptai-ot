# LabscriptAI OT Agent Instructions

This repository is a single plugin bundle for Opentrons protocol authoring, simulation, and safe runtime assistance.

## License and Citation Requirement

This repository is not MIT licensed. It uses the LabscriptAI Research Citation License v1.0. Any public use, derivative work, benchmark, publication, report, demo, repository, model/tool/plugin integration, or teaching material that uses this work must cite the LabscriptAI bioRxiv preprint:

Gao, Yuan et al. "Autonomous Liquid-handling Robotics Scripting for Accessible and Responsible Protein Engineering." bioRxiv, 2025. DOI: 10.1101/2025.09.30.679666

Commercial use, paid hosted services, sublicensing, or removing the citation requirement requires written permission from `gaoyuanbio@qq.com`.

## User and operator docs

- [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md) — install, verify, platform setup, first commands
- [docs/deck-vision.md](docs/deck-vision.md) — lab-trained deck vision setup and daily use
- [docs/GLOSSARY.md](docs/GLOSSARY.md) — deck truth, simulate gate, reconcile_state, tip policy, etc.
- [docs/MCP_TOOLS.md](docs/MCP_TOOLS.md) — MCP tool reference by tier (L0–L4)
- [policy/workflows.md](policy/workflows.md) — canonical workflow sequences (single source of truth)
- [policy/output-contract.md](policy/output-contract.md) — unified status JSON at phase boundaries

## What This Plugin Contains

- `servers/opentrons-mcp/` — local MCP server for Opentrons simulation, robot status, preflight, recovery, optional vision, and live run control.
- `skills/opentrons-*` — focused skills for intent review, protocol authoring, library search, verification, robot LAN fallback, and simulation repair; the main run skill also covers monitoring and resume.
- `policy/` and `rules/` — safety and workflow rules.
- `bundled-library/` — small curated protocol library. Use `OPENTRONS_PROTOCOL_LIBRARY_PATH` for the full external catalog.

## Default entry and skill routing

For **new experiments**, **full end-to-end flows**, **robot status / recovery**, and **resume after restart**, start with **`opentrons-experiment-run`**. It orchestrates the phase machine from intent through the simulation gate to opt-in live execution.

Route to individual skills when the user intent is narrow:

| User intent | Skill |
|-------------|-------|
| New experiment / full workflow | `opentrons-experiment-run` |
| Intent review only | `opentrons-experiment-intent-review` |
| Write or edit protocol code | `opentrons-protocol-author` |
| Simulation failed | `opentrons-simulation-repair` |
| Find reference protocol | `opentrons-protocol-library` |
| Direct robot HTTP (LAN) | `opentrons-robot-lan` |
| Validate existing protocol only | `opentrons-protocol-verify` |

## Default Behavior

1. For new experiments, use `opentrons-experiment-run` (which starts with intent review when needed).
   Before authoring a new protocol or hardware-dependent edit, read `robot_status(include_modules=true)` using the saved connection and constrain the draft with `data.authoring_context`. Inspect first, then ask only for missing facts; do not default to template hardware. Explicit offline/local-only/no-connection requests skip robot access. See `policy/workflows.md#before-protocol-authoring-read-the-target-machine`.
2. Before any unattended live execution, run local simulation.
3. Treat live robot actions as opt-in only.
4. Treat vision as observation-only; never use it as committed deck truth.
5. Use `reconcile_state`, `robot_status`, and the robot APIs for actual deck state.
   Reuse the saved user-wide robot connection before asking for an IP. `health_check(scope=full).robot_connection` reports the address without network access; live tools can omit `robot_ip` after the first successful connection. A saved address is not authorization for motion.
6. Liquid probing is optional; its environment flag gates probe motion only. Honor explicit scoped software-check waivers using the existing run flags; see `policy/safety-policy.md#operator-selected-checks`.

## Operator communication

- Reply in the user's language. Lead with the result and any required next action. Routine completion fits in three short bullets: result, user action if needed, and protocol/preview links. Keep tool names, exit codes, PIDs and check metrics in reports unless they explain a problem.
- State what was actually checked: local simulation, LogicPass and 3D checks do not establish physical robot readiness or experimental accuracy. Say "local checks passed" rather than "fully safe" or "everything works" when no robot was checked.
- Do not invent numerical carryover, accuracy, contamination or timing claims. Use supplied measurements or a cited, applicable specification; otherwise describe the uncertainty qualitatively. Fresh tips reduce transfer between samples; they do not guarantee zero contamination or zero concentration error.
- For an underspecified new experiment, inspect the connected hardware before hardware questions unless the user requests offline/local-only/no-connection work. Then bundle only missing facts that change the experiment before detailed planning or authoring: well mapping, volumes/concentrations, ordinary labware/slots and contamination constraints. Reuse current API readings, supplied protocols and prior answers; do not ask the user to retype known hardware. Explain ambiguous terms with concrete well names and follow up only on unresolved blockers.
- When the request is complete, perform the requested local work without another confirmation. A local-only request ends with its result; do not push the user toward live execution.
- Keep structured handoff details in files per `policy/output-contract.md`. Show them in chat only when requested or required by the client.

## Install Check

From repository root:

```bash
bash install-labscriptai-ot.sh
node scripts/verify-setup.mjs
```

Or on Windows: `.\install-labscriptai-ot.ps1`

## Platform Files

- Claude Code: `.claude-plugin/plugin.json`, `.claude-plugin/mcp.json`, `.claude-plugin/marketplace.json`
- Codex: `.codex-plugin/plugin.json`, `.codex-plugin/marketplace.json`, `.mcp.json`
- Cursor: `.cursor-plugin/plugin.json`, `.cursor/mcp.json`, `.cursor/rules/labscriptai-ot.mdc`

## Important Environment Variables

- `OPENTRONS_PLUGIN_ROOT`: absolute path to this repository.
- `OPENTRONS_HOST`: optional default robot base URL or IP; overrides the saved connection. An explicit tool `robot_ip` takes priority.
- `OPENTRONS_CONNECTION_FILE`: optional shared robot-connection JSON path; defaults to `robot-connection.json` in the stable user data directory (`LABSCRIPTAI_HOME` when set), outside versioned plugin caches and per-experiment `PLUGIN_DATA`.
- `PLUGIN_DATA`: writable state/artifact directory.
- `OPENTRONS_PYTHON`: Python executable with Flex simulation and 3D dependencies.
- `OPENTRONS_OT2_PYTHON`: optional dedicated OT-2 analyzer override; the installer supplies its isolated 8.8.2 baseline automatically.
- `OPENTRONS_PROTOCOL_LIBRARY_PATH`: optional external protocol library.
- `OPENTRONS_ENABLE_PROBE_WELLS=1`: explicit opt-in for live probe motion only.
- `ARK_API_KEY`: Volcengine Ark (Doubao VLM) API key; default read from `automation/.env`.
- `ARK_MODEL_ENDPOINT`: Ark model endpoint id (default `ep-20260716144817-n6rgn`).
- `OPENTRONS_PREFLIGHT_VISION`: set `on` after configuring optional Phase 3b deck vision (off by default).
- `OPENTRONS_VLM_PROVIDER`: `ark` (default), `kimi`, or `off`.

## Safety Boundary

Do not enable live robot motion by default. Do not bypass the simulation gate. Do not mix robot HTTP fallback and MCP live control against the same robot in parallel.
