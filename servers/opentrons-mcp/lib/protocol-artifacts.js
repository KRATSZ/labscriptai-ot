import path from "node:path";
import { executeCaptured as execute } from "./process-capture.js";
import { createArtifactStage, cleanUnusedStages, inheritsPrivateAcl } from "./artifact-staging.js";
import { ARTIFACTS_DIR, PLUGIN_ROOT, resolvePythonCandidates } from "./paths.js";
import { buildIdentity } from "./build-info.js";

/** Public artifact API v1: portable documents, independent per-document failures. */
export async function protocolArtifacts({ analysis_path, python_executable } = {}) {
  if (!analysis_path) throw new Error("analysis_path is required");
  const stages = [];
  let uncertain = false;
  try {
    const output = path.join(ARTIFACTS_DIR, "documents");
    const stageArgs = [];
    if (inheritsPrivateAcl()) {
      const documentStage = createArtifactStage(output, "documents-");
      stages.push(documentStage);
      const figureStage = createArtifactStage(path.join(output, "figures"), ".figure-");
      stages.push(figureStage);
      stageArgs.push("--documents-stage", documentStage, "--figure-stage", figureStage);
    }
    for (const python of resolvePythonCandidates(python_executable)) {
      try {
        const { stdout } = await execute(python, [path.join(PLUGIN_ROOT, "automation/flex3d/sim/export_documents.py"),
          "--analysis", path.resolve(analysis_path), "--out", output,
          ...stageArgs], {
          timeout: 120000, maxBuffer: 1024 * 1024,
          env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONPATH: path.join(PLUGIN_ROOT, "automation/flex3d") },
        });
        return { ...JSON.parse(stdout.trim()), plugin_version: buildIdentity(PLUGIN_ROOT).version };
      } catch (error) {
        if (error.code === "ENOENT") continue;
        uncertain = error.code === "PROCESS_STOP_UNCERTAIN";
        return { ok: false, artifact_api: 1, message: String(error.message).slice(0, 2000) };
      }
    }
    return { ok: false, artifact_api: 1, message: "Plugin Python runtime is not installed. Run the plugin installer." };
  } finally {
    if (!uncertain) cleanUnusedStages(stages);
  }
}
