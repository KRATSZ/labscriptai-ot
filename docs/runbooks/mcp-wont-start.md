# MCP won't start — runbook

When the `opentrons-lab` MCP server fails to connect or tools do not appear in Claude Code, Codex, or Cursor.

## Quick checks

Run from the plugin repository root:

```bash
node scripts/verify-setup.mjs
```

Fix any **fail** items before continuing.

## Symptom → cause → fix

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `Cannot find module` / Node error | Dependencies not installed | `cd servers/opentrons-mcp && npm install` |
| Wrong paths in tool errors | `OPENTRONS_PLUGIN_ROOT` unset or wrong | Set absolute path to clone root in MCP env |
| Cursor: server gray / disconnected | Bad path in `.cursor/mcp.json` | Use absolute paths to `index.js` and env vars |
| `ENOENT` on index.js | Typo in args path | Point to `servers/opentrons-mcp/index.js` |
| Node version error | Node &lt; 18 | Upgrade Node.js |
| Server starts then exits | Uncaught import error | Run manually: `node servers/opentrons-mcp/index.js` |
| Tools empty, no error | Client cache | Reload MCP / restart IDE |

## Manual smoke test

```bash
export OPENTRONS_PLUGIN_ROOT="/path/to/labscriptai-ot"
cd servers/opentrons-mcp
node index.js
```

Server should stay running on stdio (Ctrl+C to stop). If it prints a stack trace, fix that first.

## Platform notes

### Cursor

Copy [`.cursor/mcp.json`](../../.cursor/mcp.json) and replace `${workspaceFolder}/plugins/labscriptai-ot` with your actual clone path on **both** `args` and `env` fields.

### Claude Code

Install via marketplace or local plugin source. Confirm `.claude-plugin/mcp.json` is loaded with the plugin.

### Codex

Local plugin path must be the repository root. MCP config: `.mcp.json` at repo root. The MCP server path should use `${PLUGIN_ROOT}/servers/opentrons-mcp/index.js`.

Codex desktop may also read `.codex/config.toml` from the repository. Use absolute paths in that file for `args[0]`, `OPENTRONS_PLUGIN_ROOT`, `OPENTRONS_PROTOCOL_LIBRARY_PATH`, and `PLUGIN_DATA`. If `ps` shows `node servers/opentrons-mcp/index.js` started before your latest edits, restart/reload the Codex MCP process; otherwise the active MCP can keep serving old code even when local `verify-setup` is green.

After reload, `health_check` should report `mcp_server.entrypoint` under the same clone root and `mcp_server.required_runtime_tools.all_present=true`.

## Required environment variables

| Variable | Example |
|----------|---------|
| `OPENTRONS_PLUGIN_ROOT` | `/home/user/labscriptai-ot` or `C:\Users\you\labscriptai-ot` |
| `OPENTRONS_PROTOCOL_LIBRARY_PATH` | `$OPENTRONS_PLUGIN_ROOT/bundled-library` |
| `PLUGIN_DATA` | Optional; defaults to `.plugin-data` under plugin root |

## Still stuck?

1. Re-run installer: `bash install-labscriptai-ot.sh` or `.\install-labscriptai-ot.ps1`
2. Run MCP tests: `cd servers/opentrons-mcp && OPENTRONS_PLUGIN_ROOT=... npm test`
3. Read [GETTING_STARTED.md](../GETTING_STARTED.md) for platform-specific steps

## Related

- [GETTING_STARTED.md](../GETTING_STARTED.md)
- [GLOSSARY.md](../GLOSSARY.md) — `OPENTRONS_PLUGIN_ROOT`, `PLUGIN_DATA`
