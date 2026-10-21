import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { quoteCliArg } from '../lib/cli.js';

test('operator command preserves spaces, quotes and shell metacharacters', { skip: process.platform === 'win32' }, () => {
  const value = "Application Support/a'b $NOT_A_VARIABLE `printf wrong`";
  const command = `${quoteCliArg(process.execPath)} -p 'process.argv[1]' ${quoteCliArg(value)}`;
  const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), value);
});
test('operator command escapes PowerShell single quotes', () => {
  assert.equal(quoteCliArg("C:\\User Data\\O'Brien", 'win32'), "'C:\\User Data\\O''Brien'");
});
