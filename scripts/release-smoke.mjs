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
  assert.equal(report.tools, 52);
  report.health = await call('health_check');
  assert.equal(report.health.mcp_server.version, version);
  assert.equal(report.health.mcp_server.consistent, true);
  assert.equal(report.health.robot.status, 'not_checked');
  const protocol_path = path.join(root, 'examples/01-flex-serial-dilution/protocol.py');
  report.simulation = await call('simulate_protocol', { protocol_path });
  assert.equal(report.simulation.ok, true, JSON.stringify(report.simulation));
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
  report.ok = true;
} finally {
  if (port) { try { await call('flex3d_open_viewer', { action: 'close', port }); } catch {} }
  child.stdin.end();
  child.kill();
}
if (process.env.SMOKE_REPORT) fs.writeFileSync(process.env.SMOKE_REPORT, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ok: report.ok, version: report.health?.mcp_server.version, build: report.health?.mcp_server.build_id, tools: report.tools, simulation: 'passed', logicpass: report.logicpass?.outcome, preflight: report.preflight?.status, viewer_reopen: report.reopened?.ok }));
