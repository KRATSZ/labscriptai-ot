import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(TEST_DIR, "..", "..", "..");
const HELPER = path.join(PLUGIN_ROOT, "scripts", "configure-cursor.mjs");
const SERVER_PATH = path.join(PLUGIN_ROOT, "servers", "opentrons-mcp", "index.js");
const LIBRARY_PATH = path.join(PLUGIN_ROOT, "bundled-library");
const AGENTS_PATH = path.join(PLUGIN_ROOT, "AGENTS.md");

function makeProject(t, label) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), `labscriptai cursor ${label}-`));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  return project;
}

function runHelper(args, cwd = PLUGIN_ROOT) {
  return spawnSync(process.execPath, [HELPER, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 20_000,
  });
}

function mcpPath(project) {
  return path.join(project, ".cursor", "mcp.json");
}

function rulePath(project) {
  return path.join(project, ".cursor", "rules", "labscriptai-ot.mdc");
}

function expectedServer(project) {
  return {
    command: process.execPath,
    args: [SERVER_PATH],
    env: {
      OPENTRONS_PLUGIN_ROOT: PLUGIN_ROOT,
      OPENTRONS_PROTOCOL_LIBRARY_PATH: LIBRARY_PATH,
      PLUGIN_DATA: path.join(project, ".plugin-data", "labscriptai-ot"),
    },
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function tempArtifacts(project) {
  const found = [];
  const walk = directory => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.name.includes(".tmp-")) found.push(fullPath);
    }
  };
  walk(project);
  return found;
}

test("fresh project with spaces gets absolute local-only Cursor files", t => {
  const project = makeProject(t, "fresh project");
  assert.ok(project.includes(" "), "test project path must contain spaces");
  const result = runHelper([project], project);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Configured Cursor/);
  assert.match(result.stdout, /Reload Cursor/);
  assert.match(result.stdout, /local-only prompt/i);

  const config = readJson(mcpPath(project));
  assert.deepEqual(config, { mcpServers: { "opentrons-lab": expectedServer(project) } });
  const server = config.mcpServers["opentrons-lab"];
  assert.equal(server.command, process.execPath);
  assert.ok(path.isAbsolute(server.args[0]));
  assert.ok(path.isAbsolute(server.env.OPENTRONS_PLUGIN_ROOT));
  assert.ok(path.isAbsolute(server.env.OPENTRONS_PROTOCOL_LIBRARY_PATH));
  assert.ok(path.isAbsolute(server.env.PLUGIN_DATA));
  assert.doesNotMatch(fs.readFileSync(mcpPath(project), "utf8"), /\$\{workspaceFolder\}/);

  const rule = fs.readFileSync(rulePath(project), "utf8");
  assert.match(rule, /^---\ndescription: .+\nalwaysApply: false\n---\n/);
  assert.match(rule, /labscriptai-ot:managed/);
  assert.ok(rule.includes(`\`${AGENTS_PATH}\``));
  assert.match(rule, /opt-in only/);
  assert.match(rule, /local simulation before unattended live execution/);
  assert.match(rule, /plain language/i);
  assert.doesNotMatch(rule, /\]\((?:\.\/|\.\.\/|\/)?(?:docs|skills|rules|policy)\//);

  const skillRoot = path.join(PLUGIN_ROOT, "skills");
  const skills = fs.readdirSync(skillRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && fs.existsSync(path.join(skillRoot, entry.name, "SKILL.md")))
    .map(entry => path.join(skillRoot, entry.name, "SKILL.md"));
  assert.ok(skills.length > 0);
  for (const skill of skills) assert.ok(rule.includes(`\`${skill}\``), `rule is missing ${skill}`);

  assert.deepEqual(tempArtifacts(project), []);
});

