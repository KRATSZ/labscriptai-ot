// End-to-end test of an installed bundle, through its public stdio MCP interface.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const env = { ...process.env, OPENTRONS_PLUGIN_ROOT: root };
delete env.OPENTRONS_PYTHON;
delete env.OPENTRONS_OT2_PYTHON;
delete env.PLUGIN_DATA;
delete env.OPENTRONS_PLUGIN_DATA;
const child = spawn(process.execPath, [path.join(root, 'servers/opentrons-mcp/index.js')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
let buffer = '', stderr = '', serial = 0;
const pending = new Map();
child.stderr.on('data', part => { stderr += part; });
child.on('exit', () => { for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(`MCP exited: ${stderr}`)); } pending.clear(); });
child.stdout.on('data', part => {
  buffer += part;
  for (;;) {
    const end = buffer.indexOf('\n');
    if (end < 0) break;
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    const waiter = pending.get(message.id);
    if (waiter) { pending.delete(message.id); clearTimeout(waiter.timer); waiter.resolve(message); }
  }
});
function request(method, params) {
  const id = ++serial;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out; ${stderr}`)); }, 90000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
async function call(name, args = {}) {
  const reply = await request('tools/call', { name, arguments: args });
  assert.ok(!reply.error, JSON.stringify(reply));
  const payload = JSON.parse(reply.result.content.find(item => item.type === 'text').text);
  assert.equal(payload.success, true, JSON.stringify(payload));
  return payload.data;
}
const report = {};
let port;
try {
  const init = await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'release-smoke', version: '1' } });
  const version = JSON.parse(fs.readFileSync(path.join(root, '.codex-plugin/plugin.json'))).version;
  assert.equal(init.result.serverInfo.version, version);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const list = await request('tools/list', {});
  report.tools = list.result.tools.length;
  const tools = new Map(list.result.tools.map(tool => [tool.name, tool.inputSchema]));
  assert.equal(tools.get('simulate_protocol')?.properties.analysis_only?.type, 'boolean');
  assert.equal(tools.get('run_protocol')?.properties.return_after_prepare?.type, 'boolean');
  assert.equal(tools.get('control_run')?.properties.expected_run_status?.type, 'array');
  report.health = await call('health_check');
  assert.equal(report.health.mcp_server.version, version);
  assert.equal(report.health.mcp_server.consistent, true);
  assert.equal(report.health.robot.status, 'not_checked');
  const protocol_path = path.join(root, 'examples/01-flex-serial-dilution/protocol.py');
  report.simulation = await call('simulate_protocol', { protocol_path });
  assert.equal(report.simulation.ok, true, JSON.stringify(report.simulation));
  assert.equal(report.simulation.experiment_figure.ok, true, JSON.stringify(report.simulation.experiment_figure));
  assert.ok(fs.statSync(report.simulation.experiment_figure.png_path).size > 1000);
  report.artifacts = await call('protocol_artifacts', { analysis_path: report.simulation.analysis_path });
  assert.equal(report.artifacts.artifact_api, 1);
  assert.equal(report.artifacts.documents.animation.status, 'ready', JSON.stringify(report.artifacts));
  assert.equal(report.artifacts.documents.setup.status, 'ready', JSON.stringify(report.artifacts));
  report.logicpass = await call('logicpass_check', { protocol_path });
  assert.equal(report.logicpass.outcome, 'pass', JSON.stringify(report.logicpass));
  report.preflight = await call('flex3d_preflight_check', { source: protocol_path });
  assert.equal(report.preflight.status, 'passed', JSON.stringify(report.preflight));
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  report.viewer = await call('flex3d_open_viewer', { protocol_path, port });
  assert.equal(report.viewer.ok, true, JSON.stringify(report.viewer));
  assert.equal((await fetch(report.viewer.experiment_figure.url)).status, 200);
  const imageReply = await request('tools/call', { name: 'simulate_protocol', arguments: { protocol_path } });
  assert.ok(imageReply.result.content.some(item => item.type === 'image' && item.mimeType === 'image/png'));
  const base = `http://127.0.0.1:${port}`;
  const info = await (await fetch(base + '/flex3d/example/info')).json();
  const scene = await (await fetch(base + '/flex3d/example/view.json')).json();
  assert.ok(info.steps.length > 0);
  assert.ok(scene.cameras.deck && scene.cameras.machine);
  assert.ok(scene.geoms.some(g => g.group === 0));
  const reused = await call('flex3d_open_viewer', { protocol_path, port });
  assert.equal(reused.pid, report.viewer.pid);
  assert.equal(reused.reused, true);
  report.closed = await call('flex3d_open_viewer', { action: 'close', port });
  assert.equal(report.closed.stopped, true);
  report.reopened = await call('flex3d_open_viewer', { protocol_path, port });
  assert.equal(report.reopened.ok, true);
  assert.notEqual(report.reopened.pid, report.viewer.pid);
  // This harness runs from the source checkout against the extracted bundle.
  // Use the independently authored OT-2 fixture without shipping tests in the ZIP.
  const ot2_path = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../automation/flex3d/tests/ot2_fixtures/protocols/single_p20.py');
  report.ot2 = {};
  report.ot2.simulation = await call('simulate_protocol', { protocol_path: ot2_path });
  assert.equal(report.ot2.simulation.ok, true, JSON.stringify(report.ot2.simulation));
  assert.equal(report.ot2.simulation.robot_type, 'OT-2 Standard');
  assert.equal(report.ot2.simulation.experiment_figure.ok, true, JSON.stringify(report.ot2.simulation.experiment_figure));
  const ot2Analysis = await call('simulate_protocol', { protocol_path: ot2_path, analysis_only: true });
  assert.equal(ot2Analysis.ok, true, JSON.stringify(ot2Analysis));
  assert.equal(ot2Analysis.experiment_figure, undefined);
  assert.equal(ot2Analysis.preview_3d, undefined);
  const ot2Documents = await call('protocol_artifacts', { analysis_path: ot2Analysis.analysis_path });
  assert.equal(ot2Documents.documents.animation.status, 'ready', JSON.stringify(ot2Documents));
  assert.equal(ot2Documents.documents.setup.status, 'ready', JSON.stringify(ot2Documents));
  report.ot2.logicpass = await call('logicpass_check', { protocol_path: ot2_path });
  assert.equal(report.ot2.logicpass.outcome, 'pass', JSON.stringify(report.ot2.logicpass));
  report.ot2.preflight = await call('flex3d_preflight_check', { source: ot2_path });
  assert.equal(report.ot2.preflight.status, 'passed', JSON.stringify(report.ot2.preflight));
  report.ot2.viewer = await call('flex3d_open_viewer', { protocol_path: ot2_path, port });
  assert.equal(report.ot2.viewer.ok, true, JSON.stringify(report.ot2.viewer));
  assert.equal(report.ot2.viewer.pid, report.reopened.pid);
  const ot2Key = new URL(report.ot2.viewer.url).searchParams.get('key');
  const ot2Info = await (await fetch(`${base}/flex3d/${ot2Key}/info`)).json();
  const ot2Scene = await (await fetch(`${base}/flex3d/${ot2Key}/view.json`)).json();
  assert.equal(ot2Info.robot_type, 'OT-2 Standard');
  assert.ok(ot2Scene.geoms.length && ot2Scene.frames.length);
  report.flex_after_ot2 = await call('flex3d_open_viewer', { protocol_path, port });
  assert.equal(report.flex_after_ot2.pid, report.reopened.pid);
  const flexKey = new URL(report.flex_after_ot2.url).searchParams.get('key');
  const flexInfo = await (await fetch(`${base}/flex3d/${flexKey}/info`)).json();
  assert.equal(flexInfo.robot_type, 'OT-3 Standard');
  report.ok = true;
} finally {
  if (port) { try { await call('flex3d_open_viewer', { action: 'close', port }); } catch {} }
  child.stdin.end();
  child.kill();
}
if (process.env.SMOKE_REPORT) fs.writeFileSync(process.env.SMOKE_REPORT, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ok: report.ok, version: report.health?.mcp_server.version, build: report.health?.mcp_server.build_id, tools: report.tools, artifact_api: report.artifacts?.artifact_api, documents: Object.fromEntries(Object.entries(report.artifacts?.documents || {}).map(([key,value]) => [key,value.status])), simulation: 'passed', logicpass: report.logicpass?.outcome, preflight: report.preflight?.status, viewer_reopen: report.reopened?.ok, ot2_preflight: report.ot2?.preflight.status, flex_after_ot2: report.flex_after_ot2?.ok }));
