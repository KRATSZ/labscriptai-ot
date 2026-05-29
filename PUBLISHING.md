# Publishing LabscriptAI OT

Author: `gaoyuan`

This plugin is packaged as one bundle with MCP, skills, safety policy, and the curated protocol library.

Target public repository: `https://github.com/KRATSZ/labscriptai-ot`

## Build Release Archives

From the repository root:

```bash
python3 scripts/build_curated_library.py --limit 40
python3 scripts/package_labscriptai_ot.py
```

The output goes to `dist/labscriptai-ot/`:

- `labscriptai-ot-0.1.0-cursor.zip`
- `labscriptai-ot-0.1.0-claude-code.zip`
- `labscriptai-ot-0.1.0-codex.zip`
- `release-manifest.json`

The three archives contain the same single plugin. They are named separately so each platform can receive the matching artifact.

## Cursor

Use these files:

- `.cursor-plugin/plugin.json`
- `.cursor/mcp.json`
- `.cursor/rules/labscriptai-ot.mdc`
- `mcp.json`

Practical install path:

1. Unzip the Cursor archive into the target repo or plugin directory.
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