test("existing unrelated config and servers are preserved", t => {
  const project = makeProject(t, "preserve");
  const file = mcpPath(project);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = {
    theme: "dark",
    mcpServers: {
      "other-server": {
        command: "python3",
        args: ["server.py"],
        env: { TOKEN: "keep" },
        custom: { nested: true },
      },
      "opentrons-lab": {
        command: "old-node",
        args: ["old.js"],
        env: { OLD: "1" },
        disabled: true,
      },
    },
    extra: { keep: [1, 2, 3] },
  };
  fs.writeFileSync(file, `\uFEFF${JSON.stringify(existing, null, 2)}\n`);

  const result = runHelper([project], project);
  assert.equal(result.status, 0, result.stderr);

  const config = readJson(file);
  assert.equal(config.theme, "dark");
  assert.deepEqual(config.extra, existing.extra);
  assert.deepEqual(config.mcpServers["other-server"], existing.mcpServers["other-server"]);
  assert.deepEqual(config.mcpServers["opentrons-lab"], expectedServer(project));
});

test("running twice is byte-for-byte idempotent", t => {
  const project = makeProject(t, "twice");
  const first = runHelper([project], project);
  assert.equal(first.status, 0, first.stderr);
  const firstConfig = fs.readFileSync(mcpPath(project), "utf8");
  const firstRule = fs.readFileSync(rulePath(project), "utf8");

  const second = runHelper([project], project);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(fs.readFileSync(mcpPath(project), "utf8"), firstConfig);
  assert.equal(fs.readFileSync(rulePath(project), "utf8"), firstRule);
  assert.deepEqual(tempArtifacts(project), []);
});

test("invalid JSON is refused without changing or creating files", t => {
  const project = makeProject(t, "invalid json");
  const file = mcpPath(project);
  const original = '{ "mcpServers": {';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, original);

  const result = runHelper([project], project);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid JSON/i);
  assert.match(result.stderr, /Nothing was changed/i);
  assert.equal(fs.readFileSync(file, "utf8"), original);
  assert.equal(fs.existsSync(rulePath(project)), false);
  assert.equal(fs.existsSync(path.join(project, ".cursor", "rules")), false);
  assert.deepEqual(tempArtifacts(project), []);
});

test("non-object mcpServers is refused without changing or creating files", t => {
  const project = makeProject(t, "bad servers");
  const file = mcpPath(project);
  const original = `${JSON.stringify({ theme: "light", mcpServers: [] }, null, 2)}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, original);

  const result = runHelper([project], project);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /non-object "mcpServers"/);
  assert.equal(fs.readFileSync(file, "utf8"), original);
  assert.equal(fs.existsSync(rulePath(project)), false);
  assert.equal(fs.existsSync(path.join(project, ".cursor", "rules")), false);
});

test("a foreign same-named rule is not clobbered", t => {
  const project = makeProject(t, "foreign rule");
  const file = mcpPath(project);
  const foreignRule = "# My own rule\n\nKeep me exactly as written.\n";
  const otherRule = "# Other rule\n";
  const originalConfig = `${JSON.stringify({ mcpServers: { "other-server": { command: "other" } } }, null, 2)}\n`;
  fs.mkdirSync(path.dirname(rulePath(project)), { recursive: true });
  fs.writeFileSync(rulePath(project), foreignRule);
  fs.writeFileSync(path.join(path.dirname(rulePath(project)), "other.mdc"), otherRule);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, originalConfig);

  const result = runHelper([project], project);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refusing to overwrite/i);
  assert.match(result.stderr, /not managed by this plugin/i);
  assert.equal(fs.readFileSync(rulePath(project), "utf8"), foreignRule);
  assert.equal(fs.readFileSync(path.join(path.dirname(rulePath(project)), "other.mdc"), "utf8"), otherRule);
  assert.equal(fs.readFileSync(file, "utf8"), originalConfig);
  assert.deepEqual(tempArtifacts(project), []);
});

test("missing project argument fails with actionable usage", () => {
  const result = runHelper([], PLUGIN_ROOT);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage:/);
  assert.match(result.stderr, /configure-cursor\.mjs/);
  assert.match(result.stderr, /expected exactly one project directory/);
});

test("--help explains usage", () => {
  const result = runHelper(["--help"], PLUGIN_ROOT);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /\.cursor\/mcp\.json/);
  assert.match(result.stdout, /No robot or global changes/);
});

test("nonexistent target directory fails cleanly", t => {
  const project = makeProject(t, "missing target");
  const missing = path.join(project, "missing project");
  const result = runHelper([missing], project);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not an existing directory/);
  assert.equal(fs.existsSync(path.join(missing, ".cursor")), false);
});
