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

> Check this Opentrons protocol locally. Explain any problems, run simulation and liquid-volume checks, and show a 3D preview if it is a Flex protocol. Do not connect to a robot.

Or start a new protocol:

> Help me write a Flex protocol. Ask about any missing experiment details first, then write and validate it locally. Do not connect to a robot.

Expect a short result, a protocol/report link, and any question that still blocks the work. The agent should ask when mapping, volume, installed equipment or sample-handling requirements are unclear.

For a bundled example, use [the Flex serial dilution walkthrough](../examples/01-flex-serial-dilution/README.md). The 3D preview starts on the deck; use **Machine** for the enclosure and **Reset view** to return to the default angle. Raw step parameters are collapsed. It is a local browser page; you can ask the agent to close it when finished. OT-2 protocols support local validation, but the 3D viewer is Flex-only.

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
