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
const EXPECTED_RUNTIME_BUILD = "liquid-source-map-v2";
const REQUIRED_RUNTIME_TOOLS = [
  "health_check",
  "runtime_recovery_self_test",
  "runtime_recovery_monitor",
  "safe_next_action",
  "restart_review",
  "validate_virtual_lab_state_steps",
  "list_recovery_playbooks",
  "live_liquid_recovery_gate",
  "robot_status",
  "module_status",
  "is_home_safe",
  "experiment_history",
  "record_liquid_source_map",
  "get_liquid_source_map",
  "summarize_liquid_source_map",
  "plan_liquid_source_substitution",
  "generate_liquid_source_substitution_protocol",
  "prepare_liquid_source_substitution_recovery",
];

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

function readJsonFile(relPath) {
  const fullPath = path.join(PLUGIN_ROOT, relPath);
  try {
    return JSON.parse(fs.readFileSync(fullPath, "utf8"));
  } catch (err) {
    fail(`Manifest: ${relPath}`, err.message, `Fix JSON syntax in ${relPath}.`);
    return null;
  }
}

function readTextFile(relPath) {
  const fullPath = path.join(PLUGIN_ROOT, relPath);
  try {
    return fs.readFileSync(fullPath, "utf8");
  } catch (err) {
    fail(`Manifest: ${relPath}`, err.message, `Ensure ${relPath} exists and is readable.`);
    return null;
  }
}

function extractTomlString(text, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`^${escapedKey}\\s*=\\s*"([^"]*)"`, "m"));
  return match ? match[1] : null;
}

function extractTomlArrayFirstString(text, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`^${escapedKey}\\s*=\\s*\\[\\s*"([^"]*)"`, "m"));
  return match ? match[1] : null;
}

