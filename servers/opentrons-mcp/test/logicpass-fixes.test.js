import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "../../..");
const python = path.join(pluginRoot, ".venv/bin/python");
const bridge = path.join(pluginRoot, "servers/opentrons-mcp/scripts/logicpass_check.py");
const entry = path.join(pluginRoot, "servers/opentrons-mcp/index.js");

import { buildLogicpassGateBlock } from "../lib/logicpass.js";
import { analyzeProtocolOnce } from "../lib/analyze-once.js";
import { TOOL_HANDLERS } from "../index.js";

function runBridge(args) {
  return spawnSync(python, [bridge, ...args], { encoding: "utf8" });
}

function writeTempAnalyze(overrides = {}) {
  const base = JSON.parse(
    fs.readFileSync(path.join(here, "fixtures/logicpass/static_transfer_min.json"), "utf8"),
  );
  const payload = { ...base, ...overrides };
  const file = path.join(os.tmpdir(), `logicpass-fixes-${crypto.randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify(payload));
  return file;
}

test("capacity: decimal labware names are parsed as whole numbers, not tail digits", () => {
  const file = writeTempAnalyze({
    labware: [
      {
        id: "labware-custom",
        loadName: "acme_6_wellplate_1.6ml_flat",
        location: { slotName: "B2" },
      },
    ],
    commands: [
      ...baseCommands(),
      {
        id: "cmd-load-liq2",
        commandType: "loadLiquid",
        status: "succeeded",
        params: {
          liquidId: "liquid-x",
          labwareId: "labware-custom",
          volumeByWell: { A1: 100.0 },
        },
      },
      {
        id: "cmd-disp-5ml",
        commandType: "dispense",
        status: "succeeded",
        params: {
          pipetteId: "pipette-left",
          labwareId: "labware-custom",
          wellName: "A1",
          volume: 5000.0,
        },
      },
    ],
  });
  const run = runBridge([file, "true"]);
  assert.equal(run.status, 0, run.stderr);
  const verdict = JSON.parse(run.stdout);
  assert.equal(verdict.outcome, "fail", "5 mL into a 1.6 mL well must fail LP-L4");
  assert.equal(verdict.final_pass_v2, false);
  assert.ok(verdict.issues.some((issue) => issue.code === "LP-L4" && /5000/.test(issue.detail_text)));
  const custom = verdict.capacity_sources["labware-custom"];
  assert.equal(custom.source, "name_hint");
  assert.equal(custom.guessed, true);
  assert.equal(custom.max_ul, 1600, "1.6ml must infer 1600 µL, not 6000");
  assert.ok(verdict.guessed_capacity_labware.includes("acme_6_wellplate_1.6ml_flat"));
  assert.ok(/猜/.test(verdict.capacity_note));
});

test("capacity: installed definitions win and are not marked as guesses", () => {
  const file = path.join(here, "fixtures/logicpass/static_transfer_min.json");
  const run = runBridge([file, "true"]);
  assert.equal(run.status, 0, run.stderr);
  const verdict = JSON.parse(run.stdout);
  const reservoir = verdict.capacity_sources["labware-res"];
  assert.equal(reservoir.source, "definition");
  assert.equal(reservoir.guessed, false);
  assert.equal(reservoir.max_ul, 290000, "nest_1_reservoir_290ml definition well volume");
  assert.deepEqual(verdict.guessed_capacity_labware, []);
  assert.equal(verdict.capacity_note, "");
});

function baseCommands() {
  const base = JSON.parse(
    fs.readFileSync(path.join(here, "fixtures/logicpass/static_transfer_min.json"), "utf8"),
  );
  return base.commands;
}

test("gate: final_pass_v2=true passes, fail and unevaluable block with reasons", () => {
  const passing = buildLogicpassGateBlock({
    verdict: { outcome: "pass", final_pass_v2: true, logic_pass: true, issues: [] },
  });
  assert.equal(passing.blocked, false);

  const failing = buildLogicpassGateBlock({
    verdict: {
      outcome: "fail",
      final_pass_v2: false,
      logic_pass: false,
      issues: [{ code: "LP-L4", detail_text: "Step 11: dispense 5000 µL into labware-custom:A1" }],
      analyze: { ok: true, reason: "" },
    },
  });
  assert.equal(failing.blocked, true);
  assert.match(failing.error.message, /outcome=fail/);
  assert.match(failing.error.message, /LP-L4/);
  assert.equal(failing.error.toolContext.data.gate_stage, "logicpass_check");
  assert.equal(failing.error.toolContext.data.blocked_real_execution, true);

  const broken = buildLogicpassGateBlock({
    verdict: null,
    gateError: "没有可用的 Python，跑不了 LogicPass",
  });
  assert.equal(broken.blocked, true);
  assert.match(broken.error.message, /没有可用的 Python/);
  assert.equal(broken.error.toolContext.data.logicpass_gate.outcome, "unevaluable");
});

test("logicpass_check surfaces analyze failure reasons instead of a bare failure", async () => {
  const analysisWithErrors = path.join(
    os.tmpdir(),
    `logicpass-analyze-err-${crypto.randomUUID()}.json`,
  );
  fs.writeFileSync(
    analysisWithErrors,
    JSON.stringify({
      createdAt: "2026-10-13T00:00:00.000000+00:00",
      config: { apiLevel: "2.22", robotType: "OT-3 Standard" },
      commands: [],
      errors: [
        { detail: "NameError [line 12]: name 'get_values' is not defined", errorType: "ExceptionInProtocolError" },
      ],
    }),
  );
  const result = await TOOL_HANDLERS.logicpass_check({ analysis_path: analysisWithErrors });
  const data = result.data;
  assert.equal(data.analyze.ok, false);
  assert.match(data.analyze.reason, /NameError/);
  assert.equal(data.final_pass_v2, false, "failed analyze must never pass the combined gate");
  assert.notEqual(data.analyze.reason, "analysis JSON has errors");
});

test("stale analyze cache self-heals when the analysis JSON was deleted", { timeout: 60000 }, async () => {
  const protocol = path.join(os.tmpdir(), `stale-cache-${crypto.randomUUID()}.py`);
  fs.writeFileSync(
    protocol,
    [
      "metadata = {'protocolName': 'stale-cache-probe'}",
      "requirements = {'robotType': 'Flex', 'apiLevel': '2.24'}",
      "def run(context):",
      "    context.load_trash_bin('A3')",
      "    tips = context.load_labware('opentrons_flex_96_tiprack_1000ul', 'B1')",
      "    pipette = context.load_instrument('flex_1channel_1000', 'left')",
      "    reservoir = context.load_labware('nest_1_reservoir_290ml', 'D2')",
      "    pipette.pick_up_tip(tips['A1'])",
      "    pipette.aspirate(100, reservoir['A1'])",
      "    pipette.drop_tip()",
    ].join("\n"),
  );
  // Seed a lying cache entry: meta says ok, but the analysis JSON is gone.
  const hash = crypto.createHash("sha256").update(fs.readFileSync(protocol)).digest("hex").slice(0, 20);
  const cacheDir = path.join(pluginRoot, ".plugin-data/artifacts/analyze-cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const metaPath = path.join(cacheDir, `${hash}.meta.json`);
  fs.writeFileSync(
    metaPath,
    JSON.stringify({
      ok: true,
      analysis_path: path.join(cacheDir, `${hash}.analysis.json`),
      analysis_cached: true,
      robot_type: "OT-3 Standard",
      error_count: 0,
    }),
  );
  try {
    const first = await analyzeProtocolOnce({ protocol_path: protocol });
    assert.equal(first.ok, true, "stale meta must not be trusted; a fresh analyze must run");
    assert.equal(first.analysis_cached, false);
  } finally {
    fs.rmSync(protocol, { force: true });
    fs.rmSync(metaPath, { force: true });
    fs.rmSync(path.join(cacheDir, `${hash}.analysis.json`), { force: true });
  }
});

test("server starts through a symlinked plugin path instead of exiting silently", { timeout: 30000 }, async () => {
  const link = path.join(os.tmpdir(), `labscriptai-ot-symlink-${process.pid}`);
  fs.rmSync(link, { force: true });
  fs.symlinkSync(pluginRoot, link, "dir");
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(link, "servers/opentrons-mcp/index.js")], {
        stdio: ["pipe", "ignore", "pipe"],
      });
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`server did not announce startup via symlink path; stderr=${stderr}`));
      }, 15000);
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
        if (stderr.includes("Opentrons Lab MCP server running on stdio")) {
          clearTimeout(timer);
          child.kill("SIGKILL");
          resolve();
        }
      });
      child.on("exit", () => {
        clearTimeout(timer);
        reject(new Error(`server exited silently through symlink path; stderr=${stderr}`));
      });
    });
  } finally {
    fs.rmSync(link, { force: true });
  }
});