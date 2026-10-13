import crypto from "crypto";
import fs from "fs";
import path from "path";

import { ARTIFACTS_DIR, SCRIPTS_DIR } from "./paths.js";

const helperScriptPath = path.join(SCRIPTS_DIR, "local_simulation.py");
const inflight = new Map();

function protocolHash(filePath) {
  const bytes = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 20);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

/**
 * One opentrons analyze per protocol contents. simulate_protocol, logicpass_check,
 * and logicpass_check all go through here.
 */
export async function analyzeProtocolOnce(args = {}) {
  if (args.analysis_path) {
    const analysisPath = path.resolve(args.analysis_path);
    const payload = readJson(analysisPath);
    const errorCount = Array.isArray(payload.errors) ? payload.errors.length : 0;
    return {
      ok: errorCount === 0,
      error_count: errorCount,
      analysis_path: analysisPath,
      analysis_cached: true,
      robot_type: payload.robotType || payload?.metadata?.robotType || null,
      exit_code: errorCount === 0 ? 0 : 1,
      stdout: "",
      stderr: errorCount > 0 ? "analysis JSON has errors" : "",
      protocol: args.protocol_path || analysisPath,
    };
  }

  if (!args.protocol_path) {
    throw new Error("protocol_path is required");
  }

  const protocolPath = path.resolve(args.protocol_path);
  const hash = protocolHash(protocolPath);
  const dir = path.join(ARTIFACTS_DIR, "analyze-cache");
  fs.mkdirSync(dir, { recursive: true });
  const analysisPath = path.join(dir, `${hash}.analysis.json`);
  const metaPath = path.join(dir, `${hash}.meta.json`);

  if (fs.existsSync(metaPath)) {
    const meta = readJson(metaPath);
    meta.analysis_cached = true;
    meta.analysis_path = fs.existsSync(analysisPath) ? analysisPath : meta.analysis_path || null;
    if (meta.analysis_path && fs.existsSync(meta.analysis_path)) {
      try {
        const analysis = readJson(meta.analysis_path);
        const errorCount = Array.isArray(analysis.errors) ? analysis.errors.length : 0;
        meta.robot_type = meta.robot_type || analysis.robotType || null;
        meta.error_count = errorCount;
        if (errorCount > 0) meta.ok = false;
      } catch {
        meta.robot_type = meta.robot_type || null;
      }
    }
    return meta;
  }

  if (inflight.has(hash)) {
    return inflight.get(hash);
  }

  const job = runAnalyze(args, protocolPath, analysisPath, metaPath).finally(() => {
    inflight.delete(hash);
  });
  inflight.set(hash, job);
  return job;
}

async function runAnalyze(args, protocolPath, analysisPath, metaPath) {
  const { runHelper } = await import("./simulation.js");
  const helperArgs = [helperScriptPath, "analyze", "--json-output", analysisPath];
  for (const [key, flag] of [
    ["workspace_root", "--workspace-root"],
    ["api_root", "--api-root"],
    ["shared_data_root", "--shared-data-root"],
    ["python_executable", "--python"],
  ]) {
    if (args[key]) helperArgs.push(flag, args[key]);
  }
  helperArgs.push(protocolPath);

  const result = await runHelper(helperArgs, args.python_executable);
  let payload;
  try {
    payload = JSON.parse(result.stdout.trim());
  } catch {
    payload = {
      ok: false,
      exit_code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      error: { error_type: "InvalidJsonOutput", error: "analyze helper did not print JSON" },
      analysis_path: null,
      robot_type: null,
    };
  }

  payload.analysis_cached = false;
  payload.stdout = clip(payload.stdout);
  payload.stderr = clip(payload.stderr);
  payload.helper = {
    runner_python: result.command,
    helper_script: helperScriptPath,
    helper_exit_code: result.code,
  };
  delete payload.payload;
  // A missing analysis file means the interpreter failed. Do not cache that,
  // or the next call with a working Python still looks failed.
  if (payload.analysis_path && fs.existsSync(payload.analysis_path)) {
    fs.writeFileSync(metaPath, JSON.stringify(payload));
  }
  return payload;
}

function clip(text, maxChars = 20000) {
  if (typeof text !== "string" || text.length <= maxChars) return text || "";
  const head = Math.floor(maxChars * 0.55);
  return `${text.slice(0, head)}\n\n...[truncated ${text.length - maxChars} chars]...\n\n${text.slice(-(maxChars - head))}`;
}
