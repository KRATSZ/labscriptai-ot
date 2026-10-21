import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { createHash, randomUUID } from "node:crypto";
import { connect } from "node:net";
import { analyzeProtocolOnce } from "./analyze-once.js";

import { DATA_DIR, PLUGIN_ROOT, resolvePythonCandidates } from "./paths.js";

const FLEX3D_ROOT = path.join(PLUGIN_ROOT, "automation", "flex3d");
const FLEX3D_SCRIPT = path.join(FLEX3D_ROOT, "scripts", "render_protocol_3d.py");
const FLEX3D_DEFAULT_OUT = path.join(DATA_DIR, "flex3d");
const FLEX3D_DEFAULT_PORT = 8791;
// web_player.py registers a preloaded protocol under this fixed key
// (EXAMPLE_KEY in automation/flex3d/sim/web_player.py), and viewer.js refuses
// to boot without ?key= — so the URL handed to the user must carry it.
const FLEX3D_EXAMPLE_KEY = "example";

function runCommand(command, args, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: cwd || process.cwd(),
      env: env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      stdout += chunk;
    });
    child.stderr.on("data", chunk => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", code => {
      resolve({ code, stdout, stderr, command });
    });
  });
}

function parseLastJson(text) {
  const lines = String(text || "").split("\n").filter(line => line.trim());
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch (error) {
      // keep scanning backwards; the script prints exactly one JSON object
    }
  }
  return null;
}

