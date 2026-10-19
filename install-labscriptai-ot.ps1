#Requires -Version 5.1
$ErrorActionPreference = "Stop"
$PluginRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

Push-Location (Join-Path $PluginRoot "servers\opentrons-mcp")
try {
    npm ci --omit=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally { Pop-Location }

node (Join-Path $PluginRoot "scripts\install-runtime.mjs")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$env:OPENTRONS_PLUGIN_ROOT = $PluginRoot
node (Join-Path $PluginRoot "scripts\verify-setup.mjs")
exit $LASTEXITCODE
