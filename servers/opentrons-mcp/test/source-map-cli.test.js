import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "..", "..", "..");
const CLI_PATH = path.join(PLUGIN_ROOT, "scripts", "summarize-liquid-source-map.mjs");

function runCli(args, env) {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: PLUGIN_ROOT,
    env: {
      ...process.env,
      ...env,
    },
    encoding: "utf8",
    timeout: 15000,
  });
  const stdout = result.stdout ? JSON.parse(result.stdout) : null;
  return { ...result, stdoutJson: stdout };
}

function runNodeSnippet(source, env) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: PLUGIN_ROOT,
    env: {
      ...process.env,
      ...env,
    },
    encoding: "utf8",
    timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function fillTemplateTsv(inputPath, outputPath) {
  const lines = fs.readFileSync(inputPath, "utf8").trim().split(/\r?\n/);
  const output = lines.map((line, index) => {
    if (index === 0) {
      return line;
    }
    const cells = line.split("\t");
    const slot = cells[0];
    const well = cells[1];
    cells[4] = slot === "C3" ? "reservoir-buffer-a" : "reaction-sample";
    cells[5] = `${slot}-${well}-identity`.toLowerCase();
    return cells.join("\t");
  });
  fs.writeFileSync(outputPath, `${output.join("\n")}\n`);
}

function fillTemplateJson(inputPath, outputPath) {
  const template = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  template.sources = template.sources.map(source => ({
    ...source,
    liquid_name: source.slot_name === "C3" ? "reservoir-buffer-a" : "reaction-sample",
    sample_id: `${source.slot_name}-${source.well_name}-identity`.toLowerCase(),
  }));
  fs.writeFileSync(outputPath, `${JSON.stringify(template, null, 2)}\n`);
}

function fillTemplateMarkdown(inputPath, outputPath) {
  const lines = fs.readFileSync(inputPath, "utf8").split(/\r?\n/);
  const output = lines.map(line => {
    if (!line.startsWith("| C3 |") && !line.startsWith("| D3 |")) {
      return line;
    }
    const cells = line.replace(/^\|/, "").replace(/\|$/, "").split("|").map(cell => cell.trim());
    const slot = cells[0];
    const well = cells[1];
    cells[4] = slot === "C3" ? "reservoir-buffer-a" : "reaction-sample";
    cells[5] = `${slot}-${well}-identity`.toLowerCase();
    return `| ${cells.join(" | ")} |`;
  });
  fs.writeFileSync(outputPath, output.join("\n"));
}

