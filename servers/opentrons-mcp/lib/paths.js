import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MCP_ROOT = path.resolve(__dirname, "..");
const DEV_REPO_ROOT = path.resolve(MCP_ROOT, "../..");

function firstEnv(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value && String(value).trim()) {
      return String(value).trim();
    }
  }
  return null;
}

export function resolvePluginRoot() {
  const configured = firstEnv("OPENTRONS_PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT", "CURSOR_PLUGIN_ROOT");
  if (configured) {
    const resolved = path.resolve(configured);
    // A launcher may hand us a symlink path (e.g. /tmp on macOS is
    // /private/tmp). Prefer the real location so PLUGIN_ROOT-derived paths
    // match __filename-based paths (SCRIPTS_DIR, vendor, data dirs).
    try {
      return fs.realpathSync(resolved);
    } catch {
      return resolved;
    }
  }

  const parent = path.basename(path.dirname(MCP_ROOT));
  if (parent === "servers") {
    return path.resolve(MCP_ROOT, "../..");
  }

  return DEV_REPO_ROOT;
}

export const PLUGIN_ROOT = resolvePluginRoot();
export const SCRIPTS_DIR = path.join(MCP_ROOT, "scripts");
export const DATA_DIR = firstEnv("PLUGIN_DATA", "OPENTRONS_PLUGIN_DATA")
  ? path.resolve(firstEnv("PLUGIN_DATA", "OPENTRONS_PLUGIN_DATA"))
  : path.join(PLUGIN_ROOT, ".plugin-data");
export const ARTIFACTS_DIR = path.join(DATA_DIR, "artifacts");
export const SESSION_STATE_DIR = process.env.OPENTRONS_SESSION_STATE_DIR
  ? path.resolve(process.env.OPENTRONS_SESSION_STATE_DIR)
  : path.join(DATA_DIR, "session-state");
export const RESULT_LOG_DIR = process.env.OPENTRONS_RESULT_LOG_DIR
  ? path.resolve(process.env.OPENTRONS_RESULT_LOG_DIR)
  : path.join(DATA_DIR, "result-logs");
export const BUNDLED_LIBRARY_DIR = path.join(PLUGIN_ROOT, "bundled-library");

export function resolvePythonCandidates(preferredPython = null) {
  const candidates = [
    preferredPython,
    process.env.OPENTRONS_PYTHON,
    path.join(PLUGIN_ROOT, ".venv/bin/python"),
    path.join(DEV_REPO_ROOT, ".venv/bin/python"),
    "python3",
    "python",
  ];

  return [...new Set(candidates.filter(Boolean))].filter((candidate) => {
    const bare = !path.isAbsolute(candidate) && !candidate.includes(path.sep);
    return bare || fs.existsSync(candidate);
  });
}

export function firstExistingPath(paths) {
  return paths.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}
