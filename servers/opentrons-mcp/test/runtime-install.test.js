import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import {
  READY_MARKER,
  cachedNodeModules,
  cachedPython,
  dataHome,
  readReadyMarker,
  runtimePaths,
  writeReadyMarker,
} from "../../../scripts/runtime-paths.mjs";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const lock = (version = "1.17.5") => ({
  name: "opentrons-lab-mcp",
  version: "0.1.1",
  lockfileVersion: 3,
  requires: true,
  packages: {
    "": { name: "opentrons-lab-mcp", version: "0.1.1", dependencies: { "@modelcontextprotocol/sdk": "^1.17.5" } },
    "node_modules/@modelcontextprotocol/sdk": { version },
  },
});

function temp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `labscriptai-${prefix}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fixture(t, options = {}) {
  const root = temp(t, "plugin");
  fs.mkdirSync(path.join(root, "servers", "opentrons-mcp"), { recursive: true });
  fs.writeFileSync(path.join(root, "requirements.lock"), options.requirements || "opentrons==9.0.0 --hash=sha256:test\n");
  fs.writeFileSync(path.join(root, "servers", "opentrons-mcp", "package-lock.json"), JSON.stringify(options.lock || lock()));
  fs.writeFileSync(path.join(root, "servers", "opentrons-mcp", "package.json"), JSON.stringify({
    name: "opentrons-lab-mcp", version: options.version || "0.1.1", type: "module",
  }));
  return root;
}

function fakeSdk(nodeModules, source) {
  const sdk = path.join(nodeModules, "@modelcontextprotocol", "sdk");
  fs.mkdirSync(path.join(sdk, "server"), { recursive: true });
  fs.writeFileSync(path.join(sdk, "package.json"), JSON.stringify({ name: "@modelcontextprotocol/sdk", version: "1.17.5", type: "module" }));
  fs.writeFileSync(path.join(sdk, "server", "index.js"), `export class Server { static source = ${JSON.stringify(source)}; }\n`);
  fs.writeFileSync(path.join(sdk, "server", "stdio.js"), "export class StdioServerTransport {}\n");
  fs.writeFileSync(path.join(sdk, "types.js"), "export const CallToolRequestSchema = {}; export const ListToolsRequestSchema = {};\n");
}

function copy(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function sdkFixture(t) {
  const root = fixture(t);
  copy(path.join(workspace, "scripts", "runtime-paths.mjs"), path.join(root, "scripts", "runtime-paths.mjs"));
  const loader = path.join(root, "servers", "opentrons-mcp", "lib", "sdk.js");
  copy(path.join(workspace, "servers", "opentrons-mcp", "lib", "sdk.js"), loader);
  return { root, loader };
}

function importSdk(loader, home) {
  const url = pathToFileURL(loader).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", [
    `const sdk = await import(${JSON.stringify(url)});`,
    "console.log(JSON.stringify({ source: sdk.Server.source, exports: Object.keys(sdk).sort() }));",
  ].join("\n")], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, LABSCRIPTAI_HOME: home },
  });
  return result;
}

test("dataHome follows platform conventions and ignores unresolved overrides", () => {
  assert.equal(dataHome({ LABSCRIPTAI_HOME: "/tmp/Labscript AI OT" }, "linux", "/home/me"), path.resolve("/tmp/Labscript AI OT"));
  assert.equal(dataHome({ LABSCRIPTAI_HOME: "${HOME}/runtime" }, "darwin", "/Users/me"), "/Users/me/Library/Application Support/labscriptai-ot");
  assert.equal(dataHome({}, "darwin", "/Users/me"), "/Users/me/Library/Application Support/labscriptai-ot");
  assert.equal(dataHome({ XDG_DATA_HOME: "/data/xdg" }, "linux", "/home/me"), "/data/xdg/labscriptai-ot");
  assert.equal(dataHome({}, "linux", "/home/me"), "/home/me/.local/share/labscriptai-ot");
  assert.equal(dataHome({ LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }, "win32", "C:\\Users\\me"), "C:\\Users\\me\\AppData\\Local\\labscriptai-ot");
  assert.equal(dataHome({}, "win32", "C:\\Users\\me"), "C:\\Users\\me\\AppData\\Local\\labscriptai-ot");
});

test("runtime keys ignore plugin path/version but follow dependency locks", (t) => {
  const first = fixture(t, { version: "0.1.1" });
  const second = fixture(t, { version: "9.9.9", lock: lock("1.99.0") });
  const env = { LABSCRIPTAI_HOME: temp(t, "home") };
  const a = runtimePaths(first, env);
  const b = runtimePaths(second, env);
  assert.notEqual(a.nodeKey, b.nodeKey);
  assert.equal(a.pythonKey, b.pythonKey);

  const renamed = fixture(t, { version: "9.9.9" });
  assert.equal(runtimePaths(first, env).nodeKey, runtimePaths(renamed, env).nodeKey);
  assert.match(a.nodeKey, new RegExp(`^node-${process.platform}-${process.arch}-node${process.versions.node.split(".")[0]}-`));
  assert.match(a.pythonKey, new RegExp(`^python-${process.platform}-${process.arch}-`));

  const changedNode = fixture(t, { lock: lock("2.0.0") });
  assert.notEqual(runtimePaths(first, env).nodeKey, runtimePaths(changedNode, env).nodeKey);
  const changedPython = fixture(t, { requirements: "opentrons==9.0.1 --hash=sha256:test\n" });
  assert.notEqual(runtimePaths(first, env).pythonKey, runtimePaths(changedPython, env).pythonKey);
  assert.match(a.pythonKey, /[a-f0-9]{20}$/);
});

test("runtime paths support spaces and keep runtimes inside the data home", (t) => {
  const root = fixture(t);
  const home = path.join(temp(t, "home"), "Labscript AI OT");
  const paths = runtimePaths(root, { LABSCRIPTAI_HOME: home });
  assert.equal(paths.home, home);
  for (const value of [paths.pythonDir, paths.nodeDir, paths.nodeModules, paths.python, paths.stateFile]) {
    assert.ok(value.startsWith(`${home}${path.sep}`), value);
  }
});

test("ready markers and cached runtimes reject incomplete or mismatched caches", (t) => {
  const root = fixture(t);
  const env = { LABSCRIPTAI_HOME: temp(t, "home") };
  const paths = runtimePaths(root, env);

  fakeSdk(paths.nodeModules, "cached");
  writeReadyMarker(paths.nodeDir, { kind: "node", key: paths.nodeKey });
  assert.equal(readReadyMarker(paths.nodeDir).ready, true);
  assert.equal(cachedNodeModules(root, env), paths.nodeModules);
  assert.equal(cachedPython(root, env), null);

  fs.writeFileSync(paths.stateFile, JSON.stringify({ nodeKey: "stale", python: "/wrong" }));
  assert.equal(cachedNodeModules(root, env), paths.nodeModules);

  fs.writeFileSync(path.join(paths.nodeDir, READY_MARKER), JSON.stringify({ ready: false, kind: "node", key: paths.nodeKey }));
  assert.equal(cachedNodeModules(root, env), null);
  fs.writeFileSync(path.join(paths.nodeDir, READY_MARKER), JSON.stringify({ ready: true, kind: "node", key: "wrong" }));
  assert.equal(cachedNodeModules(root, env), null);
  fs.writeFileSync(path.join(paths.nodeDir, READY_MARKER), JSON.stringify({ ready: true, kind: "python", key: paths.nodeKey }));
  assert.equal(cachedNodeModules(root, env), null);
  fs.writeFileSync(path.join(paths.nodeDir, READY_MARKER), JSON.stringify({ ready: true }));
  assert.equal(cachedNodeModules(root, env), null);
  fs.rmSync(path.join(paths.nodeModules, "@modelcontextprotocol", "sdk"), { recursive: true, force: true });
  assert.equal(cachedNodeModules(root, env), null);

  fs.mkdirSync(path.dirname(paths.python), { recursive: true });
  fs.writeFileSync(paths.python, "");
  writeReadyMarker(paths.pythonDir, { kind: "python", key: paths.pythonKey });
  assert.equal(cachedPython(root, env), paths.python);
  fs.rmSync(paths.python);
  assert.equal(cachedPython(root, env), null);
});

test("installer exits clearly when another install holds the home lock", (t) => {
  const home = temp(t, "home");
  fs.writeFileSync(path.join(home, ".install.lock"), "{}\n");
  const result = spawnSync(process.execPath, [path.join(workspace, "scripts", "install-runtime.mjs")], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, LABSCRIPTAI_HOME: home },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Another runtime install is running/);
  assert.equal(fs.existsSync(path.join(home, "runtime-state.json")), false);
});

test("SDK loader uses the keyed cache, falls back locally, and gives an actionable error", (t) => {
  const cached = sdkFixture(t);
  const home = temp(t, "home");
  const paths = runtimePaths(cached.root, { LABSCRIPTAI_HOME: home });
  fakeSdk(paths.nodeModules, "cached");
  writeReadyMarker(paths.nodeDir, { kind: "node", key: paths.nodeKey });
  const fromCache = importSdk(cached.loader, home);
  assert.equal(fromCache.status, 0, fromCache.stderr);
  assert.deepEqual(JSON.parse(fromCache.stdout), {
    source: "cached",
    exports: ["CallToolRequestSchema", "ListToolsRequestSchema", "Server", "StdioServerTransport"],
  });

  const local = sdkFixture(t);
  fakeSdk(path.join(local.root, "servers", "opentrons-mcp", "node_modules"), "local");
  const fallback = importSdk(local.loader, temp(t, "home"));
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.equal(JSON.parse(fallback.stdout).source, "local");

  const missing = sdkFixture(t);
  const failure = importSdk(missing.loader, temp(t, "home"));
  assert.notEqual(failure.status, 0);
  const missingRoot = fs.realpathSync(missing.root);
  assert.match(failure.stderr, new RegExp(`Plugin root: ${missingRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(failure.stderr, /install-runtime\.mjs/);
});
