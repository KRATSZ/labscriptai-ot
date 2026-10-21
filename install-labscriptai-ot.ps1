#Requires -Version 5.1
$ErrorActionPreference = "Stop"
$PluginRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$env:OPENTRONS_PLUGIN_ROOT = $PluginRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "Install Node.js 18+ (including npm) from https://nodejs.org/, then rerun this installer."
}
node -e 'if (Number(process.versions.node.split(".")[0]) < 18) { console.error("Node.js 18+ is required."); process.exit(1); }'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

node (Join-Path $PluginRoot "scripts\install-runtime.mjs")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

node (Join-Path $PluginRoot "scripts\verify-setup.mjs")
exit $LASTEXITCODE
