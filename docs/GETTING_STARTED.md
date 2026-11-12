# Getting started

Write an Opentrons protocol, check it locally, and preview Flex motion before choosing whether to connect a robot. No robot, camera, vision weights or API key is needed for local simulation and 3D preview.

## 1. Install the local runtime

Install **Node.js 18+** and either **uv** or **Python 3.11–3.13** first. Download and extract the [release ZIP](https://github.com/KRATSZ/labscriptai-ot/releases/latest), open a terminal in its `labscriptai-ot/` folder, then run:

```bash
bash install-labscriptai-ot.sh
```

Windows PowerShell:

```powershell
.\install-labscriptai-ot.ps1
```

The installer installs dependencies and runs the local self-check automatically. Look for **0 failures**. Detailed Flex models are included and used automatically. Dependencies download on first install and take additional disk space; the ZIP is not the total installed size.

To recheck later: `node scripts/verify-setup.mjs`. Add `--verbose` for details. Dependencies and default user records live in a stable per-user directory, so a new plugin folder or client cache reuses them. An upgrade with changed dependencies needs the installer once; unchanged dependencies work offline. `LABSCRIPTAI_HOME` overrides that directory; an explicit `PLUGIN_DATA` still controls user records.

Upgrading from 0.1.1: keep an existing `PLUGIN_DATA` setting. Updating the original folder copies its old `.plugin-data` records into the shared user directory when that directory has no records yet. If you move to a new folder, the installer cannot discover records left in the old folder: keep `PLUGIN_DATA` pointing there, or copy those records to the new data directory before removing the old folder.

## 2. Connect your client

### Cursor

From the plugin folder, generate configuration for your existing project:

```bash
node scripts/configure-cursor.mjs "/absolute/path/to/your/project"
```

The helper adds `opentrons-lab` and a short skill-routing rule, uses absolute paths, and preserves other MCP servers. Reload Cursor, open that project, and confirm **opentrons-lab is connected** in MCP settings. Re-run the helper after moving the plugin. It refuses malformed configuration or a conflicting rule rather than overwriting them.

### Claude Code

For the extracted ZIP, load the same folder you installed in step 1:

```bash
claude --plugin-dir "/absolute/path/to/labscriptai-ot"
```

This keeps the installed runtime and plugin together. To check discovery before opening a chat: `claude plugin validate .claude-plugin/plugin.json`.

Marketplace installation is also supported:

```text
/plugin marketplace add KRATSZ/labscriptai-ot
/plugin install labscriptai-ot@labscriptai-ot-marketplace
```

Marketplace copies share the installed runtime when their dependencies match. Run the installer once from the extracted ZIP, install the plugin, then reload your client. You do not need to find and install inside every cache folder.

### Codex

Register the extracted folder as a local marketplace:

```bash
codex plugin marketplace add "/absolute/path/to/labscriptai-ot"
```

Restart the desktop app, open the plugin browser, select **labscriptai-ot-marketplace**, and install **LabscriptAI OT**. Local plugin installation and cache behavior are described in the [official OpenAI guide](https://developers.openai.com/plugins/build/plugins#install-a-local-plugin-manually).

Codex loads a cached copy and reuses the shared runtime. After reloading, ask the agent to run `health_check` without a robot IP: `mcp_server.version`, `build_id` and `entrypoint` identify the version and copy actually in use. See [MCP startup help](runbooks/mcp-wont-start.md). An older CLI without `plugin marketplace` needs an update before using this command.

## 3. Try a local task

Copy this as your first message (attach the protocol or give its path):

> Check this Opentrons protocol locally. Explain any problems, run simulation and liquid-volume checks, and show an OT-2 or Flex 3D preview as appropriate. Do not connect to a robot.

Or start a new protocol:

> Help me write a Flex protocol. Ask about any missing experiment details first, then write and validate it locally. Do not connect to a robot.

Expect a short result, a protocol/report link, and any question that still blocks the work. The agent should ask when mapping, volume, installed equipment or sample-handling requirements are unclear.

For a bundled example, use [the Flex serial dilution walkthrough](../examples/01-flex-serial-dilution/README.md). The 3D preview starts on the deck; use **Machine** for the enclosure and **Reset view** to return to the default angle. Raw step parameters are collapsed. It is a local browser page; you can ask the agent to close it when finished. OT-2 and Flex protocols both support local validation and 3D preview; the analyzed robot type selects the model.

Simulation now also generates an **experiment setup image** automatically: deck slots, modules, labware and declared starting liquids. Ask the agent to show its returned PNG; no extra command is needed. In the animation page, select **实验配置图 / Experiment setup image** to view/download all image pages and the per-well CSV. Large experiments are split into pages. Starting amounts come from `define_liquid` / `load_liquid`. A missing liquid name receives a stable **未知液体1 / Unknown liquid 1** label. If aspiration requires contents in a well without a starting inventory, that source receives its own label and color, preserved through transfers. The setup image marks it with **?**, the CSV leaves its starting amount blank, and the 3D legend identifies its source well. Its translucent source level is schematic; transfer animation uses command volumes, without establishing actual remaining amounts or mixture ratios. Unused undeclared wells remain **未声明**. Explicit empty wells and insufficient declared volumes retain their existing checks. PNG generation works offline with the bundled Chinese sans-serif font, independently of 3D. If it fails, the existing simulation result and animation remain available. After upgrading with an older viewer already running, close and reopen the preview to load the new renderer and liquid annotations.

## Remember the robot address

Provide your robot's IP once when first connecting, for example “Check the robot at 192.168.1.50”. After a successful connection, the plugin saves it automatically and reuses it in new chats and after a restart or plugin upgrade. To change robots or update an IP, provide the new address; it replaces the saved address after a successful connection. An unreachable address does not overwrite a working saved address.

Robot tools accept an optional `robot_ip` (bare IP, hostname, host:port or HTTP(S) base URL). Resolution order is explicit `robot_ip` → `OPENTRONS_HOST` → saved connection. `health_check(scope=full)` reports `robot_connection.robot_ip`, `source` and `config_path` without connecting unless an address is explicitly supplied; `health_check(scope=robot)` checks the saved robot. Local-only checks remain local, and saving an address does not authorize motion.

MCP and the LAN fallback share `robot-connection.json` under the stable user directory: `%LOCALAPPDATA%/labscriptai-ot` on Windows, `~/Library/Application Support/labscriptai-ot` on macOS, and `${XDG_DATA_HOME:-~/.local/share}/labscriptai-ot` on Linux. `LABSCRIPTAI_HOME` overrides this directory; `OPENTRONS_CONNECTION_FILE` optionally selects a specific file. The connection is independent of per-experiment `PLUGIN_DATA` and versioned plugin caches. Remove that file to forget the saved address (an explicit `OPENTRONS_HOST` still takes precedence).

## Write using saved robot hardware

Read the machine once while it is online with `robot_authoring_context(refresh=true)` or `robot_status(include_modules=true)`. A successful full read automatically saves the OT-2/Flex model, installed pipettes and mounts, attached modules/locations, waste/deck fixtures and original observation time. Snapshots live under `robot-hardware/` beside the user-wide connection file, independently of experiment folders and versioned plugin caches, with a separate record for each normalized robot address.

For later experiments and hardware-dependent edits, `robot_authoring_context()` reads that saved configuration locally without contacting the robot. You can write and simulate while the robot is off, in a new chat, or after a restart. There is no age-based network refresh. After changing hardware or layout, ask to refresh when online, or supply the changed constraints. A new robot address selects a separate snapshot. Ordinary labware/slots, clean-tip availability, liquids and unreported passive modules/adapters still need your information when relevant; no snapshot means the agent asks for missing equipment details or an initial capture instead of requiring connectivity or guessing template hardware.

Explicit “offline”, “local only”, or “do not connect” requests use saved/supplied constraints and never refresh over the network. You can still explicitly request a read-only live inspection, which does not move the robot. Design notes record the hardware source and observation time. Saved hardware is not current physical readiness: transient tip attachment, temperatures, door and estop state are not reused. Local simulation and a fresh live readiness check still happen before an authorized run. `robot_status` always contacts the robot and never returns cached readiness; failed or partial reads leave the last full snapshot intact.

## What a passing result means

- **Simulation:** the Opentrons software can interpret and execute the protocol locally.
- **Liquid-volume checks (LogicPass):** the available command trace passes supported source-volume and well-capacity rules. Missing evidence is reported as unevaluable.
- **3D checks:** supported geometry, targets and motion clearances pass; unavailable checks remain unknown or not applicable.

These results do not measure pipetting accuracy or verify the physical deck. A live run requires the robot's current state, a person at the robot and explicit motion authorization. Local-only tasks end with their local results.

## LogicPass gate

`logicpass_check` checks liquid use: `pass` means supported checks passed, `fail` means an issue was found, and `unevaluable` means the tool cannot assess part of the protocol. It gates runs by default. You can explicitly skip it for a run/test; the agent uses `skip_logicpass_gate=true` and records the omission. Optional liquid probing does not need to be enabled for an ordinary run. Local simulation still runs; missing checks are not reported as passed.

## If something fails

| What you see | Next action |
|-------------|-------------|
| Node/npm is missing | Install Node.js 18+ and rerun the installer |
| Python or Opentrons is missing | Install uv or Python 3.11–3.13; rerun the installer from the new plugin ZIP |
| Cursor cannot find the server | Re-run `configure-cursor.mjs` with your project path, then reload MCP |
| Client uses an old plugin copy | Check `health_check.mcp_server.version` and `build_id`; update the plugin and reload |
| The protocol fails simulation | Let the agent explain and repair the specific error; [simulation help](runbooks/simulation-fails.md) |
| 3D port is occupied by another service | Ask the agent to use a different port; unrelated services are left running |

[MCP startup help](runbooks/mcp-wont-start.md) · [Optional deck vision](deck-vision.md) · [Advanced liquid-probe/recovery diagnostics](runbooks/probe-wells-live-validation.md) · [Tool reference](MCP_TOOLS.md) · [Workflow policy](../policy/workflows.md)

Public use requires the citation in [LICENSE](../LICENSE) and [CITATION.cff](../CITATION.cff).

## OT-2 and Flex 3D runtime

The installer sets up Flex's Opentrons 9.x environment and a separate OT-2 analyzer pinned to the accepted 8.8.2 baseline. It does not downgrade Flex. The existing `flex3d_preflight_check` and `flex3d_open_viewer` tools accept either robot's protocol/analysis; their names are kept for compatibility. The viewer selects the model from the analyzed robot type. A missing/unknown/conflicting robot type is an explicit error, never a Flex fallback.

For source development, `uv sync` alone only creates the Flex environment. Run `node scripts/install-runtime.mjs` for both, or set `OPENTRONS_OT2_PYTHON` to an existing OT-2 analyzer. Both analyzers are local-only; 3D preview does not connect to a robot. See [OT-2 supported model scope](../automation/flex3d/cad/ot2/ORIGIN.md).
