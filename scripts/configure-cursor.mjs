#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RULE_MARKER = "<!-- labscriptai-ot:managed -->";
const HELP = `Usage: node scripts/configure-cursor.mjs /absolute/path/to/project

Write .cursor/mcp.json and .cursor/rules/labscriptai-ot.mdc for this plugin.
Unrelated config, servers, and rules are preserved. No robot or global changes.`;

function readConfig(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (err) {
    if (err.code === "ENOENT") return { mcpServers: {} };
    throw new Error(`cannot read ${file}: ${err.message}`);
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let config;
  try { config = JSON.parse(text); } catch (err) {
    throw new Error(`invalid JSON in ${file}: ${err.message}. Nothing was changed; fix it or move it aside and retry.`);
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error(`${file} must contain a JSON object. Nothing was changed.`);
  if (config.mcpServers === undefined) config.mcpServers = {};
  if (!config.mcpServers || typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers)) throw new Error(`${file} has a non-object "mcpServers"; fix it before retrying. Nothing was changed.`);
  return config;
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  try {
    fs.writeFileSync(temp, content, { flag: "wx", mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch {}
  }
}

function buildRule() {
  const skillRoot = path.join(PLUGIN_ROOT, "skills");
  const skills = fs.readdirSync(skillRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && fs.existsSync(path.join(skillRoot, entry.name, "SKILL.md")))
    .map(entry => `- \`${path.join(skillRoot, entry.name, "SKILL.md")}\``)
    .sort().join("\n");
  const agents = path.join(PLUGIN_ROOT, "AGENTS.md");
  return `---
description: LabscriptAI OT safety and workflow rules
alwaysApply: false
---
${RULE_MARKER}
# LabscriptAI OT

This rule is managed by the LabscriptAI OT plugin. Rerun \`node ${path.join(PLUGIN_ROOT, "scripts", "configure-cursor.mjs")} <project>\` to update it.
Read the plugin instructions at \`${agents}\` and the relevant SKILL.md before acting.

Skills:
${skills}

- Live robot actions are opt-in only. Run local simulation before unattended live execution; treat vision as observation-only.
- Reply in the user's language. Lead with the result, then the next action or blocker. Use plain language, keep routine replies short, and link files instead of pasting logs or status JSON.
`;
}

function configure(projectArg) {
  const target = path.resolve(projectArg);
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new Error(`target is not an existing directory: ${target}`);
  const mcpFile = path.join(target, ".cursor", "mcp.json");
  const ruleFile = path.join(target, ".cursor", "rules", "labscriptai-ot.mdc");
  const config = readConfig(mcpFile);
  if (fs.existsSync(ruleFile) && !fs.readFileSync(ruleFile, "utf8").includes(RULE_MARKER)) {
    throw new Error(`refusing to overwrite ${ruleFile}: it is not managed by this plugin (missing marker). Rename it and retry. Nothing was changed.`);
  }
  const rule = buildRule();
  config.mcpServers["opentrons-lab"] = {
    command: process.execPath,
    args: [path.join(PLUGIN_ROOT, "servers/opentrons-mcp/index.js")],
    env: { OPENTRONS_PLUGIN_ROOT: PLUGIN_ROOT, OPENTRONS_PROTOCOL_LIBRARY_PATH: path.join(PLUGIN_ROOT, "bundled-library"), PLUGIN_DATA: path.join(target, ".plugin-data", "labscriptai-ot") },
  };
  atomicWrite(mcpFile, `${JSON.stringify(config, null, 2)}\n`);
  atomicWrite(ruleFile, rule);
  console.log(`Configured Cursor for ${target}\n  MCP:  ${mcpFile}\n  Rule: ${ruleFile}\n\nReload Cursor (Command Palette > Developer: Reload Window) to load the MCP server.`);
  console.log('First local-only prompt: "Help me author an Opentrons protocol for this project and validate it with local simulation only. Do not connect to a robot."');
}

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(HELP);
  } else if (args.length !== 1) {
    console.error(`${HELP}\n\nError: expected exactly one project directory${args.length ? `, got ${args.length} arguments` : ""}.`);
    process.exitCode = 1;
  } else {
    configure(args[0]);
  }
} catch (err) {
  console.error(`configure-cursor: ${err.message}`);
  process.exitCode = 1;
}
