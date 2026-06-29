#!/usr/bin/env node
/**
 * Read-only local source-map readiness summary.
 *
 * This script does not connect to the robot and does not move hardware. It
 * calls the local MCP handlers directly so an agent can inspect liquid/source
 * identity readiness even when the active MCP client still needs a reload.
 */
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(process.env.OPENTRONS_PLUGIN_ROOT || path.join(__dirname, ".."));
const DEFAULT_OUT_DIR = path.join(PLUGIN_ROOT, "runs", "self-recovery", "artifacts");
const DEFAULT_SESSION_ID = "self-recovery-liquid";

function parseArgs(argv) {
  const args = {
    session_id: process.env.OPENTRONS_SESSION_ID || DEFAULT_SESSION_ID,
    slot_name: null,
    well_name: null,
    out: null,
    template_json_out: null,
    template_tsv_out: null,
    template_md_out: null,
    validate_template_json: null,
    apply_template_json: null,
    validate_template_tsv: null,
    apply_template_tsv: null,
    validate_template_md: null,
    apply_template_md: null,
    report_out: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--session-id") {
      args.session_id = argv[index + 1];
      index += 1;
    } else if (item === "--slot") {
      args.slot_name = argv[index + 1];
      index += 1;
    } else if (item === "--well") {
      args.well_name = argv[index + 1];
      index += 1;
    } else if (item === "--out") {
      args.out = argv[index + 1];
      index += 1;
    } else if (item === "--template-json-out") {
      args.template_json_out = argv[index + 1];
      index += 1;
    } else if (item === "--template-tsv-out") {
      args.template_tsv_out = argv[index + 1];
      index += 1;
    } else if (item === "--template-md-out") {
      args.template_md_out = argv[index + 1];
      index += 1;
    } else if (item === "--validate-template-json") {
      args.validate_template_json = argv[index + 1];
      index += 1;
    } else if (item === "--apply-template-json") {
      args.apply_template_json = argv[index + 1];
      index += 1;
    } else if (item === "--validate-template-tsv") {
      args.validate_template_tsv = argv[index + 1];
      index += 1;
    } else if (item === "--apply-template-tsv") {
      args.apply_template_tsv = argv[index + 1];
      index += 1;
    } else if (item === "--validate-template-md") {
      args.validate_template_md = argv[index + 1];
      index += 1;
    } else if (item === "--apply-template-md") {
      args.apply_template_md = argv[index + 1];
      index += 1;
    } else if (item === "--report-out") {
      args.report_out = argv[index + 1];
      index += 1;
    }
  }

  return args;
}

function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function resolveOutputPath(args) {
  if (args.out) {
    return path.resolve(args.out);
  }
  const sessionPart = String(args.session_id || DEFAULT_SESSION_ID).replace(/[^a-zA-Z0-9_.-]/g, "_");
  const filterPart = [
    args.slot_name ? String(args.slot_name).trim().toUpperCase() : null,
    args.well_name ? String(args.well_name).trim().toUpperCase() : null,
  ].filter(Boolean).join("-");
  const nameParts = [
    "liquid-source-map-summary",
    sessionPart,
    filterPart || "all",
    timestampForFile(),
    randomUUID(),
  ];
  return path.join(DEFAULT_OUT_DIR, `${nameParts.join("-")}.json`);
}

function summarizeForConsole(payload = {}) {
  const data = payload.data || {};
  return {
    status: data.ready_for_semantic_recovery ? "pass" : "warn",
    session_id: payload.sessionId || null,
    source_count: data.source_count ?? null,
    expected_present_count: data.expected_present_count ?? null,
    expected_absent_count: data.expected_absent_count ?? null,
    observed_presence_mismatch_count: data.observed_presence_mismatch_count ?? null,
    incomplete_expected_present_count: data.incomplete_expected_present_count ?? null,
    ready_for_semantic_recovery: data.ready_for_semantic_recovery ?? null,
    record_liquid_source_map_draft_count: data.record_liquid_source_map_draft?.sources?.length ?? null,
    result_log_entry_id: payload.result_log_entry_id || null,
    output_path: payload.output_path || null,
    template_json_path: payload.template_json_path || null,
    template_tsv_path: payload.template_tsv_path || null,
    template_md_path: payload.template_md_path || null,
    operator_action: data.operator_action || null,
  };
}

