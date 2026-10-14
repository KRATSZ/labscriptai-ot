# LabscriptAI OT

Single plugin bundle for Cursor, Claude Code, and Codex-style agents — Opentrons protocol authoring, local simulation, and safe live runtime assistance.

Author: `gaoyuan` · Contact: `gaoyuanbio@qq.com` · Repository: https://github.com/KRATSZ/labscriptai-ot

## Install

```bash
git clone https://github.com/KRATSZ/labscriptai-ot.git
cd labscriptai-ot
bash install-labscriptai-ot.sh          # macOS / Linux
# .\install-labscriptai-ot.ps1          # Windows PowerShell
node scripts/verify-setup.mjs
```

Then enable the plugin in your client. **Start here:** [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md) (Claude Code, Codex, and Cursor setup, first commands, troubleshooting).

## What's included

- MCP server (`servers/opentrons-mcp/`), seven agent skills, safety policy, curated protocol library
- `automation/` — custom labware (e.g. third-party tip racks) and on-robot verification helpers; see [docs/custom-labware-guide.md](docs/custom-labware-guide.md)
- `automation/flex3d/` — optional Flex 3D protocol preview (MuJoCo physics checks + Three.js viewer); see [Flex 3D preview](#flex-3d-preview-optional)
- Live robot actions are **opt-in**; simulation **and LogicPass** gate unattended live use — see [docs/GETTING_STARTED.md#logicpass-gate](docs/GETTING_STARTED.md#logicpass-gate). Simulation runs on `opentrons>=9,<10` (pinned in `pyproject.toml`, install with `uv sync`)
- Glossary: [docs/GLOSSARY.md](docs/GLOSSARY.md) · Workflows: [policy/workflows.md](policy/workflows.md)

## Flex 3D preview (optional)

MuJoCo-based 3D preflight and an interactive browser viewer for **Flex protocols** (OT-2 is refused). Optional feature — install mujoco to enable it:

```bash
.venv/bin/pip install mujoco pillow
```

- MCP tool `flex3d_preflight_check` — runs geometry / liquid / targets / clearance checks on an analyze JSON or protocol `.py`; failing checks carry `command_index` aligned with LogicPass `step_index`. Degrades gracefully when mujoco is missing. Checks only — never renders or exports a video or image file.
- MCP tool `flex3d_open_viewer` — starts the interactive viewer and returns `http://127.0.0.1:8791/viewer.html?key=example` (two orbit views, step list, drag to rotate/zoom). This is the 3D preview path: online only, no video rendering and no file export.
- CLI: `python automation/flex3d/scripts/render_protocol_3d.py <analysis.json|protocol.py> [--out DIR]` prints one JSON object (checks only, no video).
- CLI: `python -m sim.play_protocol <analysis.json|protocol.py>` prints checks + stills; add `--video` to also write an MP4 (off by default), or `--view` for the MuJoCo window.
- `node scripts/verify-setup.mjs` reports mujoco availability as a warning, never a failure.

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

Release packaging: [PUBLISHING.md](PUBLISHING.md)