test("summarize-liquid-source-map CLI validates and applies filled TSV identity drafts", async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "liquid-cli-session-"));
  const resultLogDir = fs.mkdtempSync(path.join(os.tmpdir(), "liquid-cli-log-"));
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "liquid-cli-artifacts-"));
  const sessionId = "liquid-cli-test";
  const env = {
    OPENTRONS_SESSION_STATE_DIR: sessionDir,
    OPENTRONS_RESULT_LOG_DIR: resultLogDir,
  };

  runNodeSnippet(`
    import { TOOL_HANDLERS } from "./servers/opentrons-mcp/index.js";
    await TOOL_HANDLERS.record_liquid_source_map({
      session_id: "${sessionId}",
      sources: [
        {
          slot_name: "C3",
          well_name: "A1",
          labware_load_name: "nest_12_reservoir_15ml",
          liquid_name: "operator-confirmed-liquid",
          expected_presence: true,
        },
        {
          slot_name: "D3",
          well_name: "A1",
          labware_load_name: "corning_96_wellplate_360ul_flat",
          expected_presence: true,
        },
        {
          slot_name: "D3",
          well_name: "A12",
          labware_load_name: "corning_96_wellplate_360ul_flat",
          liquid_name: "empty-control",
          sample_id: "validated-empty-source-d3-a12",
          expected_presence: false,
        },
      ],
    });
  `, env);

  const templateTsv = path.join(artifactDir, "identity-draft.tsv");
  const templateMd = path.join(artifactDir, "identity-draft.md");
  const exportResult = runCli([
    "--session-id",
    sessionId,
    "--out",
    path.join(artifactDir, "summary.json"),
    "--template-tsv-out",
    templateTsv,
    "--template-md-out",
    templateMd,
  ], env);
  assert.equal(exportResult.status, 1);
  assert.equal(exportResult.stdoutJson.status, "warn");
  assert.equal(exportResult.stdoutJson.record_liquid_source_map_draft_count, 2);
  assert.equal(fs.existsSync(templateTsv), true);
  assert.equal(fs.existsSync(templateMd), true);
  assert.equal(exportResult.stdoutJson.template_md_path, templateMd);
  const markdownDraft = fs.readFileSync(templateMd, "utf8");
  assert.match(markdownDraft, /# Liquid Source Identity Draft/);
  assert.match(markdownDraft, /Session: `liquid-cli-test`/);
  assert.match(markdownDraft, /\| C3 \| A1 \| nest_12_reservoir_15ml \| true \| TODO_specific_liquid_name \| TODO_sample_id \|/);
  assert.match(markdownDraft, /\| D3 \| A1 \| corning_96_wellplate_360ul_flat \| true \| TODO_specific_liquid_name \| TODO_sample_id \|/);

  const unfilledValidation = runCli([
    "--session-id",
    sessionId,
    "--validate-template-tsv",
    templateTsv,
    "--report-out",
    path.join(artifactDir, "validation-report.json"),
  ], env);
  assert.equal(unfilledValidation.status, 1);
  assert.equal(unfilledValidation.stdoutJson.status, "fail");
  assert.equal(unfilledValidation.stdoutJson.error_count, 4);
  assert.equal(unfilledValidation.stdoutJson.mode, "validate_template_tsv");
  assert.equal(fs.existsSync(unfilledValidation.stdoutJson.report_path), true);
  const validationReport = JSON.parse(fs.readFileSync(unfilledValidation.stdoutJson.report_path, "utf8"));
  assert.equal(validationReport.status, "fail");
  assert.equal(validationReport.error_count, 4);
  assert.equal(validationReport.report_path, unfilledValidation.stdoutJson.report_path);

  const filledTsv = path.join(artifactDir, "identity-filled.tsv");
  fillTemplateTsv(templateTsv, filledTsv);
  const applyReportPath = path.join(artifactDir, "apply-report.json");
  const applyResult = runCli([
    "--session-id",
    sessionId,
    "--apply-template-tsv",
    filledTsv,
    "--report-out",
    applyReportPath,
  ], env);
  assert.equal(applyResult.status, 0);
  assert.equal(applyResult.stdoutJson.status, "pass");
  assert.equal(applyResult.stdoutJson.mode, "apply_template_tsv");
  assert.equal(applyResult.stdoutJson.recorded_source_count, 2);
  assert.equal(applyResult.stdoutJson.ready_for_semantic_recovery_after_record, true);
  assert.equal(applyResult.stdoutJson.incomplete_expected_present_count_after_record, 0);
  assert.match(applyResult.stdoutJson.summary_result_log_entry_id, /^[0-9a-f-]+$/);
  assert.equal(applyResult.stdoutJson.summary_result_log_entry.status, "pass");
  assert.equal(
    applyResult.stdoutJson.summary_result_log_entry.data.ready_for_semantic_recovery,
    true,
  );
  assert.equal(applyResult.stdoutJson.report_path, applyReportPath);
  const applyReport = JSON.parse(fs.readFileSync(applyReportPath, "utf8"));
  assert.equal(applyReport.status, "pass");
  assert.equal(applyReport.ready_for_semantic_recovery_after_record, true);
  assert.equal(applyReport.summary_result_log_entry_id, applyResult.stdoutJson.summary_result_log_entry_id);

  const summaryResult = runCli(["--session-id", sessionId], env);
  assert.equal(summaryResult.status, 0);
  assert.equal(summaryResult.stdoutJson.ready_for_semantic_recovery, true);
  assert.equal(summaryResult.stdoutJson.incomplete_expected_present_count, 0);
});