function tsvEscape(value) {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).replace(/\t/g, " ").replace(/\r?\n/g, " ");
}

function buildTemplateTsv(sources = []) {
  const columns = [
    "slot_name",
    "well_name",
    "labware_load_name",
    "expected_presence",
    "liquid_name",
    "sample_id",
    "notes",
  ];
  const rows = sources.map(source => columns.map(column => tsvEscape(source[column])).join("\t"));
  return `${columns.join("\t")}\n${rows.join("\n")}${rows.length > 0 ? "\n" : ""}`;
}

function markdownEscape(value) {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function buildTemplateMarkdown({ sessionId, sources = [] } = {}) {
  const rows = sources.map(source => [
    source.slot_name,
    source.well_name,
    source.labware_load_name,
    source.expected_presence,
    source.liquid_name,
    source.sample_id,
    source.notes,
  ].map(markdownEscape));
  return [
    "# Liquid Source Identity Draft",
    "",
    `Session: \`${markdownEscape(sessionId || DEFAULT_SESSION_ID)}\``,
    "",
    "Fill `liquid_name` and `sample_id` for every expected-present source before semantic recovery or source substitution.",
    "",
    "| Slot | Well | Labware | Expected presence | Liquid name | Sample ID | Notes |",
    "|---|---|---|---:|---|---|---|",
    ...rows.map(row => `| ${row.join(" | ")} |`),
    "",
  ].join("\n");
}

function parseBooleanCell(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["true", "present", "yes", "1"].includes(normalized)) {
    return true;
  }
  if (["false", "absent", "no", "0"].includes(normalized)) {
    return false;
  }
  return value;
}

function parseTemplateTsv(text, sessionId = DEFAULT_SESSION_ID) {
  const lines = String(text || "").split(/\r?\n/).filter(line => line.trim() !== "");
  if (lines.length === 0) {
    return { session_id: sessionId, sources: [] };
  }
  const headers = lines[0].split("\t").map(header => header.trim());
  const sources = lines.slice(1).map(line => {
    const cells = line.split("\t");
    const source = {};
    headers.forEach((header, index) => {
      const value = cells[index] === undefined ? "" : cells[index].trim();
      source[header] = header === "expected_presence" ? parseBooleanCell(value) : value;
    });
    return source;
  });
  return { session_id: sessionId, sources };
}

