import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { TOOL_HANDLERS } from "../index.js";
import { buildHealthCheck, checkRobotHealth } from "../lib/health-check.js";

describe("health_check", () => {
  it("returns a structured report without robot_ip", () => {
    const report = buildHealthCheck({});
    assert.ok(report.timestamp);
    assert.equal(report.mcp_server.status, "ok");
    assert.equal(report.mcp_server.capabilities.runtime_build, "liquid-source-map-v2");
    assert.equal(report.mcp_server.capabilities.liquid_not_found_classification, true);
    assert.equal(report.mcp_server.capabilities.liquid_source_map_readback, true);
    assert.equal(report.mcp_server.capabilities.liquid_expected_absent_mismatch, true);
    assert.equal(report.mcp_server.capabilities.virtual_lab_state_validation, true);
    assert.ok(report.venv);
    assert.ok(report.git);
    assert.ok(report.session);
    // In CI or fresh checkout venv may not exist, just check structure
    assert.ok(["ok", "missing", "broken"].includes(report.venv.status));
  });

  it("detects venv and opentrons if present", () => {
    const report = buildHealthCheck({});
    // If venv exists (real dev environment), check for python version
    if (report.venv.status === "ok") {
      assert.ok(report.venv.python);
      assert.ok(
        report.venv.opentrons || report.venv.opentrons === "not_installed"
      );
    }
  });

  it("detects git branch", () => {
    const report = buildHealthCheck({});
    if (report.git.branch) {
      assert.ok(typeof report.git.branch === "string");
      assert.equal(typeof report.git.uncommitted_changes, "number");
    }
  });

  it("handler reports required runtime tool availability", async () => {
    const result = await TOOL_HANDLERS.health_check({});
    const tools = result.data.mcp_server.required_runtime_tools;
    assert.equal(tools.all_present, true);
    assert.equal(tools.missing.length, 0);
    assert.ok(tools.tool_count >= tools.required.length);
    assert.ok(tools.present.includes("runtime_recovery_self_test"));
    assert.ok(tools.present.includes("validate_virtual_lab_state_steps"));
    assert.ok(tools.present.includes("list_recovery_playbooks"));
    assert.ok(tools.present.includes("live_liquid_recovery_gate"));
    assert.ok(tools.present.includes("safe_next_action"));
    assert.match(result.data.mcp_server.entrypoint, /servers\/opentrons-mcp\/index\.js$/);
  });

  it("accepts robot_ip values with an explicit port", async () => {
    const originalFetch = global.fetch;
    global.fetch = async (url, options = {}) => {
      assert.equal(options.headers["Opentrons-Version"], "4");
      assert.match(String(url), /http:\/\/10\.31\.2\.149:31950\/health$/);
      return new Response(JSON.stringify({ robotModel: "OT-3 Standard", serialNumber: "FLX-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    try {
      const report = await checkRobotHealth("10.31.2.149:31950");
      assert.equal(report.status, "reachable");
      assert.equal(report.ip, "10.31.2.149:31950");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("respects python_executable override for local runtime inspection", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "health-check-python-"));
    const fakePython = path.join(dir, "python");
    fs.writeFileSync(
      fakePython,
      [
        "#!/bin/sh",
        'case "$2" in',
        '  *"import sys; print(sys.version.split()[0])"*) echo "3.12.0" ;;',
        '  *"import opentrons; print(opentrons.__version__)"*) echo "9.9.9" ;;',
        "  *) exit 1 ;;",
        "esac",
        "",
      ].join("\n"),
    );
    fs.chmodSync(fakePython, 0o755);

    const report = buildHealthCheck({ python_executable: fakePython });
    assert.equal(report.venv.python_executable, fakePython);
    assert.equal(report.venv.status, "ok");
    assert.equal(report.venv.opentrons, "9.9.9");
  });

  it("accepts python_executable commands resolved from PATH", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "health-check-path-python-"));
    const commandName = "fake-opentrons-python";
    const fakePython = path.join(dir, commandName);
    fs.writeFileSync(
      fakePython,
      [
        "#!/bin/sh",
        'case "$2" in',
        '  *"import sys; print(sys.version.split()[0])"*) echo "3.11.8" ;;',
        '  *"import opentrons; print(opentrons.__version__)"*) echo "8.5.0" ;;',
        "  *) exit 1 ;;",
        "esac",
        "",
      ].join("\n"),
    );
    fs.chmodSync(fakePython, 0o755);

    const originalPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${originalPath || ""}`;
    try {
      const report = buildHealthCheck({ python_executable: commandName });
      assert.equal(report.venv.python_executable, commandName);
      assert.equal(report.venv.status, "ok");
      assert.equal(report.venv.python, "3.11.8");
      assert.equal(report.venv.opentrons, "8.5.0");
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
