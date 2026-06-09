#!/usr/bin/env node
/**
 * Post-install verification for LabscriptAI OT.
 * Usage: node scripts/verify-setup.mjs
 * Env: OPENTRONS_PLUGIN_ROOT (optional), OPENTRONS_PYTHON (optional)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { execSync, spawnSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(process.env.OPENTRONS_PLUGIN_ROOT || path.join(__dirname, ".."));
const MCP_ROOT = path.join(PLUGIN_ROOT, "servers/opentrons-mcp");

const checks = [];
let failCount = 0;
let warnCount = 0;

function pass(name, detail) {
  checks.push({ name, status: "pass", detail });
}

function fail(name, detail, fix) {
  checks.push({ name, status: "fail", detail, fix });
  failCount += 1;
}

function warn(name, detail, fix) {
  checks.push({ name, status: "warn", detail, fix });
  warnCount += 1;
}

function checkNode() {
  const version = process.version;
  const major = Number.parseInt(version.slice(1), 10);
  if (major >= 18) {
    pass("Node.js", `${version} (>= 18 required)`);
  } else {
    fail("Node.js", `${version} is too old`, "Install Node.js 18 or newer from https://nodejs.org/");
  }
}

function checkMcpDependencies() {
  const pkgJson = path.join(MCP_ROOT, "package.json");
  const nodeModules = path.join(MCP_ROOT, "node_modules", "@modelcontextprotocol", "sdk");

  if (!fs.existsSync(pkgJson)) {
    fail("MCP package.json", `Missing ${pkgJson}`, "Clone the full repository.");
    return;
  }

  if (!fs.existsSync(nodeModules)) {
    fail(
      "MCP npm dependencies",
      "node_modules not found in servers/opentrons-mcp",
      "Run: bash install-labscriptai-ot.sh  OR  cd servers/opentrons-mcp && npm install"
    );
    return;
  }

  pass("MCP npm dependencies", "node_modules present");
}

function checkPluginPaths() {
  const required = [
    ["servers/opentrons-mcp/index.js", "MCP server entry"],
    ["skills/opentrons-experiment-run/SKILL.md", "experiment-run skill"],
    ["policy/workflows.md", "workflow policy"],
    ["bundled-library", "bundled protocol library"],
  ];

  for (const [rel, label] of required) {
    const full = path.join(PLUGIN_ROOT, rel);
    if (fs.existsSync(full)) {
      pass(`Path: ${label}`, rel);
    } else {
      fail(`Path: ${label}`, `Missing ${rel}`, `Ensure OPENTRONS_PLUGIN_ROOT=${PLUGIN_ROOT} points at the plugin clone.`);
    }
  }
}

function checkPython() {
  const candidates = [
    process.env.OPENTRONS_PYTHON,
    path.join(PLUGIN_ROOT, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"),
    "python3",
    "python",
  ].filter(Boolean);

  let found = null;
  for (const candidate of candidates) {
    if (candidate.includes(path.sep) && !fs.existsSync(candidate)) continue;
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 10000 });
    if (result.status === 0) {
      found = { exe: candidate, version: (result.stdout || result.stderr || "").trim() };
      break;
    }
  }

  if (!found) {
    warn(
      "Python",
      "No working Python interpreter found",
      "Install Python 3.10+ and set OPENTRONS_PYTHON, or create .venv with Opentrons simulation deps (uv sync --extra protocol)."
    );
    return null;
  }

  pass("Python", `${found.exe} — ${found.version}`);

  const otCheck = spawnSync(
    found.exe,
    ["-c", "import opentrons; print(opentrons.__version__)"],
    { encoding: "utf8", timeout: 15000 }
  );

  if (otCheck.status === 0) {
    pass("Opentrons package", `opentrons ${(otCheck.stdout || "").trim()}`);
  } else {
    warn(
      "Opentrons package",
      "opentrons not importable in detected Python",
      "Install simulation deps: uv venv .venv && uv sync --extra protocol  (then set OPENTRONS_PYTHON)"
    );
  }

  return found.exe;
}

async function checkHealth(pythonExe) {
  process.env.OPENTRONS_PLUGIN_ROOT = PLUGIN_ROOT;
  if (pythonExe && !process.env.OPENTRONS_PYTHON) {
    process.env.OPENTRONS_PYTHON = pythonExe;
  }

  try {
    const healthUrl = pathToFileURL(path.join(MCP_ROOT, "lib", "health-check.js")).href;
    const mod = await import(healthUrl);
    const report = mod.buildHealthCheck({ python_executable: pythonExe || undefined });

    if (report.mcp_server?.status === "ok") {
      pass("health_check: MCP server", "ok");
    } else {
      fail("health_check: MCP server", JSON.stringify(report.mcp_server), "Reinstall MCP dependencies.");
    }

    const venv = report.venv || {};
    if (venv.status === "ok" && venv.opentrons && venv.opentrons !== "not_installed") {
      pass("health_check: venv", `Python ${venv.python}, opentrons ${venv.opentrons}`);
    } else if (venv.status === "ok") {
      warn("health_check: venv", `Python ok but opentrons=${venv.opentrons}`, venv.opentrons_hint || venv.hint || "Install opentrons in your Python env.");
    } else {
      warn("health_check: venv", `status=${venv.status}`, venv.hint || "Configure OPENTRONS_PYTHON or create .venv.");
    }
  } catch (err) {
    fail("health_check", err.message, "Run npm install in servers/opentrons-mcp and retry.");
  }
}

function printReport() {
  const icons = { pass: "✓", fail: "✗", warn: "!" };
  console.log("");
  console.log("LabscriptAI OT setup verification");
  console.log(`Plugin root: ${PLUGIN_ROOT}`);
  console.log("─".repeat(60));

  for (const c of checks) {
    const icon = icons[c.status];
    console.log(`[${icon}] ${c.name}`);
    if (c.detail) console.log(`    ${c.detail}`);
    if (c.fix) console.log(`    Fix: ${c.fix}`);
  }

  console.log("─".repeat(60));
  const passed = checks.filter((c) => c.status === "pass").length;
  console.log(`Result: ${passed} passed, ${warnCount} warning(s), ${failCount} failure(s)`);

  if (failCount === 0 && warnCount === 0) {
    console.log("\nAll checks passed. See docs/GETTING_STARTED.md for next steps.");
  } else if (failCount === 0) {
    console.log("\nSetup is usable; resolve warnings before live robot work.");
    console.log("Next: docs/GETTING_STARTED.md");
  } else {
    console.log("\nFix failures above, then re-run: node scripts/verify-setup.mjs");
    console.log("Help: docs/runbooks/mcp-wont-start.md");
  }
  console.log("");
}

async function main() {
  checkNode();
  checkMcpDependencies();
  checkPluginPaths();
  const pythonExe = checkPython();
  await checkHealth(pythonExe);
  printReport();
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
