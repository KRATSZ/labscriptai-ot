#!/usr/bin/env node
/**
 * Basic consistency check across Claude, Codex, and Cursor plugin manifests.
 * Usage: node scripts/lint-manifests.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const MANIFESTS = {
  claude: path.join(ROOT, ".claude-plugin/plugin.json"),
  codex: path.join(ROOT, ".codex-plugin/plugin.json"),
  cursor: path.join(ROOT, ".cursor-plugin/plugin.json"),
};

const REQUIRED_INTERFACE = ["displayName", "shortDescription", "defaultPrompt", "postInstallMessage"];
const EXPECTED_PROMPTS = [
  "Help me design a Flex liquid-handling experiment from scratch — review intent first, then write and simulate the protocol",
  "Check whether this Opentrons protocol can pass local simulation safely",
  "What state is the robot in? Run safety checks before any recovery action",
];

let errors = 0;

function err(msg) {
  console.error(`✗ ${msg}`);
  errors += 1;
}

function ok(msg) {
  console.log(`✓ ${msg}`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

const loaded = {};
for (const [name, file] of Object.entries(MANIFESTS)) {
  if (!fs.existsSync(file)) {
    err(`Missing manifest: ${file}`);
    continue;
  }
  loaded[name] = readJson(file);
  ok(`Found ${name} manifest`);
}

const versions = new Set(Object.values(loaded).map((m) => m.version).filter(Boolean));
if (versions.size > 1) {
  err(`Version mismatch: ${[...versions].join(", ")}`);
} else if (versions.size === 1) {
  ok(`Version aligned: ${[...versions][0]}`);
}

const names = new Set(Object.values(loaded).map((m) => m.name).filter(Boolean));
if (names.size > 1) {
  err(`Name mismatch: ${[...names].join(", ")}`);
} else {
  ok(`Name aligned: ${[...names][0]}`);
}

for (const [platform, manifest] of Object.entries(loaded)) {
  const iface = manifest.interface || {};
  for (const field of REQUIRED_INTERFACE) {
    if (iface[field] === undefined || iface[field] === null || iface[field] === "") {
      err(`${platform}: interface.${field} missing`);
    }
  }

  const prompts = iface.defaultPrompt;
  if (!Array.isArray(prompts) || prompts.length !== 3) {
    err(`${platform}: interface.defaultPrompt must be an array of 3 prompts`);
  } else if (JSON.stringify(prompts) !== JSON.stringify(EXPECTED_PROMPTS)) {
    err(`${platform}: defaultPrompt text differs from canonical set`);
  } else {
    ok(`${platform}: defaultPrompt aligned`);
  }

  if (iface.postInstallMessage && !String(iface.postInstallMessage).includes("GETTING_STARTED")) {
    err(`${platform}: postInstallMessage should reference GETTING_STARTED`);
  } else if (iface.postInstallMessage) {
    ok(`${platform}: postInstallMessage present`);
  }
}

console.log("");
if (errors > 0) {
  console.error(`lint-manifests: ${errors} error(s)`);
  process.exit(1);
}
console.log("lint-manifests: all checks passed");
process.exit(0);
