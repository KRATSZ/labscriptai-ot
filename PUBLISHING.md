# Publishing LabscriptAI OT

Author: `gaoyuan`

This plugin is packaged as one bundle with MCP, skills, safety policy, and the curated protocol library.

Target public repository: `https://github.com/KRATSZ/labscriptai-ot`

## License Rule

This release is not MIT licensed. It uses the LabscriptAI Research Citation License v1.0. Keep the `LICENSE` and `CITATION.cff` files in every archive, and do not relabel the plugin as MIT in Cursor, Claude Code, Codex, npm, or marketplace metadata.

Public use, derivative work, publications, reports, benchmarks, demos, repositories, and AI tool/plugin integrations must cite the LabscriptAI bioRxiv preprint:

```text
Gao, Yuan et al. Autonomous Liquid-handling Robotics Scripting for Accessible and Responsible Protein Engineering. bioRxiv, 2025. DOI: 10.1101/2025.09.30.679666
```

## Build Release Archives

From the repository root:

```bash
python3 scripts/package_labscriptai_ot.py
```

The output goes to `dist/`:

- `labscriptai-ot-0.1.1.zip` — one runtime package for Cursor, Claude Code and Codex
- `labscriptai-ot-flex3d-details-0.1.1.zip` — optional detailed module meshes
- `release-manifest.json` — version, sizes, file counts and SHA-256 hashes

The runtime package excludes development tests, QA notes, local state, secrets, Python/Node environments, vision training weights and model authoring sources. The detail pack includes only the OBJ meshes required at runtime, their manifest/provenance, and license/citation files. Extract either ZIP into the same parent directory; both use `labscriptai-ot/` as their root. Basic module models work without the detail pack.

Before publishing:

```bash
node scripts/lint-manifests.mjs
npm --prefix servers/opentrons-mcp test
PYTHONPATH=automation/flex3d .venv/bin/python -m unittest discover -s automation/flex3d/tests
python3 -m unittest discover -s scripts -p 'test_package_labscriptai_ot.py'
```

Validate a fresh extracted runtime package using its installer, MCP handshake, simulation, LogicPass and 3D preview before attaching the ZIPs to a release. Keep release archives out of Git.

## Cursor

Use these files:

- `.cursor-plugin/plugin.json`
- `.cursor/mcp.json`
- `.cursor/rules/labscriptai-ot.mdc`
- `mcp.json`

Practical install path:

1. Unzip the runtime archive into the target repo or plugin directory.
2. Run `bash labscriptai-ot/install-labscriptai-ot.sh`.
3. If using project config, copy `labscriptai-ot/.cursor/mcp.json` and `labscriptai-ot/.cursor/rules/` into the consuming project.

Marketplace note: Cursor's extension distribution is still closer to VS Code extension publishing for many use cases. Keep this bundle as the source package and adapt marketplace metadata if Cursor requires a VSIX wrapper.

## Claude Code

Use these files:

- `.claude-plugin/plugin.json`
- `.claude-plugin/marketplace.json`
- `.claude-plugin/mcp.json`
- `skills/`

For a public Claude Code marketplace:

1. Put this plugin at the root of a release repository, or keep it in a marketplace repository and set the marketplace entry `source` to its subdirectory.
2. Ensure `.claude-plugin/marketplace.json` is visible at the marketplace root.
3. Install/test with Claude Code using the local marketplace path before tagging.

Recommended public install text:

```text
/plugin marketplace add KRATSZ/labscriptai-ot
/plugin install labscriptai-ot@labscriptai-ot-marketplace
```

## Codex

Use these files:

- `.codex-plugin/plugin.json`
- `.codex-plugin/marketplace.json`
- `.mcp.json`
- `skills/`

For Codex distribution:

1. Publish the archive or repository as a local/curated plugin source.
2. Add a marketplace entry that points to the plugin root.
3. Install locally and verify `opentrons-lab` MCP starts before offering it broadly.

## Safety Boundary

Live robot execution remains opt-in. Do not ship a release that enables live probing by default. Vision is optional and requires explicit local weights.
