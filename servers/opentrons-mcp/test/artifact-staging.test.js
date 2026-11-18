import test from "node:test";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createArtifactStage, cleanUnusedStages } from "../lib/artifact-staging.js";

test("unused stages are removed while generated files and consumed paths remain intact", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "OT staging 中文 "));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const empty = createArtifactStage(root, "empty-");
  const generated = createArtifactStage(root, "generated-");
  const consumed = createArtifactStage(root, "consumed-");
  fs.writeFileSync(path.join(generated, "keep.json"), '{"keep":true}');
  const published = path.join(root, "published");
  fs.renameSync(consumed, published);
  cleanUnusedStages([empty, generated, consumed]);
  assert.equal(fs.existsSync(empty), false);
  assert.equal(fs.readFileSync(path.join(generated, "keep.json"), "utf8"), '{"keep":true}');
  assert.ok(fs.existsSync(published));
});

test("a blocked Windows figure output remains a nonblocking companion failure", {skip: process.platform !== "win32"}, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "OT blocked figure "));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const module = new URL("../lib/experiment-figure.js", import.meta.url).href;
  const source = `import fs from 'node:fs';import path from 'node:path';import {generateExperimentFigure,FIGURE_DIR} from ${JSON.stringify(module)};fs.mkdirSync(path.dirname(FIGURE_DIR),{recursive:true});fs.writeFileSync(FIGURE_DIR,'blocked');const result=await generateExperimentFigure({analysisPath:path.join(process.env.PLUGIN_DATA,'analysis.json')});console.log(JSON.stringify(result))`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    env: {...process.env, PLUGIN_DATA: root, LABSCRIPTAI_INHERIT_PRIVATE_ACL: "1"}, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const figure = JSON.parse(result.stdout);
  assert.equal(figure.ok, false);
  assert.equal(figure.error, "figure_generation_failed");
});
