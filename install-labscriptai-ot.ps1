#Requires -Version 5.1
$ErrorActionPreference = "Stop"

$PluginRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$McpRoot = Join-Path $PluginRoot "servers\opentrons-mcp"

Push-Location $McpRoot
try {
    npm install
} finally {
    Pop-Location
}

$env:OPENTRONS_PLUGIN_ROOT = $PluginRoot
$VerifyExit = 0
try {
    node (Join-Path $PluginRoot "scripts\verify-setup.mjs")
} catch {
    $VerifyExit = 1
}
if ($LASTEXITCODE -ne 0) { $VerifyExit = $LASTEXITCODE }

$HooksSrc = Join-Path $PluginRoot "hooks"
$InstallHooks = if ($env:LABSCRIPTAI_INSTALL_HOST_HOOKS) { $env:LABSCRIPTAI_INSTALL_HOST_HOOKS } else { "1" }
if ($InstallHooks -eq "1" -and (Test-Path (Join-Path $HooksSrc "claude"))) {
    $HooksLink = Join-Path $PluginRoot "hooks\hooks.json"
    $MonitorsDir = Join-Path $PluginRoot "monitors"
    $MonitorsLink = Join-Path $MonitorsDir "monitors.json"
    $MonitorsTarget = Join-Path $PluginRoot "hooks\claude\monitors.json"

    New-Item -ItemType Directory -Force -Path $MonitorsDir | Out-Null

    if (-not (Test-Path $HooksLink)) {
        $HooksTarget = Join-Path $PluginRoot "hooks\claude\hooks.json"
        try {
            New-Item -ItemType SymbolicLink -Path $HooksLink -Target $HooksTarget -Force | Out-Null
        } catch {
            Copy-Item $HooksTarget $HooksLink -Force
        }
    }

    if (-not (Test-Path $MonitorsLink)) {
        try {
            New-Item -ItemType SymbolicLink -Path $MonitorsLink -Target $MonitorsTarget -Force | Out-Null
        } catch {
            Copy-Item $MonitorsTarget $MonitorsLink -Force
        }
    }
}

Write-Host ""
Write-Host "LabscriptAI OT plugin is installed."
Write-Host ""
Write-Host "Set these variables in your client if it does not inject them:"
Write-Host "  OPENTRONS_PLUGIN_ROOT=$PluginRoot"
Write-Host "  OPENTRONS_PROTOCOL_LIBRARY_PATH=$(Join-Path $PluginRoot 'bundled-library')"
Write-Host ""
Write-Host "Optional writable state directory:"
Write-Host "  PLUGIN_DATA=$(Join-Path $PluginRoot '.plugin-data')"
Write-Host ""
Write-Host "Optional deck vision (lab-trained YOLO):"
Write-Host "  pip install ultralytics opencv-python-headless pillow"
Write-Host "  Weights: vision/models/weights/deck_v2_best.pt"
Write-Host "  Setup: docs/GETTING_STARTED.md#deck-vision-setup"
Write-Host ""

exit $VerifyExit
