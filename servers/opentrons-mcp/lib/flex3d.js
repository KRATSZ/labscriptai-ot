import fs from "fs";
import path from "path";
import { spawn } from "child_process";

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

function pollHealth(url, child, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;

  return new Promise(resolve => {
    const attempt = () => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
        resolve({ exited: true });
        return;
      }
      if (Date.now() > deadline) {
        resolve({ exited: false, timedOut: true });
        return;
      }
      fetch(url, { signal: AbortSignal.timeout(1000) })
        .then(async response => {
          const health = response.ok ? await response.json() : null;
          if (health?.service === "labscriptai-flex3d" && health.pid === child.pid) {
            resolve({ healthy: true });
          } else {
            setTimeout(attempt, 300);
          }
        })
        .catch(() => {
          setTimeout(attempt, 300);
        });
    };

    setTimeout(attempt, 300);
  });
}

/**
 * Start automation/flex3d/sim/web_player.py (MuJoCo + Three.js viewer) on
 * 127.0.0.1 and return the browser URL. Requires mujoco in the Python env;
 * reports a degraded result otherwise. The process is left running so the
 * user can open the URL; `pid` is returned so the caller can stop it later.
 *
 * Online preview only — this never renders or exports a video/MP4.
 */
export async function startFlex3dViewer({
  protocolPath = null,
  port = FLEX3D_DEFAULT_PORT,
  preferredPython,
} = {}) {
  if (!protocolPath || !String(protocolPath).trim()) {
    return { ok: false, error: "protocol_required", message: "Provide protocol_path to open a 3D preview." };
  }
  const args = ["-m", "sim.web_player", "--host", "127.0.0.1", "--port", String(port)];
  const hasProtocol = Boolean(protocolPath && String(protocolPath).trim());
  if (hasProtocol) {
    args.push("--protocol", path.resolve(String(protocolPath)));
  }

  return withUsablePython(preferredPython, async python => new Promise((resolve, reject) => {
    const child = spawn(python, args, {
      cwd: FLEX3D_ROOT,
      env: { ...process.env, FLEX3D_EXPORT: FLEX3D_DEFAULT_OUT, PYTHONPATH: FLEX3D_ROOT, PYTHONIOENCODING: "utf-8" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });
    child.on("error", reject);
    child.stdout.resume();

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => {
      stderr += chunk;
    });

    const url = hasProtocol
      ? `http://127.0.0.1:${port}/viewer.html?key=${FLEX3D_EXAMPLE_KEY}`
      : `http://127.0.0.1:${port}/viewer.html`;

    pollHealth(`http://127.0.0.1:${port}/flex3d/health`, child).then(status => {
      if (status.exited) {
        const mujocoMissing = /No module named ["']?mujoco/i.test(stderr);
        resolve({
          ok: false,
          error: mujocoMissing ? "mujoco_missing" : "viewer_start_failed",
          message: mujocoMissing
            ? "mujoco is not installed, so the 3D viewer cannot start. Run `uv sync` in the repo root (mujoco and pillow are pinned in pyproject.toml), or pip install mujoco pillow into the plugin Python env."
            : `web_player failed to start: ${stderr.slice(-2000)}`,
          stderr: stderr.slice(-4000),
        });
        return;
      }
      if (status.timedOut && !status.healthy) {
        child.kill();
        resolve({
          ok: false,
          error: "viewer_start_timeout",
          message: `The 3D viewer did not become ready within 45s: ${url}`,
          stderr: stderr.slice(-4000),
        });
        return;
      }
      resolve({
        ok: true,
        url,
        port,
        pid: child.pid,
        protocol: protocolPath ? path.resolve(String(protocolPath)) : null,
        note: "Open the url in a browser to interact; stop the process with: kill <pid>",
      });
    });
  }));
}

export const FLEX3D_PATHS = { FLEX3D_ROOT, FLEX3D_SCRIPT, FLEX3D_DEFAULT_OUT, FLEX3D_DEFAULT_PORT };
