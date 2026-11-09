import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TOOL_DEFINITIONS, TOOL_HANDLERS } from "../index.js";
import { normalizeBaseUrl, requestRobotJson } from "../lib/http.js";
import { robotConnectionPath, rememberRobotAddress, resolveRobotConnection, robotConnectionSummary } from "../lib/robot-connection.js";
import { dataHome } from "../../../scripts/runtime-paths.mjs";

let dir, originalFetch, originalEnv;
beforeEach(() => {
  originalEnv = { ...process.env };
  originalFetch = global.fetch;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "robot-connection-"));
  process.env.OPENTRONS_CONNECTION_FILE = path.join(dir, "robot-connection.json");
  delete process.env.OPENTRONS_HOST;
  delete process.env.OPENTRONS_PORT;
});
afterEach(() => {
  global.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  fs.rmSync(dir, { recursive: true, force: true });
});

function mockRobot() {
  const urls = [];
  global.fetch = async url => {
    urls.push(String(url));
    return new Response(JSON.stringify({ robotModel: "OT-3 Standard", serialNumber: "TEST" }), {
      headers: { "content-type": "application/json" },
    });
  };
  return urls;
}

test("first connection is saved and a new process reuses it without robot_ip", async () => {
  mockRobot();
  await TOOL_HANDLERS.health_check({ scope: "robot", robot_ip: "192.168.1.50" });
  assert.equal(JSON.parse(fs.readFileSync(robotConnectionPath())).robot_ip, "http://192.168.1.50:31950");
  const script = `
    import assert from 'node:assert/strict';
    import { TOOL_HANDLERS } from ${JSON.stringify(new URL("../index.js", import.meta.url).href)};
    global.fetch = async url => {
      assert.equal(String(url), 'http://192.168.1.50:31950/health');
      return new Response('{}', {headers: {'content-type': 'application/json'}});
    };
    const result = await TOOL_HANDLERS.health_check({scope: 'robot'});
    console.log(JSON.stringify(result.data));
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], { env: process.env, encoding: "utf8" });
  assert.deepEqual(JSON.parse(output).health, {});
});

test("explicit address overrides environment and saved connection; environment overrides saved", async () => {
  rememberRobotAddress("192.168.1.50");
  process.env.OPENTRONS_HOST = "192.168.1.60:32000";
  assert.equal(normalizeBaseUrl(), "http://192.168.1.60:32000");
  const urls = mockRobot();
  await TOOL_HANDLERS.health_check({ scope: "robot", robot_ip: "https://new-robot.local:444/" });
  assert.equal(urls[0], "https://new-robot.local:444/health");
  delete process.env.OPENTRONS_HOST;
  assert.equal(normalizeBaseUrl(), "https://new-robot.local:444");
  assert.equal(resolveRobotConnection().source, "saved");
});

test("failed connection does not replace the saved robot", async () => {
  rememberRobotAddress("192.168.1.50");
  global.fetch = async () => { throw new Error("ECONNREFUSED"); };
  await assert.rejects(() => TOOL_HANDLERS.health_check({ scope: "robot", robot_ip: "192.168.1.99" }), /ECONNREFUSED/);
  assert.equal(normalizeBaseUrl(), "http://192.168.1.50:31950");
});

test("robot status pins the saved address for all requests in the operation", async () => {
  rememberRobotAddress("192.168.1.50");
  const urls = mockRobot();
  await TOOL_HANDLERS.robot_status({ include_modules: false });
  assert.equal(urls.length, 5);
  assert.ok(urls.every(url => url.startsWith("http://192.168.1.50:31950/")));
});

test("full health reports configured address without making any robot requests", async () => {
  rememberRobotAddress("192.168.1.50");
  let calls = 0;
  global.fetch = async () => { calls++; throw new Error("Unexpected robot request"); };
  const result = await TOOL_HANDLERS.health_check({ scope: "full" });
  assert.equal(calls, 0);
  assert.equal(result.data.robot_connection.robot_ip, "http://192.168.1.50:31950");
  assert.equal(result.data.robot_connection.source, "saved");
  assert.equal(result.data.robot_connection.config_path, robotConnectionPath());
});

test("first use asks for an address only when none is configured", async () => {
  assert.equal(resolveRobotConnection(), null);
  await assert.rejects(() => TOOL_HANDLERS.health_check({ scope: "robot" }), /Provide robot_ip once/);
  assert.equal(fs.existsSync(robotConnectionPath()), false);
});

test("all advertised robot tools make robot_ip optional and explain persistence", () => {
  for (const tool of TOOL_DEFINITIONS.filter(tool => tool.inputSchema.properties?.robot_ip)) {
    assert.equal(tool.inputSchema.required?.includes("robot_ip") || false, false, tool.name);
    assert.match(tool.inputSchema.properties.robot_ip.description, /saved user connection/, tool.name);
  }
});

test("stable user storage is independent of plugin cache and experiment records", () => {
  delete process.env.OPENTRONS_CONNECTION_FILE;
  process.env.LABSCRIPTAI_HOME = dir;
  process.env.OPENTRONS_PLUGIN_ROOT = path.join(dir, "cache-v1");
  process.env.PLUGIN_DATA = path.join(dir, "experiment1");
  rememberRobotAddress("robot.local");
  process.env.OPENTRONS_PLUGIN_ROOT = path.join(dir, "cache-v2");
  process.env.PLUGIN_DATA = path.join(dir, "experiment2");
  assert.equal(robotConnectionPath(), path.join(dataHome(), "robot-connection.json"));
  assert.equal(normalizeBaseUrl(), "http://robot.local:31950");
});

test("invalid addresses are rejected; corrupt settings can be repaired by connecting explicitly", async () => {
  for (const address of ["", " ", "http://user:secret@robot.local", "http://robot.local/path", "ftp://robot.local"]) {
    assert.throws(() => normalizeBaseUrl(address));
  }
  fs.writeFileSync(robotConnectionPath(), "{invalid json");
  assert.match(robotConnectionSummary().error, /Cannot read saved robot connection/);
  mockRobot();
  await TOOL_HANDLERS.health_check({ scope: "robot", robot_ip: "192.168.1.50" });
  assert.equal(normalizeBaseUrl(), "http://192.168.1.50:31950");
});

test("explicit ports, full URLs and IPv6 normalize correctly", () => {
  assert.equal(normalizeBaseUrl("robot.local:80"), "http://robot.local");
  assert.equal(normalizeBaseUrl("https://robot.local/"), "https://robot.local");
  assert.equal(normalizeBaseUrl("[::1]"), "http://[::1]:31950");
  assert.equal(normalizeBaseUrl("[::1]:80"), "http://[::1]");
});

test("settings write failures do not make a completed robot action fail", async () => {
  const blocker = path.join(dir, "blocker");
  fs.writeFileSync(blocker, "file");
  process.env.OPENTRONS_CONNECTION_FILE = path.join(blocker, "robot-connection.json");
  const originalError = console.error;
  const warnings = [];
  console.error = message => warnings.push(message);
  try {
    mockRobot();
    const result = await requestRobotJson("POST", "192.168.1.50", "/runs/test/actions", { body: "{}" });
    assert.equal(result.serialNumber, "TEST");
    assert.match(warnings[0], /could not be saved/);
  } finally { console.error = originalError; }
});

test("MCP and Python LAN fallback share addresses in both directions", () => {
  rememberRobotAddress("https://robot.local:444");
  const script = `
import argparse, importlib.util, json, sys, types
stub = types.ModuleType('robot_run')
stub.TERMINAL_RUN_STATUSES = set()
sys.modules['robot_run'] = stub
spec = importlib.util.spec_from_file_location('robot_api', sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
config = module.resolve_config(argparse.Namespace(host=None, port=None, token=None, timeout=None))
assert config.base_url == 'https://robot.local:444', config.base_url
module.save_connection_config('192.168.1.80', 32000, None)
print(json.dumps({'read': config.base_url, 'path': str(module.connection_config_path())}))
`;
  const python = process.env.OPENTRONS_PYTHON || (process.platform === "win32" ? "python" : "python3");
  const file = new URL("../../../skills/opentrons-robot-lan/scripts/opentrons_robot_api.py", import.meta.url);
  const result = JSON.parse(execFileSync(python, ["-c", script, fileURLToPath(file)], { env: process.env, encoding: "utf8" }));
  assert.equal(result.path, robotConnectionPath());
  assert.equal(normalizeBaseUrl(), "http://192.168.1.80:32000");
});
