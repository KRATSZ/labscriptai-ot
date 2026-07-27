import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import {
  loadAutomationEnvValue,
  parseAutomationEnvLine,
  resolveAutomationEnvPath,
} from "../lib/automation-env.js";

test("parseAutomationEnvLine supports KEY=value format", () => {
  assert.deepEqual(parseAutomationEnvLine("ARK_API_KEY=ark-test"), {
    key: "ARK_API_KEY",
    value: "ark-test",
  });
});

test("parseAutomationEnvLine supports KEY: value format", () => {
  assert.deepEqual(parseAutomationEnvLine("ARK_API_KEY: ark-test"), {
    key: "ARK_API_KEY",
    value: "ark-test",
  });
});

test("loadAutomationEnvValue reads colon format from automation env file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automation-env-"));
  const envPath = path.join(dir, ".env");
  fs.writeFileSync(
    envPath,
    "IP address: 10.31.17.153\nARK_API_KEY: ark-from-automation\n",
    "utf8"
  );

  const original = process.env.ARK_API_KEY;
  delete process.env.ARK_API_KEY;
  try {
    assert.equal(
      loadAutomationEnvValue("ARK_API_KEY", { envFilePath: envPath }),
      "ark-from-automation"
    );
  } finally {
    if (original) {
      process.env.ARK_API_KEY = original;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveAutomationEnvPath points at automation/.env under plugin root", () => {
  const resolved = resolveAutomationEnvPath();
  assert.match(resolved, /automation[\\/]\.env$/);
});
