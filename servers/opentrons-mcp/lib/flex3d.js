import fs from "fs";
import path from "path";
import { spawn } from "child_process";

import { PLUGIN_ROOT, resolvePythonCandidates } from "./paths.js";

const FLEX3D_ROOT = path.join(PLUGIN_ROOT, "automation", "flex3d");
const FLEX3D_SCRIPT = path.join(FLEX3D_ROOT, "scripts", "render_protocol_3d.py");
const FLEX3D_DEFAULT_OUT = path.join(PLUGIN_ROOT, ".plugin-data", "flex3d");
const FLEX3D_DEFAULT_PORT = 8791;

function runCommand(command, args, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: cwd || process.cwd(),
      env: env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", chunk => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", chunk => {
      stderr += chunk.toString();
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
 */
export async function runFlex3dCheck({
  sourcePath,
  outDir,
  preferredPython,
  video = false,
} = {}) {
  if (!sourcePath || !String(sourcePath).trim()) {
    throw new Error("flex3d_preflight_check requires `source`: path to an opentrons analyze JSON or protocol .py");
  }

  const source = path.resolve(String(sourcePath));
  const out = path.resolve(outDir || FLEX3D_DEFAULT_OUT);
  fs.mkdirSync(out, { recursive: true });

  const args = [FLEX3D_SCRIPT, source];
  if (video) {
    args.push("--video");
  }
  args.push("--out", out);

  return withUsablePython(preferredPython, async python => {
    const result = await runCommand(python, args, {
      cwd: FLEX3D_ROOT,
      env: { ...process.env, FLEX3D_EXPORT: out },
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

function pollHealth(url, child, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;

  return new Promise(resolve => {
    const attempt = () => {
      if (child.exitCode !== null) {
        resolve({ exited: true });
        return;
      }
      if (Date.now() > deadline) {
        resolve({ exited: false, timedOut: true });
        return;
      }
      fetch(url)
        .then(response => {
          resolve({ exited: false, timedOut: false, healthy: response.ok });
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
 */
export async function startFlex3dViewer({
  protocolPath = null,
  port = FLEX3D_DEFAULT_PORT,
  preferredPython,
} = {}) {
  const args = ["-m", "sim.web_player", "--host", "127.0.0.1", "--port", String(port)];
  if (protocolPath && String(protocolPath).trim()) {
    args.push("--protocol", path.resolve(String(protocolPath)));
  }

  return withUsablePython(preferredPython, async python => new Promise(resolve => {
    const child = spawn(python, args, {
      cwd: FLEX3D_ROOT,
      env: { ...process.env, PYTHONPATH: FLEX3D_ROOT },
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    let stderr = "";
    child.stderr.on("data", chunk => {
      stderr += chunk.toString();
    });

    const url = `http://127.0.0.1:${port}/viewer.html`;

    pollHealth(`http://127.0.0.1:${port}/health`, child).then(status => {
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
        resolve({
          ok: false,
          error: "viewer_start_timeout",
          message: `web_player did not pass /health within 10s: ${url}`,
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