async function withUsablePython(preferredPython, runner) {
  const candidates = resolvePythonCandidates(preferredPython);
  let lastError = null;

  for (const candidate of candidates) {
    try {
      return await runner(candidate);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        lastError = error;
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error("No usable Python interpreter found for flex3d.");
}

/**
 * Run automation/flex3d/scripts/render_protocol_3d.py on an opentrons analyze
 * JSON (or a protocol .py). The script always prints one JSON object and exits
 * 0 — including degraded results when mujoco is missing — so this wrapper only
 * has to parse stdout.
 *
 * Checks only. This path deliberately has no video/MP4 option: a 3D request is
 * served by the online viewer (startFlex3dViewer), never by rendering a file.
 */
export async function runFlex3dCheck({
  sourcePath,
  outDir,
  preferredPython,
} = {}) {
  if (!sourcePath || !String(sourcePath).trim()) {
    throw new Error("flex3d_preflight_check requires `source`: path to an opentrons analyze JSON or protocol .py");
  }

  const source = path.resolve(String(sourcePath));
  const out = path.resolve(outDir || FLEX3D_DEFAULT_OUT);
  fs.mkdirSync(out, { recursive: true });

  const args = [FLEX3D_SCRIPT, source];
  args.push("--out", out);

  return withUsablePython(preferredPython, async python => {
    const result = await runCommand(python, args, {
      cwd: FLEX3D_ROOT,
      env: { ...process.env, FLEX3D_EXPORT: out, PYTHONIOENCODING: "utf-8" },
    });

    const parsed = parseLastJson(result.stdout);
    if (!parsed) {
      return {
        ok: false,
        error: "flex3d_invalid_output",
        warnings: [],
        warnings_count: 0,
        message: "render_protocol_3d.py did not print a JSON object.",
        python,
        exit_code: result.code,
        raw_stdout: result.stdout.slice(-4000),
        raw_stderr: result.stderr.slice(-4000),
      };
    }

    return { ...parsed, python, out_dir: out };
  });
}

const queues = new Map();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const ownershipFile = port => path.join(FLEX3D_DEFAULT_OUT, `viewer-${port}.json`);
const failure = (error, message, extra = {}) => ({ ok: false, error, message, ...extra });
const validPort = port => Number.isInteger(port) && port > 0 && port <= 65535;

function readOwnership(port) {
  try { return JSON.parse(fs.readFileSync(ownershipFile(port), "utf8")); } catch { return null; }
}

function saveOwnership(meta) {
  const file = ownershipFile(meta.port);
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(meta), { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

async function health(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/flex3d/health`, { signal: AbortSignal.timeout(1000) });
    return response.ok ? await response.json().catch(() => ({})) : {};
  } catch { return null; }
}

function owned(meta, report) {
  return Boolean(meta?.instance && Number.isInteger(meta.pid) && meta.pid > 0 &&
    report?.service === "labscriptai-flex3d" && report.pid === meta.pid && report.instance === meta.instance);
}

function busy(port, report) {
  return failure("port_in_use", `Port ${port} belongs to another service. Choose a different port; that service was left running.`, { port, pid: report?.pid });
}

function result(meta, key, protocol, reused) {
  return { ok: true, url: `http://127.0.0.1:${meta.port}/viewer.html?key=${key}`,
    port: meta.port, pid: meta.pid, log_path: meta.log_path, protocol, reused,
    note: "Ask to close the 3D preview when finished (flex3d_open_viewer action=close)." };
}

// Serialize this process's calls; the TCP bind and instance identity settle races with other clients.
function withPortLock(port, work) {
  if (!validPort(port)) return Promise.resolve(failure("invalid_port", "Use an integer port from 1 to 65535."));
  const pending = (queues.get(port) || Promise.resolve()).catch(() => {}).then(work);
  queues.set(port, pending);
  return pending.finally(() => { if (queues.get(port) === pending) queues.delete(port); });
}

export async function startFlex3dViewer({ protocolPath, port = FLEX3D_DEFAULT_PORT, preferredPython } = {}) {
  return withPortLock(port, async () => {
    if (!protocolPath || !String(protocolPath).trim()) return failure("protocol_required", "Provide protocol_path to open a 3D preview.");
    try {
      const protocol = path.resolve(String(protocolPath));
      if (!fs.existsSync(protocol)) return failure("protocol_not_found", `Protocol not found: ${protocol}`);
      if (!fs.statSync(protocol).isFile()) return failure("protocol_not_file", `Choose a protocol file: ${protocol}`);
      let source = protocol;
      if (path.extname(source).toLowerCase() === ".py") {
        const analysis = await analyzeProtocolOnce({ protocol_path: source, python_executable: preferredPython });
        if (!analysis.ok) return { ...analysis, status: "failed" };
        source = analysis.analysis_path;
      }
      const body = fs.readFileSync(source);
      let parsed;
      try { parsed = JSON.parse(body.toString("utf8")); } catch {
        return failure("invalid_protocol", "Choose an Opentrons analyze JSON or Python protocol.");
      }
      if (!parsed || !Array.isArray(parsed.commands)) return failure("invalid_protocol", "The analysis must contain a commands list.");
      const hash = createHash("sha256").update(body).digest("hex");
      const meta = readOwnership(port);
      const report = await health(port);
      if (owned(meta, report)) {
        let key = meta.models?.[hash];
        if (!key || !report.models?.includes(key)) {
          const response = await fetch(`http://127.0.0.1:${port}/flex3d/load`, {
            method: "POST", headers: { "Content-Type": "application/json", "X-Flex3d-Instance": meta.instance },
            body, signal: AbortSignal.timeout(45000),
          });
          const loaded = await response.json();
          if (!response.ok || !/^[a-z0-9]{1,32}$/.test(loaded.key || "")) {
            return failure("viewer_load_failed", loaded.message || "The viewer could not load this protocol.", { port, log_path: meta.log_path });
          }
          key = loaded.key;
          const models = Object.fromEntries(Object.entries(meta.models || {}).filter(([, value]) => report.models.includes(value)));
          meta.models = { ...models, [hash]: key };
          saveOwnership(meta);
        }
        return result(meta, key, protocol, true);
      }
      if (report) return busy(port, report);
      if (meta && alive(meta.pid)) return failure("viewer_unverified", "The previous viewer is not responding. It was left running; use another port.", { port });
      fs.rmSync(ownershipFile(port), { force: true });
      fs.mkdirSync(FLEX3D_DEFAULT_OUT, { recursive: true });
      return await withUsablePython(preferredPython, async python => {
        const instance = randomUUID();
        const logPath = path.join(FLEX3D_DEFAULT_OUT, `viewer-${port}-${Date.now()}-${instance.slice(0, 8)}.log`);
        const log = fs.openSync(logPath, "wx", 0o600);
        let child;
        try {
          child = spawn(python, ["-m", "sim.web_player", "--host", "127.0.0.1", "--port", String(port), "--protocol", source], {
            cwd: FLEX3D_ROOT, detached: true, windowsHide: true, stdio: ["ignore", log, log],
            env: { ...process.env, FLEX3D_EXPORT: FLEX3D_DEFAULT_OUT, PYTHONPATH: FLEX3D_ROOT,
              FLEX3D_INSTANCE_ID: instance, PYTHONIOENCODING: "utf-8" },
          });
        } finally { fs.closeSync(log); }
        await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
        const identity = { instance, pid: child.pid, port, log_path: logPath, models: { [hash]: FLEX3D_EXAMPLE_KEY } };
        const deadline = Date.now() + 45000;
        while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
          if (owned(identity, await health(port))) {
            try { saveOwnership(identity); } catch (error) { child.kill(); throw error; }
            child.unref();
            return result(identity, FLEX3D_EXAMPLE_KEY, protocol, false);
          }
          await delay(150);
        }
        const timedOut = child.exitCode === null && child.signalCode === null;
        if (timedOut) child.kill();
        const stderr = fs.readFileSync(logPath, "utf8").slice(-4000);
        const extra = { port, log_path: logPath, stderr };
        if (/Address already in use|EADDRINUSE|Errno (48|98)/i.test(stderr)) return busy(port);
        if (/No module named ["']?mujoco/i.test(stderr)) return failure("mujoco_missing", "Re-run the installer in the loaded plugin folder to enable 3D preview.", extra);
        return failure(timedOut ? "viewer_start_timeout" : "viewer_start_failed",
          timedOut ? "The viewer did not become ready within 45s. See its startup log." : "The viewer could not start. See its startup log.", extra);
      });
    } catch (error) {
      return failure("viewer_start_failed", error.message);
    }
  });
}

function portReleased(port) {
  return new Promise(resolve => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = released => { socket.destroy(); resolve(released); };
    socket.once("connect", () => finish(false));
    socket.once("error", error => finish(error.code === "ECONNREFUSED"));
    socket.setTimeout(500, () => finish(false));
  });
}

export async function stopFlex3dViewer({ port = FLEX3D_DEFAULT_PORT } = {}) {
  return withPortLock(port, async () => {
    try {
      const meta = readOwnership(port);
      const report = await health(port);
      if (!owned(meta, report)) {
        if (report) return busy(port, report);
        if (meta && alive(meta.pid)) return failure("viewer_unverified", "The recorded viewer did not answer. It was not stopped.", { port });
        fs.rmSync(ownershipFile(port), { force: true });
        return { ok: true, port, stopped: false, already_stopped: true };
      }
      // Ask this exact server instance to exit. Never signal a PID supplied by metadata.
      const response = await fetch(`http://127.0.0.1:${port}/flex3d/close`, {
        method: "POST", headers: { "X-Flex3d-Instance": meta.instance }, signal: AbortSignal.timeout(5000),
      });
      const acknowledgement = await response.json();
      if (!response.ok || !acknowledgement.closing || acknowledgement.instance !== meta.instance) {
        return failure("viewer_unverified", "The viewer did not acknowledge this instance's close request; its record was retained.", { port });
      }
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        if (!alive(meta.pid) || await portReleased(port)) {
          const current = readOwnership(port);
          if (current?.instance === meta.instance) fs.rmSync(ownershipFile(port), { force: true });
          return { ok: true, port, pid: meta.pid, stopped: true, already_stopped: false };
        }
        await delay(100);
      }
      return failure("viewer_stop_failed", "The viewer has not exited or released its port; its record was retained. Try closing again.", { port });
    } catch (error) { return failure("viewer_stop_failed", error.message, { port }); }
  });
}

export const FLEX3D_PATHS = { FLEX3D_ROOT, FLEX3D_SCRIPT, FLEX3D_DEFAULT_OUT, FLEX3D_DEFAULT_PORT };