function checkMcpManifestPaths() {
  const expectedIndex = "${PLUGIN_ROOT}/servers/opentrons-mcp/index.js";
  const expectedRoot = "${PLUGIN_ROOT}";
  const expectedLibrary = "${PLUGIN_ROOT}/bundled-library";
  const expectedAbsoluteIndex = path.join(PLUGIN_ROOT, "servers/opentrons-mcp/index.js");
  const expectedAbsoluteLibrary = path.join(PLUGIN_ROOT, "bundled-library");
  const expectedAbsoluteData = path.join(PLUGIN_ROOT, ".plugin-data");

  const codexMcp = readJsonFile(".mcp.json");
  const codexServer = codexMcp?.mcpServers?.["opentrons-lab"];
  if (
    codexServer?.args?.[0] === expectedIndex &&
    codexServer?.env?.OPENTRONS_PLUGIN_ROOT === expectedRoot &&
    codexServer?.env?.OPENTRONS_PROTOCOL_LIBRARY_PATH === expectedLibrary
  ) {
    pass("Manifest: Codex MCP paths", ".mcp.json uses ${PLUGIN_ROOT}");
  } else {
    fail(
      "Manifest: Codex MCP paths",
      JSON.stringify({
        args: codexServer?.args || null,
        OPENTRONS_PLUGIN_ROOT: codexServer?.env?.OPENTRONS_PLUGIN_ROOT || null,
        OPENTRONS_PROTOCOL_LIBRARY_PATH: codexServer?.env?.OPENTRONS_PROTOCOL_LIBRARY_PATH || null,
      }),
      "Use ${PLUGIN_ROOT} in .mcp.json so installed clients load this plugin root instead of a relative working directory."
    );
  }

  const legacyServer = readJsonFile("server.json");
  if (
    legacyServer?.args?.[0] === expectedIndex &&
    legacyServer?.env?.OPENTRONS_PLUGIN_ROOT === expectedRoot &&
    legacyServer?.env?.OPENTRONS_PROTOCOL_LIBRARY_PATH === expectedLibrary
  ) {
    pass("Manifest: server.json paths", "server.json uses ${PLUGIN_ROOT}");
  } else {
    fail(
      "Manifest: server.json paths",
      JSON.stringify({
        args: legacyServer?.args || null,
        OPENTRONS_PLUGIN_ROOT: legacyServer?.env?.OPENTRONS_PLUGIN_ROOT || null,
        OPENTRONS_PROTOCOL_LIBRARY_PATH: legacyServer?.env?.OPENTRONS_PROTOCOL_LIBRARY_PATH || null,
      }),
      "Use ${PLUGIN_ROOT} in server.json for clients that read the legacy single-server manifest."
    );
  }

  const codexLocalConfig = readTextFile(".codex/config.toml");
  if (codexLocalConfig) {
    const args0 = extractTomlArrayFirstString(codexLocalConfig, "args");
    const configuredRoot = extractTomlString(codexLocalConfig, "OPENTRONS_PLUGIN_ROOT");
    const configuredLibrary = extractTomlString(codexLocalConfig, "OPENTRONS_PROTOCOL_LIBRARY_PATH");
    const configuredData = extractTomlString(codexLocalConfig, "PLUGIN_DATA");
    if (
      args0 === expectedAbsoluteIndex &&
      configuredRoot === PLUGIN_ROOT &&
      configuredLibrary === expectedAbsoluteLibrary &&
      configuredData === expectedAbsoluteData
    ) {
      pass("Manifest: Codex local config paths", ".codex/config.toml uses absolute plugin root");
    } else {
      fail(
        "Manifest: Codex local config paths",
        JSON.stringify({
          args: args0,
          OPENTRONS_PLUGIN_ROOT: configuredRoot,
          OPENTRONS_PROTOCOL_LIBRARY_PATH: configuredLibrary,
          PLUGIN_DATA: configuredData,
        }),
        "Use absolute paths in .codex/config.toml; relative paths can keep Codex running a stale MCP process after edits."
      );
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

    const runtimeBuild = report.mcp_server?.capabilities?.runtime_build || null;
    if (runtimeBuild === EXPECTED_RUNTIME_BUILD) {
      pass("health_check: runtime capabilities", runtimeBuild);
    } else {
      fail(
        "health_check: runtime capabilities",
        `runtime_build=${runtimeBuild || "missing"}`,
        `Reload the MCP plugin/server and ensure it loads this worktree. Expected runtime_build=${EXPECTED_RUNTIME_BUILD}.`
      );
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

async function checkRuntimeRecoverySelfTest() {
  process.env.OPENTRONS_PLUGIN_ROOT = PLUGIN_ROOT;

  try {
    const serverUrl = pathToFileURL(path.join(MCP_ROOT, "index.js")).href;
    const mod = await import(serverUrl);
    const missingTools = REQUIRED_RUNTIME_TOOLS.filter(
      name => typeof mod.TOOL_HANDLERS?.[name] !== "function",
    );
    if (missingTools.length === 0) {
      pass("runtime MCP tools", `${REQUIRED_RUNTIME_TOOLS.length} required tools available`);
    } else {
      fail(
        "runtime MCP tools",
        `missing=${missingTools.join(", ")}`,
        "Reload this worktree and ensure the MCP client/server exposes the current runtime recovery tool set."
      );
      return;
    }

    const handler = mod.TOOL_HANDLERS?.runtime_recovery_self_test;

    if (typeof handler !== "function") {
      fail(
        "runtime_recovery_self_test",
        "tool handler is missing",
        "Reload this worktree and ensure servers/opentrons-mcp/index.js exports the current TOOL_HANDLERS."
      );
      return;
    }

    const result = await handler({});
    const data = result?.data || {};
    if (data.status !== "pass") {
      fail(
        "runtime_recovery_self_test",
        `status=${data.status || "missing"}`,
        `Expected no-motion recovery self-test to pass. Failed checks: ${JSON.stringify(data.failed_checks || [])}`
      );
      return;
    }

    const action = data.action_summary?.do_what || null;
    const thenResume = data.action_summary?.then_resume;
    const sourceMapKey = data.action_summary?.params?.source_map_key || null;
    const expectedPresentCase = data.expected_present_case || {};
    const expectedPresentAction = expectedPresentCase.action_summary?.do_what || null;
    const expectedPresentThenResume = expectedPresentCase.action_summary?.then_resume;
    const expectedPresentSourceMapKey = expectedPresentCase.action_summary?.params?.source_map_key || null;
    const expectedPresentExpectedPresence =
      expectedPresentCase.action_summary?.params?.source_map_expected_presence;
    const expectedPresentObservedPresence =
      expectedPresentCase.action_summary?.params?.observed_liquid_presence;
    if (
      data.runtime_build !== EXPECTED_RUNTIME_BUILD ||
      data.classification?.error_category !== "INSUFFICIENT_VOLUME" ||
      action !== "manual_only" ||
      thenResume !== false ||
      sourceMapKey !== "D3.A12" ||
      expectedPresentAction !== "manual_only" ||
      expectedPresentThenResume !== false ||
      expectedPresentSourceMapKey !== "D3.A1" ||
      expectedPresentExpectedPresence !== true ||
      expectedPresentObservedPresence !== false
    ) {
      fail(
        "runtime_recovery_self_test",
        `runtime_build=${data.runtime_build || "missing"}, error_category=${data.classification?.error_category || "missing"}, action=${action || "missing"}, then_resume=${String(thenResume)}, source_map_key=${sourceMapKey || "missing"}, expected_present_action=${expectedPresentAction || "missing"}, expected_present_source_map_key=${expectedPresentSourceMapKey || "missing"}`,
        "Expected empty-source and expected-present liquid probe failures to stay manual-only with source-map context."
      );
      return;
    }

    pass(
      "runtime_recovery_self_test",
      `${data.runtime_build}; liquidNotFound -> INSUFFICIENT_VOLUME; manual_only; source_map_key=${sourceMapKey}; expected_present_source_map_key=${expectedPresentSourceMapKey}`
    );
  } catch (err) {
    fail("runtime_recovery_self_test", err.message, "Run npm install in servers/opentrons-mcp and retry.");
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
  checkMcpManifestPaths();
  const pythonExe = checkPython();
  await checkHealth(pythonExe);
  await checkRuntimeRecoverySelfTest();
  printReport();
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
