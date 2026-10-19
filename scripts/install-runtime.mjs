#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = (command, args) => spawnSync(command, args, { cwd: root, stdio: "inherit" });
const uv = run("uv", ["sync", "--frozen", "--no-dev"]);
if (!uv.error) process.exit(uv.status ?? 1);
if (uv.error.code !== "ENOENT") throw uv.error;

// Use an existing supported Python when uv is unavailable; leave the system interpreter unchanged.
const candidates = process.platform === "win32"
  ? [["py", "-3"], ["python"], ["python3"]]
  : [["python3"], ["python"]];
const selected = candidates.find(([command, ...args]) => spawnSync(command, [...args, "-c",
  "import sys; sys.exit(0 if (3,11) <= sys.version_info[:2] < (3,14) else 1)",
], { stdio: "ignore" }).status === 0);
if (!selected) {
  console.error("Install uv or Python 3.11–3.13, then run the installer again.");
  process.exit(1);
}
const [command, ...args] = selected;
const created = run(command, [...args, "-m", "venv", ".venv"]);
if (created.status !== 0) process.exit(created.status ?? 1);
const python = path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const installed = run(python, ["-c", [
  "import subprocess, sys, tomllib",
  "with open('pyproject.toml', 'rb') as f: deps = tomllib.load(f)['project']['dependencies']",
  "subprocess.run([sys.executable, '-m', 'pip', 'install', *deps], check=True)",
].join("\n")]);
process.exit(installed.status ?? 1);
