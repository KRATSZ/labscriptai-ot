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
| 3 | Run `node scripts/verify-setup.mjs` | No failures (warnings about Python are OK until you configure simulation) |
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

3. Default prompts are pre-configured in the manifest interface.

4. Run verify-setup if MCP tools fail to load.

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

## Deck vision setup

Lab-trained deck vision is **observation-only** — compare results with `reconcile_state`, never treat vision as committed deck truth. Full workflow: [policy/workflows.md](../policy/workflows.md) (*Optional deck vision*).

### One-time machine setup

1. **Python vision deps** (in the same env as `OPENTRONS_PYTHON`):

   ```powershell
   .venv\Scripts\pip install ultralytics opencv-python-headless pillow
   ```

2. **Calibrate camera homography** (once per robot camera angle):

   ```powershell
   .venv\Scripts\python.exe automation\click_deck_corners.py --show
   ```

   Writes `automation/photo/deck_calibration.json`. `vision_check` loads these corners automatically.

3. **Machine layout policy** — edit `automation/deck_layout_policy.json` for fixed modules (PCR, trash, etc.) and which slots/classes to detect.

4. **Train or ship weights** — after bbox labeling:

   ```powershell
   .venv\Scripts\python.exe automation\export_yolo_dataset.py
   .venv\Scripts\python.exe automation\train_deck_yolo.py
   ```

   Produces `vision/models/weights/deck_v2_best.pt`.

### Runtime environment (optional overrides)

```powershell
$env:OPENTRONS_DECK_YOLO_WEIGHTS = "$PWD\vision\models\weights\deck_v2_best.pt"
$env:OPENTRONS_DECK_LAYOUT_POLICY = "$PWD\automation\deck_layout_policy.json"
$env:OPENTRONS_DECK_CALIBRATION = "$PWD\automation\photo\deck_calibration.json"
```

### Live MCP sequence

```
camera_status → capture_preview_image → vision_check
```

Ask the agent explicitly, e.g. *"Capture a deck photo and run vision_check; compare detection slots with reconcile_state."*

Verify install: `node scripts/verify-setup.mjs` (checks policy, calibration, weights, Python deps).

---

## Quick verification (manual)

```bash
cd servers/opentrons-mcp
OPENTRONS_PLUGIN_ROOT="$(cd ../.. && pwd)" npm test
```

Or from repo root: `node scripts/verify-setup.mjs`.

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
- [MCP_TOOLS.md](MCP_TOOLS.md) — tool reference by tier (L0–L4)
- [policy/workflows.md](../policy/workflows.md) — canonical workflow sequences
- [examples/](../examples/) — end-to-end example prompts
- [AGENTS.md](../AGENTS.md) — agent behavior contract

## Citation

Public use requires citing the LabscriptAI bioRxiv preprint (DOI: [10.1101/2025.09.30.679666](https://doi.org/10.1101/2025.09.30.679666)). See [LICENSE](../LICENSE) and [README.md](../README.md).
