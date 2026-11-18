/** Capture batch output without forbidden libuv named pipes on restricted Windows. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const limitError = () => Object.assign(new Error("Helper output exceeds its capture limit"), {code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"});

/**
 * Capture the direct helper's output. POSIX keeps pipe semantics. Windows inherits
 * ordinary files and the caller's console; all capture files remain available
 * until the invocation owner establishes process-tree shutdown and removes them.
 * A timeout escalates to a force kill and rejects if exit cannot be established.
 */
export async function captureProcess(command, args, { cwd = process.cwd(), env = process.env,
  input, timeout = 0, maxBuffer = 16 * 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(maxBuffer) || maxBuffer < 1 || !Number.isFinite(timeout) || timeout < 0) {
    throw new Error("Invalid helper capture limits");
  }
  const fileMode = process.platform === "win32";
  const directory = fileMode ? fs.mkdtempSync(path.join(env.TMPDIR || env.TEMP || os.tmpdir(), "ot-capture-")) : null;
  const files = directory ? ["stdin", "stdout", "stderr"].map(name => path.join(directory, name)) : [];
  const handles = [];
  const output = [[], []], sizes = [0, 0];
  let child, timer, monitor, force, deadline, failure;
  try {
    if (fileMode) {
      if (input !== undefined) {
        fs.writeFileSync(files[0], input, { flag: "wx", mode: 0o600 });
        handles.push(fs.openSync(files[0], "r"));
      } else handles.push("ignore");
      handles.push(fs.openSync(files[1], "wx", 0o600));
      handles.push(fs.openSync(files[2], "wx", 0o600));
    }
    const code = await new Promise((resolve, reject) => {
      child = spawn(command, args, { cwd, env: { PYTHONIOENCODING: "utf-8", ...env }, windowsHide: false,
        stdio: fileMode ? handles : [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
      const kill = signal => {
        try { child.kill(signal); } catch (error) { failure ??= error; }
      };
      const stop = error => {
        if (failure) return;
        failure = error;
        kill("SIGTERM");
        force = setTimeout(() => kill("SIGKILL"), 250);
        deadline = setTimeout(() => {
          const uncertain = Object.assign(new Error("Helper termination is uncertain; retained capture files and invocation must not be removed"), {code: "PROCESS_STOP_UNCERTAIN", captureDirectory: directory});
          child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
          reject(uncertain);
        }, 5000);
      };
      child.once("error", error => { failure = error; reject(error); });
      child.once("close", (code, signal) => {
        if (signal && !failure) failure = new Error(`Helper stopped by ${signal}`);
        resolve(code);
      });
      if (!fileMode) {
        for (const [index, stream] of [child.stdout, child.stderr].entries()) stream.on("data", chunk => {
          sizes[index] += chunk.length;
          if (sizes[index] > maxBuffer) stop(limitError());
          else output[index].push(chunk);
        });
        if (input !== undefined) {
          child.stdin.on("error", error => stop(error));
          child.stdin.end(input);
        }
      }
      if (timeout) timer = setTimeout(() => stop(Object.assign(new Error(`Helper timed out after ${timeout}ms`), {code: "ETIMEDOUT"})), timeout);
      if (fileMode) monitor = setInterval(() => {
        try {
          if (files.slice(1).some(file => fs.statSync(file).size > maxBuffer)) stop(limitError());
        } catch (error) { stop(error); }
      }, 100);
    });
    if (failure) throw failure;
    if (fileMode && files.slice(1).some(file => fs.statSync(file).size > maxBuffer)) throw limitError();
    const stdout = fileMode ? fs.readFileSync(files[1], "utf8") : Buffer.concat(output[0]).toString("utf8");
    const stderr = fileMode ? fs.readFileSync(files[2], "utf8") : Buffer.concat(output[1]).toString("utf8");
    return { code, stdout, stderr, command, args, captureDirectory: directory };
  } finally {
    for (const timer of [monitor, force, deadline]) clearTimeout(timer);
    clearTimeout(timer);
    for (const handle of handles) if (typeof handle === "number") fs.closeSync(handle);
  }
}

/** execFile-style nonzero-exit behavior for portable document/figure exporters. */
export async function executeCaptured(command, args, options) {
  const result = await captureProcess(command, args, options);
  if (result.code !== 0) {
    const error = new Error(`Helper exited ${result.code}: ${result.stderr.slice(-2000)}`);
    Object.assign(error, { code: result.code, stdout: result.stdout, stderr: result.stderr, captureDirectory: result.captureDirectory });
    throw error;
  }
  return result;
}