test("summarize-liquid-source-map CLI validates and applies filled Markdown identity drafts", async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "liquid-cli-md-session-"));
  const resultLogDir = fs.mkdtempSync(path.join(os.tmpdir(), "liquid-cli-md-log-"));
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "liquid-cli-md-artifacts-"));
  const sessionId = "liquid-cli-md-test";
  const env = {
    OPENTRONS_SESSION_STATE_DIR: sessionDir,
    OPENTRONS_RESULT_LOG_DIR: resultLogDir,
  };

  runNodeSnippet(`
    import { TOOL_HANDLERS } from "./servers/opentrons-mcp/index.js";
    await TOOL_HANDLERS.record_liquid_source_map({
      session_id: "${sessionId}",
      sources: [
        {
          slot_name: "C3",
          well_name: "A1",
          labware_load_name: "nest_12_reservoir_15ml",
          liquid_name: "operator-confirmed-liquid",
          expected_presence: true,
        },
        {
          slot_name: "D3",
          well_name: "A1",
          labware_load_name: "corning_96_wellplate_360ul_flat",
          expected_presence: true,
        },
      ],
    });
  `, env);

  const templateMd = path.join(artifactDir, "identity-draft.md");
  const exportResult = runCli([
    "--session-id",
    sessionId,
    "--out",
    path.join(artifactDir, "summary.json"),
    "--template-md-out",
    templateMd,
  ], env);
  assert.equal(exportResult.status, 1);
  assert.equal(exportResult.stdoutJson.status, "warn");
  assert.equal(exportResult.stdoutJson.template_md_path, templateMd);

  const unfilledValidation = runCli([
    "--validate-template-md",
    templateMd,
    "--report-out",
    path.join(artifactDir, "md-validation-report.json"),
  ], env);
  assert.equal(unfilledValidation.status, 1);
  assert.equal(unfilledValidation.stdoutJson.status, "fail");
  assert.equal(unfilledValidation.stdoutJson.error_count, 4);
  assert.equal(unfilledValidation.stdoutJson.mode, "validate_template_md");
  assert.equal(fs.existsSync(unfilledValidation.stdoutJson.report_path), true);
  const validationReport = JSON.parse(fs.readFileSync(unfilledValidation.stdoutJson.report_path, "utf8"));
  assert.equal(validationReport.report_path, unfilledValidation.stdoutJson.report_path);

  const filledMd = path.join(artifactDir, "identity-filled.md");
  fillTemplateMarkdown(templateMd, filledMd);
  const applyReportPath = path.join(artifactDir, "md-apply-report.json");
  const applyResult = runCli([
    "--apply-template-md",
    filledMd,
    "--report-out",
    applyReportPath,
  ], env);
  assert.equal(applyResult.status, 0);
  assert.equal(applyResult.stdoutJson.status, "pass");
  assert.equal(applyResult.stdoutJson.mode, "apply_template_md");
  assert.equal(applyResult.stdoutJson.recorded_source_count, 2);
  assert.equal(applyResult.stdoutJson.ready_for_semantic_recovery_after_record, true);
  assert.match(applyResult.stdoutJson.summary_result_log_entry_id, /^[0-9a-f-]+$/);
  assert.equal(applyResult.stdoutJson.summary_result_log_entry.status, "pass");
  assert.equal(applyResult.stdoutJson.report_path, applyReportPath);

  const summaryResult = runCli(["--session-id", sessionId], env);
  assert.equal(summaryResult.status, 0);
  assert.equal(summaryResult.stdoutJson.ready_for_semantic_recovery, true);
  assert.equal(summaryResult.stdoutJson.incomplete_expected_present_count, 0);
});

