# LabscriptAI OT

Single plugin bundle for Cursor, Claude Code, and Codex-style agents — Opentrons protocol authoring, local simulation, and safe live runtime assistance.

Author: `gaoyuan` · Contact: `gaoyuanbio@qq.com` · Repository: https://github.com/KRATSZ/labscriptai-ot

## Install

Download and extract the ZIP from the [latest release](https://github.com/KRATSZ/labscriptai-ot/releases/latest), then run:

```bash
cd labscriptai-ot
bash install-labscriptai-ot.sh          # macOS / Linux; installs Node and Python dependencies
# .\install-labscriptai-ot.ps1          # Windows PowerShell
```

For source development, clone this repository instead of downloading the ZIP.

Then enable the plugin in your client. **Start here:** [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md) (Claude Code, Codex, and Cursor setup, first commands, troubleshooting).

## What's included

- MCP server (`servers/opentrons-mcp/`), Opentrons agent skills, safety policy, curated protocol library
- `automation/` — custom labware (e.g. third-party tip racks) and on-robot verification helpers; see [docs/custom-labware-guide.md](docs/custom-labware-guide.md)
- `automation/flex3d/` — optional OT-2/Flex 3D protocol preview (MuJoCo physics checks + Three.js viewer); see [Flex 3D preview](#flex-3d-preview-optional)
- Live robot actions are **opt-in**; simulation **and LogicPass** gate unattended live use — see [docs/GETTING_STARTED.md#logicpass-gate](docs/GETTING_STARTED.md#logicpass-gate). Flex simulation runs on `opentrons>=9,<10`; OT-2 analysis uses a separate `opentrons==8.8.2` environment. Use the installer to set up both (a standalone `uv sync` sets up Flex only)
- Glossary: [docs/GLOSSARY.md](docs/GLOSSARY.md) · Workflows: [policy/workflows.md](policy/workflows.md)

## Flex 3D preview (optional)

MuJoCo-based 3D checks and an interactive browser viewer for **OT-2 and Flex protocols**. The existing `flex3d_*` tool names are retained for compatibility; analysis selects the correct model. The installer supplies separate analyzers: Opentrons 9.x for Flex and the accepted Opentrons 8.8.2 baseline for OT-2, so installing OT-2 support does not downgrade Flex. Set `OPENTRONS_OT2_PYTHON` only to override the OT-2 analyzer. Unknown or conflicting robot types are rejected.

OT-2 reuses the existing refined single/eight-channel models, numbered deck, tip/liquid tracking, Magnetic V1/V2, Temperature V1/V2 and Thermocycler V1. Unsupported modules/actions and partial nozzle layouts remain explicit errors. Module/motion timing is illustrative; explicit waits/holds are retained. Geometry checks use sampled envelopes, not continuous collision certification or hardware calibration. See [asset provenance and scope](automation/flex3d/cad/ot2/ORIGIN.md).

- MCP tool `flex3d_preflight_check` — runs geometry / liquid / targets / clearance checks on an analyze JSON or protocol `.py`; failing checks carry `command_index` aligned with LogicPass `step_index`. Degrades gracefully when mujoco is missing. Returns `status=passed/failed/unknown/not_applicable`; a failed check sets `ok=false`. Analysis, check reports and scene assets stay under `PLUGIN_DATA`. The JSON and saved check report include the full ordered `warnings` array and `warnings_count`. No images or videos are rendered.
- MCP tool `flex3d_open_viewer` — opens or reuses the interactive viewer and returns its keyed browser URL plus an **experiment setup image**. The viewer's **实验配置图 / Experiment setup image** link opens the PNG preview, download and exact per-well CSV. `simulate_protocol` also returns the image automatically, including inline MCP image content. Images show declared starting setup and liquids, not inferred final concentrations. Figure generation does not require MuJoCo or a robot, and a figure error leaves simulation and animation usable. Use `action=close` to stop the viewer; a bare `/viewer.html` redirects to the loaded model. No video is rendered.
- CLI: `python automation/flex3d/scripts/render_protocol_3d.py <analysis.json|protocol.py> [--out DIR]` prints one JSON object (checks only, no video).
- Flex-only rendering CLI (from `automation/flex3d/`, using the plugin Python environment): `python -m sim.play_protocol <analysis.json|protocol.py>` prints the checks and writes a trace. Rendering is opt-in and off by default: `--stills` adds still PNGs plus a contact sheet, `--video` adds an MP4 (`--from 12 --to 16` exports only seconds 12–16 on the original timeline), `--frame T` renders single frames, `--view` opens the MuJoCo window.
- Video export prefers NVIDIA NVENC, then AMD AMF, and falls back to CPU (`libx264`). Each hardware encoder is tested with a real frame at the export resolution before use; a later encoder failure restarts the export from the beginning with the next encoder. Logs and the trace record the encoder actually used. Set `FLEX3D_VIDEO_ENCODER=libx264` to force CPU, or `h264_nvenc` / `h264_amf` to try that encoder before CPU. Intel Quick Sync is not selected automatically. AMF may use an integrated AMD GPU depending on driver configuration. This selects **video encoding**, while MuJoCo's OpenGL scene rendering uses the OS/driver-selected GPU; on hybrid Windows systems select the plugin Python executable under Settings → System → Display → Graphics → High performance for discrete-GPU rendering. Export speed also depends on scene rendering and CPU frame composition; hardware encoding alone does not guarantee a faster complete export.
- Browser `view.json` uses `schema_version: 1`; units, transforms and shared mesh/frame fields are documented in [the exporter](automation/flex3d/sim/view_scene.py). Scene size and frame/geometry counts vary with the protocol.
- `node scripts/verify-setup.mjs` verifies the core runtime. Vision and external VLM services are optional and off by default.
- Flex modules drawn and checked: Heater-Shaker, Temperature Module GEN2, Magnetic Block, Thermocycler GEN2 (lid open/closed), Absorbance Plate Reader, and schema-2 labware stacked on adapters or modules (positions follow the Opentrons engine's stacking offsets). Tube racks use definition-based tube profiles (24-place EP and mixed 15/50 mL racks); rack supports are illustrative. Waste-chute drop locations are supported. Flex Stacker and off-deck moves are not drawn.

## Lightweight downloads

One `labscriptai-ot-<version>.zip` works across all three clients. It includes the 52-tool MCP server, skills, protocol library and detailed Flex module models and the required OT-2 runtime assets, used automatically by the 3D preview. Dependencies install once in a shared user directory and are reused across matching updates; training weights, tests, developer notes, Blender sources and duplicate model exports stay out of the download.

No separate model download is needed. Enable deck vision only after following [its setup guide](docs/deck-vision.md).

## Citation

Use of this plugin or substantial derived work requires citation of the LabscriptAI bioRxiv preprint:

```bibtex
@article{gao2025labscriptai,
  title = {Autonomous Liquid-handling Robotics Scripting for Accessible and Responsible Protein Engineering},
  author = {Gao, Yuan and Luo, Yizhou and Li, Wenzhuo and Lan, Yunquan and Jiang, Han and Chen, Yongcan and Yi, Xiao and Li, Boyang and Alinejad-Rokny, Hamid and Wang, Teng and Fu, Lihao and Yang, Min and Si, Tong},
  year = {2025},
  doi = {10.1101/2025.09.30.679666},
  publisher = {bioRxiv}
}
```

Paper: https://doi.org/10.1101/2025.09.30.679666

## License

LabscriptAI Research Citation License v1.0 — not MIT. Citation is mandatory for public use. Commercial use requires written permission from `gaoyuanbio@qq.com`. See [LICENSE](LICENSE).

Release packaging: [publishing guide](https://github.com/KRATSZ/labscriptai-ot/blob/main/PUBLISHING.md)

### Host integration

Hosts call the public MCP tools `simulate_protocol`, then `protocol_artifacts` with its `analysis_path`. Artifact API v1 returns the plugin version, analysis SHA-256, and independent `animation` / `setup` document statuses. Ready documents include local `path`, `mime`, `bytes`, and `sha256`; copy only verified artifacts into an authenticated host cache. Animation HTML requires scripts in an opaque-origin sandbox; setup HTML needs no scripts or other sandbox permissions. The `attachments` list supplies bounded PNG/CSV/JSON files with name/path/mime/bytes/sha256 for host-owned authenticated downloads. Both documents are self-contained. Hosts pin a plugin release/checksum and update through compatibility-tested upgrade PRs; they do not import renderer internals or copy plugin source. `release-manifest.json` declares `artifact_api` for compatible release selection.