function splitMarkdownRow(line) {
  const trimmed = String(line || "").trim();
  const inner = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let current = "";
  let escaping = false;
  for (const char of inner) {
    if (escaping) {
      current += char;
      escaping = false;
    } else if (char === "\\") {
      escaping = true;
    } else if (char === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function parseTemplateMarkdown(text, fallbackSessionId = DEFAULT_SESSION_ID) {
  const lines = String(text || "").split(/\r?\n/);
  const sessionLine = lines.find(line => /^Session:\s*`.+`/.test(line.trim()));
  const sessionMatch = sessionLine?.match(/^Session:\s*`(.+)`/);
  const sessionId = sessionMatch?.[1] || fallbackSessionId;
  const headerIndex = lines.findIndex(line => /^\|\s*Slot\s*\|\s*Well\s*\|\s*Labware\s*\|/i.test(line));
  if (headerIndex < 0) {
    return { session_id: sessionId, sources: [] };
  }

  const columns = splitMarkdownRow(lines[headerIndex]).map(column => column.trim().toLowerCase());
  const columnMap = {
    "slot": "slot_name",
    "well": "well_name",
    "labware": "labware_load_name",
    "expected presence": "expected_presence",
    "liquid name": "liquid_name",
    "sample id": "sample_id",
    "notes": "notes",
  };
  const dataLines = lines.slice(headerIndex + 2).filter(line => line.trim().startsWith("|"));
  const sources = dataLines.map(line => {
    const cells = splitMarkdownRow(line);
    const source = {};
    columns.forEach((column, index) => {
      const field = columnMap[column];
      if (!field) {
        return;
      }
      const value = cells[index] === undefined ? "" : cells[index].trim();
      source[field] = field === "expected_presence" ? parseBooleanCell(value) : value;
    });
    return source;
  });
  return { session_id: sessionId, sources };
}

function writeOptionalTemplateFiles(args, draft = {}) {
  const sources = Array.isArray(draft.sources) ? draft.sources : [];
  const outputs = {
    template_json_path: null,
    template_tsv_path: null,
    template_md_path: null,
  };

  if (args.template_json_out) {
    const jsonPath = path.resolve(args.template_json_out);
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, `${JSON.stringify({
      session_id: args.session_id,
      sources,
    }, null, 2)}\n`);
    outputs.template_json_path = jsonPath;
  }

  if (args.template_tsv_out) {
    const tsvPath = path.resolve(args.template_tsv_out);
    fs.mkdirSync(path.dirname(tsvPath), { recursive: true });
    fs.writeFileSync(tsvPath, buildTemplateTsv(sources));
    outputs.template_tsv_path = tsvPath;
  }

  if (args.template_md_out) {
    const mdPath = path.resolve(args.template_md_out);
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    fs.writeFileSync(mdPath, buildTemplateMarkdown({
      sessionId: args.session_id,
      sources,
    }));
    outputs.template_md_path = mdPath;
  }

  return outputs;
}

function writeOptionalReport(filePath, payload = {}) {
  if (!filePath) {
    return null;
  }
  const reportPath = path.resolve(filePath);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify({
    ...payload,
    report_path: reportPath,
  }, null, 2)}\n`);
  return reportPath;
}

function validateSourceIdentityTemplate(template = {}) {
  const sources = Array.isArray(template.sources) ? template.sources : [];
  const errors = [];

  if (!template.session_id) {
    errors.push({ index: null, field: "session_id", reason: "missing_session_id" });
  }
  if (!Array.isArray(template.sources)) {
    errors.push({ index: null, field: "sources", reason: "sources_must_be_array" });
  }

  sources.forEach((source, index) => {
    const location = `${source.slot_name || "?"}.${source.well_name || "?"}`;
    if (!source.slot_name) {
      errors.push({ index, location, field: "slot_name", reason: "missing_slot_name" });
    }
    if (!source.well_name) {
      errors.push({ index, location, field: "well_name", reason: "missing_well_name" });
    }
    if (source.expected_presence !== true) {
      errors.push({ index, location, field: "expected_presence", reason: "expected_present_sources_must_be_true" });
    }
    if (!source.liquid_name) {
      errors.push({ index, location, field: "liquid_name", reason: "missing_liquid_name" });
    } else if (source.liquid_name === "TODO_specific_liquid_name") {
      errors.push({ index, location, field: "liquid_name", reason: "todo_liquid_name" });
    } else if (source.liquid_name === "operator-confirmed-liquid") {
      errors.push({ index, location, field: "liquid_name", reason: "generic_liquid_name" });
    }
    if (!source.sample_id) {
      errors.push({ index, location, field: "sample_id", reason: "missing_sample_id" });
    } else if (source.sample_id === "TODO_sample_id") {
      errors.push({ index, location, field: "sample_id", reason: "todo_sample_id" });
    }
  });

  return {
    status: errors.length === 0 ? "pass" : "fail",
    session_id: template.session_id || null,
    source_count: sources.length,
    error_count: errors.length,
    errors,
    ready_to_record_liquid_source_map: errors.length === 0,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (
    args.validate_template_json ||
    args.apply_template_json ||
    args.validate_template_tsv ||
    args.apply_template_tsv ||
    args.validate_template_md ||
    args.apply_template_md
  ) {
    const applyMode = Boolean(args.apply_template_json || args.apply_template_tsv || args.apply_template_md);
    const tsvMode = Boolean(args.validate_template_tsv || args.apply_template_tsv);
    const mdMode = Boolean(args.validate_template_md || args.apply_template_md);
    const templatePath = path.resolve(
      args.apply_template_json ||
      args.validate_template_json ||
      args.apply_template_tsv ||
      args.validate_template_tsv ||
      args.apply_template_md ||
      args.validate_template_md,
    );
    const templateText = fs.readFileSync(templatePath, "utf8");
    const template = mdMode
      ? parseTemplateMarkdown(templateText, args.session_id)
      : tsvMode
        ? parseTemplateTsv(templateText, args.session_id)
        : JSON.parse(templateText);
    const validation = validateSourceIdentityTemplate(template);
    const mode = `${applyMode ? "apply" : "validate"}_template_${mdMode ? "md" : tsvMode ? "tsv" : "json"}`;
    if (!applyMode || validation.status !== "pass") {
      const payload = {
        ...validation,
        mode,
        template_path: templatePath,
        report_path: null,
        no_motion: true,
      };
      payload.report_path = writeOptionalReport(args.report_out, payload);
      console.log(JSON.stringify(payload, null, 2));
      process.exitCode = validation.status === "pass" ? 0 : 1;
      return;
    }

    const { TOOL_HANDLERS } = await import(path.join(PLUGIN_ROOT, "servers", "opentrons-mcp", "index.js"));
    const recordResult = await TOOL_HANDLERS.record_liquid_source_map({
      session_id: template.session_id,
      sources: template.sources,
    });
    const summary = await TOOL_HANDLERS.summarize_liquid_source_map({
      session_id: template.session_id,
    });
    const history = await TOOL_HANDLERS.experiment_history({
      session_id: template.session_id,
      tool_name: "summarize_liquid_source_map",
      event_kind: "source_map_readiness",
    });
    const latestEntry = history.data?.entries?.[0] || null;
    const payload = {
      ...validation,
      mode,
      template_path: templatePath,
      recorded_source_count: recordResult.data?.recorded_sources?.length ?? null,
      state_revision: recordResult.stateRevision ?? null,
      ready_for_semantic_recovery_after_record: summary.data?.ready_for_semantic_recovery ?? null,
      incomplete_expected_present_count_after_record:
        summary.data?.incomplete_expected_present_count ?? null,
      summary_result_log_status: summary.data?.ready_for_semantic_recovery ? "pass" : "warn",
      summary_result_log_entry_id: latestEntry?.entry_id || null,
      summary_result_log_entry: latestEntry,
      report_path: null,
      no_motion: true,
    };
    payload.report_path = writeOptionalReport(args.report_out, payload);
    console.log(JSON.stringify(payload, null, 2));
    process.exitCode = summary.data?.ready_for_semantic_recovery ? 0 : 1;
    return;
  }

  const outputPath = resolveOutputPath(args);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const { TOOL_HANDLERS } = await import(path.join(PLUGIN_ROOT, "servers", "opentrons-mcp", "index.js"));
  const summary = await TOOL_HANDLERS.summarize_liquid_source_map({
    session_id: args.session_id,
    ...(args.slot_name ? { slot_name: args.slot_name } : {}),
    ...(args.well_name ? { well_name: args.well_name } : {}),
  });
  const history = await TOOL_HANDLERS.experiment_history({
    session_id: args.session_id,
    tool_name: "summarize_liquid_source_map",
    event_kind: "source_map_readiness",
  });
  const latestEntry = history.data?.entries?.[0] || null;
  const templateOutputs = writeOptionalTemplateFiles(
    args,
    summary.data?.record_liquid_source_map_draft || {},
  );
  const payload = {
    ...summary,
    output_path: outputPath,
    ...templateOutputs,
    result_log_entry_id: latestEntry?.entry_id || null,
    result_log_entry: latestEntry,
    generated_at: new Date().toISOString(),
    no_motion: true,
  };

  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(JSON.stringify(summarizeForConsole(payload), null, 2));
  process.exitCode = summary.data?.ready_for_semantic_recovery ? 0 : 1;
}

main().catch(error => {
  console.error(JSON.stringify({
    status: "error",
    error: error?.message || String(error),
  }, null, 2));
  process.exitCode = 1;
});
