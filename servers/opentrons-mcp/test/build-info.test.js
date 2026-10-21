import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('health identifies loaded code when configured root points to an older copy', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-plugin-root-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.mkdirSync(path.join(tmp, 'servers/opentrons-mcp'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'servers/opentrons-mcp/package.json'), JSON.stringify({ version: '0.0.0' }));
  fs.writeFileSync(path.join(tmp, 'build-info.json'), JSON.stringify({ version: '0.0.0', build_id: 'old-copy' }));
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const moduleUrl = pathToFileURL(path.join(root, 'servers/opentrons-mcp/lib/health-check.js')).href;
  const code = `import {buildHealthCheck} from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(buildHealthCheck().mcp_server));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8', env: { ...process.env, OPENTRONS_PLUGIN_ROOT: tmp, PLUGIN_DATA: path.join(tmp, 'data') },
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.version, JSON.parse(fs.readFileSync(path.join(root, 'servers/opentrons-mcp/package.json'))).version);
  assert.notEqual(report.build_id, 'old-copy');
  assert.equal(report.plugin_root, fs.realpathSync(root));
  assert.equal(report.configured_root, fs.realpathSync(tmp));
  assert.equal(report.configuration_matches_loaded_code, false);
  assert.match(report.configuration_hint, /reload MCP/);
});
