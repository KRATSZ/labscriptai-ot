#!/usr/bin/env node
/**
 * Merge LabscriptAI OT Stop hooks into ~/.codex/hooks.json (idempotent).
 */
import fs from "fs";
import path from "path";

function parseArgs(argv) {
  const args = { plugin_root: null, source: null, target: null, merge: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--plugin-root") {
      args.plugin_root = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--source") {
      args.source = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--target") {
      args.target = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--merge") {
      args.merge = true;
    }
  }
  return args;
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function rewriteCommands(node, pluginRoot) {
  if (Array.isArray(node)) {
    return node.map(item => rewriteCommands(item, pluginRoot));
  }
  if (node && typeof node === "object") {
    const next = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "command" && typeof value === "string") {
        next[key] = value
          .replace(/\$\{PLUGIN_ROOT\}/g, pluginRoot)
          .replace(/\$\{OPENTRONS_PLUGIN_ROOT\}/g, pluginRoot)
          .replace(/cd "\$\{PLUGIN_ROOT\}"/g, `cd "${pluginRoot}"`)
          .replace(/PLUGIN_DATA="\$\{PLUGIN_DATA\}"/g, `PLUGIN_DATA="${path.join(pluginRoot, ".plugin-data")}"`);
      } else {
        next[key] = rewriteCommands(value, pluginRoot);
      }
    }
    return next;
  }
  return node;
}

function mergeHooks(target, source) {
  const out = { ...target };
  out.hooks = { ...(target.hooks || {}) };
  for (const [eventName, entries] of Object.entries(source.hooks || {})) {
    const existing = Array.isArray(out.hooks[eventName]) ? out.hooks[eventName] : [];
    const incoming = Array.isArray(entries) ? entries : [];
    const marker = "consume-runtime-outbox.mjs --host codex";
    const filtered = existing.filter(entry => {
      const text = JSON.stringify(entry);
      return !text.includes(marker);
    });
    out.hooks[eventName] = [...filtered, ...incoming];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.plugin_root || !args.source || !args.target) {
  console.error("usage: install-codex-hooks.mjs --plugin-root PATH --source hooks/codex/hooks.json --target ~/.codex/hooks.json --merge");
  process.exit(1);
}

const source = rewriteCommands(readJson(path.resolve(args.source), { hooks: {} }), path.resolve(args.plugin_root));
const target = readJson(path.resolve(args.target), { hooks: {} });
const merged = args.merge ? mergeHooks(target, source) : source;

fs.mkdirSync(path.dirname(path.resolve(args.target)), { recursive: true });
fs.writeFileSync(path.resolve(args.target), `${JSON.stringify(merged, null, 2)}\n`);
console.log(`Wrote ${args.target}`);
