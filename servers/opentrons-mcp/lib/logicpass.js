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

/**
 * Closed gate decision for the live run gate: only final_pass_v2=true passes.
 * Fail AND unevaluable both block; the returned Error always carries the
 * concrete reason (LP-L5 detail / analyze failure), never a bare "failed".
 *
 * @returns {{ blocked: false } | { blocked: true, error: Error }}
 */
export function buildLogicpassGateBlock({ verdict = null, gateError = null, doctor = null, simulation = null, parsed = null } = {}) {
  const finalPassV2 = Boolean(verdict?.final_pass_v2);
  if (finalPassV2) {
    return { blocked: false };
  }
  const outcome = verdict?.outcome || "unevaluable";
  const analyzeReason = verdict?.analyze?.reason || "";
  const issues = verdict?.issues || [];
  const reasonIssue =
    issues.find(
      (issue) => (issue?.severity === "error" || issue?.code === "LP-L5") && issue?.detail_text,
    ) || issues.find((issue) => issue?.detail_text);
  const capacityNote = verdict?.capacity_note || "";
  const reasonParts = [gateError, analyzeReason].filter(Boolean);
  if (reasonIssue?.detail_text) {
    reasonParts.push(reasonIssue.code ? `${reasonIssue.code}: ${reasonIssue.detail_text}` : reasonIssue.detail_text);
  }
  const reasonText = reasonParts.join(" | ") || "LogicPass 没有给出可用结论。";
  const error = new Error(
    `LogicPass gate blocked real execution: outcome=${outcome}; final_pass_v2=false. 原因: ${reasonText}. Explicit operator waiver: run_protocol(skip_logicpass_gate=true); local simulation still required.`,
  );
  error.toolContext = {
    data: {
      blocked_real_execution: true,
      gate_stage: "logicpass_check",
      doctor_local_runtime: doctor,
      simulation_output: simulation,
      parsed_simulation_output: parsed,
      logicpass_gate: {
        outcome,
        operator_override: { tool: "run_protocol", arguments: { skip_logicpass_gate: true }, requires_explicit_operator_request: true },
        logic_pass: Boolean(verdict?.logic_pass),
        final_pass_v2: false,
        issues: verdict?.issues || [],
        capacity_note: capacityNote,
        guessed_capacity_labware: verdict?.guessed_capacity_labware || [],
        analyze: verdict?.analyze || null,
        error: gateError,
      },
    },
  };
  return { blocked: true, error };
}
