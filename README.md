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
- Live robot actions are **opt-in**; simulation is the gate before unattended live use
- Glossary: [docs/GLOSSARY.md](docs/GLOSSARY.md) · Workflows: [policy/workflows.md](policy/workflows.md)

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