test("summarize-liquid-source-map CLI validates and applies filled JSON identity drafts", async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "liquid-cli-json-session-"));
  const resultLogDir = fs.mkdtempSync(path.join(os.tmpdir(), "liquid-cli-json-log-"));
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "liquid-cli-json-artifacts-"));
  const sessionId = "liquid-cli-json-test";
  const env = {
    OPENTRONS_SESSION_STATE_DIR: sessionDir,
    OPENTRONS_RESULT_LOG_DIR: resultLogDir,
  };

  runNodeSnippet(`
    import { TOOL_HANDLERS } from "./servers/opentrons-mcp/index.js";
    await TOOL_HANDLERS.record_liquid_source_map({
      session_id: "${sessionId}",
      sources: [
        {
          slot_name: "C3",
          well_name: "A1",
          labware_load_name: "nest_12_reservoir_15ml",
          liquid_name: "operator-confirmed-liquid",
          expected_presence: true,
        },
        {
          slot_name: "D3",
          well_name: "A1",
          labware_load_name: "corning_96_wellplate_360ul_flat",
          expected_presence: true,
        },
      ],
    });
  `, env);

  const templateJson = path.join(artifactDir, "identity-draft.json");
  const templateMd = path.join(artifactDir, "identity-draft.md");
  const exportResult = runCli([
    "--session-id",
    sessionId,
    "--out",
    path.join(artifactDir, "summary.json"),
    "--template-json-out",
    templateJson,
    "--template-md-out",
    templateMd,
  ], env);
  assert.equal(exportResult.status, 1);
  assert.equal(exportResult.stdoutJson.status, "warn");
  assert.equal(exportResult.stdoutJson.record_liquid_source_map_draft_count, 2);
  assert.equal(fs.existsSync(templateJson), true);
  assert.equal(fs.existsSync(templateMd), true);
  assert.equal(exportResult.stdoutJson.template_md_path, templateMd);

  const unfilledValidation = runCli([
    "--validate-template-json",
    templateJson,
    "--report-out",
    path.join(artifactDir, "json-validation-report.json"),
  ], env);
  assert.equal(unfilledValidation.status, 1);
  assert.equal(unfilledValidation.stdoutJson.status, "fail");
  assert.equal(unfilledValidation.stdoutJson.error_count, 4);
  assert.equal(unfilledValidation.stdoutJson.mode, "validate_template_json");
  assert.equal(fs.existsSync(unfilledValidation.stdoutJson.report_path), true);

  const filledJson = path.join(artifactDir, "identity-filled.json");
  fillTemplateJson(templateJson, filledJson);
  const applyReportPath = path.join(artifactDir, "json-apply-report.json");
  const applyResult = runCli([
    "--apply-template-json",
    filledJson,
    "--report-out",
    applyReportPath,
  ], env);
  assert.equal(applyResult.status, 0);
  assert.equal(applyResult.stdoutJson.status, "pass");
  assert.equal(applyResult.stdoutJson.mode, "apply_template_json");
  assert.equal(applyResult.stdoutJson.recorded_source_count, 2);
  assert.equal(applyResult.stdoutJson.ready_for_semantic_recovery_after_record, true);
  assert.match(applyResult.stdoutJson.summary_result_log_entry_id, /^[0-9a-f-]+$/);
  assert.equal(applyResult.stdoutJson.summary_result_log_entry.status, "pass");
  assert.equal(applyResult.stdoutJson.report_path, applyReportPath);

  const applyReport = JSON.parse(fs.readFileSync(applyReportPath, "utf8"));
  assert.equal(applyReport.status, "pass");
  assert.equal(applyReport.summary_result_log_entry_id, applyResult.stdoutJson.summary_result_log_entry_id);
  assert.equal(applyReport.report_path, applyReportPath);
});
