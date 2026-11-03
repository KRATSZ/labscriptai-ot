import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ARTIFACTS_DIR, PLUGIN_ROOT, resolvePythonCandidates } from "./paths.js";

const execute = promisify(execFile);
const script = path.join(PLUGIN_ROOT, "automation/figures/experiment_figure.py");
export const FIGURE_DIR = path.join(ARTIFACTS_DIR, "experiment-figures");
const failure = message => ({ ok: false, error: "figure_generation_failed", message,
  next_action: "配置图未生成；模拟结果和动画仍可使用。重运行安装器后重试原操作。" });

/** Non-blocking companion artifact: never changes simulation or readiness verdicts. */
export async function generateExperimentFigure({ analysisPath, preferredPython } = {}) {
  if (!analysisPath) return { ok: false, status: "not_available", message: "本次没有可用于绘图的分析数据。" };
  for (const python of resolvePythonCandidates(preferredPython)) {
    try {
      const { stdout } = await execute(python, [script, "--analysis", analysisPath, "--out", FIGURE_DIR], {
        timeout: 45000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      });
      const result = JSON.parse(stdout.trim());
      if (!result.ok) return failure(result.message || "配置图生成失败。");
      return { ...result, png_path: path.join(result.directory, result.images[0]),
        image_paths: result.images.map(name => path.join(result.directory, name)),
        page_path: path.join(result.directory, "setup.html"),
        data_path: path.join(result.directory, "setup.json"), csv_path: path.join(result.directory, "wells.csv"),
        message: "实验配置图已生成，包含台面摆位与起始装液；逐孔表可在配置页面查看或下载。" };
    } catch (error) {
      if (error.code === "ENOENT") continue;
      return failure(`配置图生成失败：${error.message}`);
    }
  }
  return failure("未找到可用的 Python。请运行插件安装器。");
}

export function figureImages(figure) {
  if (!figure?.ok || !figure.png_path) return [];
  try {
    if (fs.statSync(figure.png_path).size > 5 * 1024 * 1024) return [];
    return [{ type: "image", mimeType: "image/png", data: fs.readFileSync(figure.png_path).toString("base64") }];
  } catch { return []; }
}
