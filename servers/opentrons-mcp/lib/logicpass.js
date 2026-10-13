import path from "path";
import { spawn } from "child_process";

import { PLUGIN_ROOT, resolvePythonCandidates, SCRIPTS_DIR } from "./paths.js";

const bridge = path.join(SCRIPTS_DIR, "logicpass_check.py");
const vendor = path.join(PLUGIN_ROOT, "automation", "vendor");

function runPython(python, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, args, {
      env: { ...process.env, PYTHONPATH: vendor },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export async function runLogicpassCheck({ analysisPath, simPass, python }) {
  const executable = resolvePythonCandidates(python)[0];
  if (!executable) {
    throw new Error("没有可用的 Python，跑不了 LogicPass");
  }
  const result = await runPython(executable, [
    bridge,
    analysisPath || "",
    simPass ? "true" : "false",
  ]);
  try {
    const payload = JSON.parse(result.stdout.trim());
    payload.helper_exit_code = result.code;
    return payload;
  } catch {
    throw new Error(`LogicPass 没有返回 JSON：${result.stderr || result.stdout}`.slice(0, 2000));
  }
}
