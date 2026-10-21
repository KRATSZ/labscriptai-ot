import assert from "node:assert/strict";
import path from "path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "../../..");
const python = process.env.OPENTRONS_PYTHON || path.join(pluginRoot, ".venv/bin/python");
const bridge = path.join(pluginRoot, "servers/opentrons-mcp/scripts/logicpass_check.py");

function run(args) {
  return spawnSync(python, args, { encoding: "utf8" });
}

test("logicpass_check passes a clean transfer and fails a dry-well aspirate", () => {
  const good = run([bridge, path.join(here, "fixtures/logicpass/static_transfer_min.json"), "true"]);
  assert.equal(good.status, 0, good.stderr);
  const passed = JSON.parse(good.stdout);
  assert.equal(passed.outcome, "pass");
  assert.equal(passed.logic_pass, true);

  const bad = run([bridge, path.join(here, "fixtures/logicpass/dry_well_aspirate.json"), "true"]);
  assert.equal(bad.status, 0, bad.stderr);
  const failed = JSON.parse(bad.stdout);
  assert.equal(failed.outcome, "fail");
  assert.equal(failed.logic_pass, false);
  assert.ok(failed.issues.some((issue) => issue.code === "LP-L1" && issue.step_index != null));
});
