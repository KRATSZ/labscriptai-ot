#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { READY_MARKER, runtimePaths, cachedPython, cachedNodeModules, writeReadyMarker, atomicWrite, systemPath } from './runtime-paths.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const paths = runtimePaths(root);
const log = (...args) => console.error('[install-runtime]', ...args);
const run = (command, args, options = {}) => spawnSync(command, args, { encoding: 'utf8', env: { ...process.env, PATH: systemPath() }, timeout: 1800000, maxBuffer: 8 * 1024 * 1024, ...options });
function checked(command, args, options) {
  const result = run(command, args, options);
  if (result.error || result.status !== 0) throw new Error(`${command}: ${result.error?.message || (result.stderr || result.stdout || `exit ${result.status}`).slice(-4000)}`);
}
function nodeHealth(dir) {
  const script = `import {createRequire} from 'node:module'; import {pathToFileURL} from 'node:url';
    const require=createRequire(${JSON.stringify(path.join(dir, '_health.cjs'))});
    for(const id of ['server/index.js','server/stdio.js','types.js']) await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/'+id)).href);`;
  return run(process.execPath, ['--input-type=module', '-e', script], { timeout: 30000 }).status === 0;
}
function pythonHealth(python) {
  return run(python, ['-c', 'import sys, opentrons, mujoco; from PIL import Image; assert (3,11) <= sys.version_info[:2] < (3,14)'], { timeout: 60000 }).status === 0;
}
function acquireLock() {
  fs.mkdirSync(paths.home, { recursive: true });
  const file = path.join(paths.home, '.install.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); fs.closeSync(fd);
      return () => fs.rmSync(file, { force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let dead = false;
      try {
        const pid = JSON.parse(fs.readFileSync(file, 'utf8')).pid;
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); } catch (err) { dead = err.code === 'ESRCH'; }
        }
      } catch {}
      if (!attempt && dead) { fs.rmSync(file, { force: true }); continue; }
      throw new Error(`Another runtime install is running (lock: ${file}). Wait for it to finish, then retry.`);
    }
  }
}
// Python environments contain absolute paths. Build them at their final path;
// a broken previous environment is retained until the replacement validates.
function replaceRuntime(target, install, kind, key) {
  const backup = `${target}.backup-${randomUUID()}`;
  const hadPrevious = fs.existsSync(target);
  if (hadPrevious) fs.renameSync(target, backup);
  try {
    install();
    writeReadyMarker(target, { kind, key });
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true });
    if (hadPrevious) {
      fs.renameSync(backup, target);
      fs.rmSync(path.join(target, READY_MARKER), { force: true });
    }
    throw error;
  }
  if (hadPrevious) {
    try { fs.rmSync(backup, { recursive: true, force: true }); }
    catch { log(`Old runtime retained at ${backup}`); }
  }
}
function installNode() {
  if (cachedNodeModules(root) && nodeHealth(paths.nodeDir)) { log('Node dependencies ready (reused).'); return; }
  replaceRuntime(paths.nodeDir, () => {
    fs.mkdirSync(paths.nodeDir, { recursive: true });
    for (const file of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(root, 'servers/opentrons-mcp', file), path.join(paths.nodeDir, file));
    const args = ['ci', '--omit=dev', '--no-audit', '--no-fund'];
    if (process.platform === 'win32') {
      // All command tokens are fixed; the user path is only passed as cwd.
      checked(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm.cmd ci --omit=dev --no-audit --no-fund'], { cwd: paths.nodeDir });
    } else checked('npm', args, { cwd: paths.nodeDir });
    if (!nodeHealth(paths.nodeDir)) throw new Error('Installed Node dependencies failed import validation.');
  }, 'node', paths.nodeKey);
  log('Node dependencies installed.');
}
function installPython() {
  if (cachedPython(root) && pythonHealth(paths.python)) { log('Python dependencies ready (reused).'); return; }
  replaceRuntime(paths.pythonDir, () => {
    const requirements = path.join(root, 'requirements.lock');
    if (run('uv', ['--version'], { timeout: 10000 }).status === 0) {
      checked('uv', ['venv', '--python', '3.12', paths.pythonDir]);
      checked('uv', ['pip', 'sync', '--python', paths.python, '--require-hashes', requirements]);
    } else {
      const candidates = process.platform === 'win32' ? [['py', '-3'], ['python'], ['python3']] : [['python3.13'], ['python3.12'], ['python3.11'], ['python3'], ['python']];
      const selected = candidates.find(([cmd, ...args]) => run(cmd, [...args, '-c', 'import sys; sys.exit(0 if (3,11) <= sys.version_info[:2] < (3,14) else 1)'], { timeout: 10000 }).status === 0);
      if (!selected) throw new Error('Install uv or Python 3.11–3.13, then rerun the installer.');
      const [cmd, ...args] = selected;
      checked(cmd, [...args, '-m', 'venv', paths.pythonDir]);
      checked(paths.python, ['-m', 'pip', 'install', '--require-hashes', '--no-input', '--disable-pip-version-check', '-r', requirements]);
    }
    if (!pythonHealth(paths.python)) throw new Error('Installed Python dependencies failed import validation.');
  }, 'python', paths.pythonKey);
  log('Python dependencies installed.');
}
function migrateData() {
  const explicit = process.env.PLUGIN_DATA || process.env.OPENTRONS_PLUGIN_DATA;
  if (explicit && !/\$\{[^}]+\}/.test(explicit)) return;
  const legacy = path.join(root, '.plugin-data'), target = path.join(paths.home, 'data');
  if (fs.existsSync(legacy) && !fs.existsSync(target)) {
    fs.cpSync(legacy, target, { recursive: true });
    log('Existing user records copied to the shared data directory.');
  }
}
let unlock;
try {
  if (Number(process.versions.node.split('.')[0]) < 18) throw new Error('Node.js 18+ is required.');
  unlock = acquireLock();
  installNode(); installPython(); migrateData();
  atomicWrite(paths.stateFile, JSON.stringify({ schema: 1, python: paths.python, nodeModules: paths.nodeModules }) + '\n');
  log(`Runtime ready. User directory: ${paths.home}`);
} catch (error) { log(error.message); process.exitCode = 1; }
finally { unlock?.(); }
