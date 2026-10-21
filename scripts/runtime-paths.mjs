import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

export const READY_MARKER = ".labscriptai-ready.json";

const PLACEHOLDER = /\$\{[^}]+\}/;
const clean = (value) => (typeof value === "string" && value.trim() && !PLACEHOLDER.test(value) ? value.trim() : "");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const pathsFor = (platform) => (platform === "win32" ? path.win32 : path.posix);
const absolute = (platform, value) => pathsFor(platform).resolve(value);
const join = (platform, ...parts) => pathsFor(platform).join(...parts);

// MuJoCo on Apple Silicon calls sysctl; desktop clients may omit /usr/sbin.
export function systemPath(value = process.env.PATH || "", platform = process.platform) {
  if (platform !== "darwin") return value;
  const dirs = value.split(":");
  return [...dirs, ...["/usr/bin", "/bin", "/usr/sbin", "/sbin"].filter(dir => !dirs.includes(dir))].join(":");
}

export function dataHome(env = process.env, platform = process.platform, home = os.homedir()) {
  const override = clean(env.LABSCRIPTAI_HOME);
  if (override) return absolute(platform, override);

  if (platform === "darwin") {
    return join(platform, home, "Library", "Application Support", "labscriptai-ot");
  }
  if (platform === "win32") {
    const local = clean(env.LOCALAPPDATA);
    const base = local ? absolute(platform, local) : join(platform, home, "AppData", "Local");
    return join(platform, base, "labscriptai-ot");
  }
  const xdg = clean(env.XDG_DATA_HOME);
  const base = xdg ? absolute(platform, xdg) : join(platform, home, ".local", "share");
  return join(platform, base, "labscriptai-ot");
}

function readRequirementsFingerprint(root) {
  try {
    return hash(fs.readFileSync(path.join(root, "requirements.lock")));
  } catch {
    // A missing lock is a stable state, but never key a cache on the plugin path.
    return hash("missing:requirements.lock");
  }
}

function readNodeFingerprint(root) {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(root, "servers", "opentrons-mcp", "package-lock.json"), "utf8"));
    if (!lock.packages || typeof lock.packages !== "object") return hash("missing:package-lock-packages");
    const packages = {};
    for (const key of Object.keys(lock.packages).filter((key) => key !== "").sort()) {
      packages[key] = lock.packages[key];
    }
    return hash(JSON.stringify(packages));
  } catch {
    return hash("missing:package-lock.json");
  }
}

export function runtimePaths(root, env = process.env) {
  const home = dataHome(env);
  const runtimes = path.join(home, "runtimes");
  const platform = process.platform;
  const arch = process.arch;
  const nodeMajor = process.versions.node.split(".")[0];
  const pythonKey = `python-${platform}-${arch}-${readRequirementsFingerprint(root).slice(0, 20)}`;
  const nodeKey = `node-${platform}-${arch}-node${nodeMajor}-${readNodeFingerprint(root).slice(0, 20)}`;
  const pythonDir = path.join(runtimes, pythonKey);
  const nodeDir = path.join(runtimes, nodeKey);
  const python = path.join(pythonDir, platform === "win32" ? "Scripts" : "bin", platform === "win32" ? "python.exe" : "python");

  return {
    home,
    pythonKey,
    nodeKey,
    pythonDir,
    nodeDir,
    nodeModules: path.join(nodeDir, "node_modules"),
    python,
    stateFile: path.join(home, "runtime-state.json"),
  };
}

export function markerPath(dir) {
  return path.join(dir, READY_MARKER);
}

function atomicWrite(file, data) {
  const dir = path.dirname(file);
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(temp, data, { mode: 0o644 });
    fs.renameSync(temp, file);
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // Best-effort cleanup; the original error is the useful one.
    }
    throw error;
  }
}

export function readReadyMarker(dir) {
  try {
    return JSON.parse(fs.readFileSync(markerPath(dir), "utf8"));
  } catch {
    return null;
  }
}

export function writeReadyMarker(dir, details = {}) {
  const marker = {
    ...details,
    schema: 1,
    ready: true,
    createdAt: new Date().toISOString(),
  };
  atomicWrite(markerPath(dir), `${JSON.stringify(marker)}\n`);
  return marker;
}

function hasReadyMarker(dir, expected) {
  const marker = readReadyMarker(dir);
  if (!marker) return false;
  return marker.ready === true && marker.schema === 1
    && marker.key === expected.key && marker.kind === expected.kind;
}

export function cachedPython(root, env = process.env) {
  const paths = runtimePaths(root, env);
  if (!hasReadyMarker(paths.pythonDir, { kind: "python", key: paths.pythonKey })) return null;
  return fs.existsSync(paths.python) ? paths.python : null;
}

export function cachedNodeModules(root, env = process.env) {
  const paths = runtimePaths(root, env);
  if (!hasReadyMarker(paths.nodeDir, { kind: "node", key: paths.nodeKey })) return null;
  const sdk = path.join(paths.nodeModules, "@modelcontextprotocol", "sdk", "package.json");
  return fs.existsSync(sdk) ? paths.nodeModules : null;
}

export { atomicWrite };
