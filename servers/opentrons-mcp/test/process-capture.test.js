import { test } from "node:test";
import { ChildProcess } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureProcess, executeCaptured, readBoundedCapture } from "../lib/process-capture.js";

function environment(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "OT 中文 spaces "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, options: {env: {...process.env, TEMP: root, TMPDIR: root}, timeout: 3000} };
}

test("captures Unicode output, stderr, stdin and the real nonzero exit through files", async t => {
  const {root, options} = environment(t);
  const result = await captureProcess(process.execPath, ["-e", "const fs=require('node:fs');process.stdout.write(fs.readFileSync(0));process.stderr.write('中文错误');process.exitCode=7"], {...options, input: "中文 input"});
  assert.equal(result.code, 7);
  assert.equal(result.stdout, "中文 input");
  assert.equal(result.stderr, "中文错误");
  assert.equal(fs.readdirSync(root).length, process.platform === "win32" ? 1 : 0);
});

test("exporter failures retain their actual exit code and diagnostics", async t => {
  const {options} = environment(t);
  await assert.rejects(executeCaptured(process.execPath, ["-e", "process.stderr.write('export failed');process.exit(9)"], options), error => error.code === 9 && error.stderr === "export failed");
});

test("missing executables keep ENOENT for the existing Python-candidate fallback", async t => {
  const {options} = environment(t);
  await assert.rejects(captureProcess(path.join(options.env.TEMP, "missing.exe"), [], options), {code: "ENOENT"});
});

test("timeouts stop the direct child and retain diagnostic files", async t => {
  const {root, options} = environment(t);
  await assert.rejects(captureProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {...options, timeout: 200}), {code: "ETIMEDOUT"});
  assert.equal(fs.readdirSync(root).length, process.platform === "win32" ? 1 : 0);
});

test("oversized output is rejected instead of parsing a truncated result", async t => {
  const {options} = environment(t);
  await assert.rejects(captureProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(1024))"], {...options, maxBuffer: 32}), {code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"});
});

test("a POSIX helper ignoring termination is force-killed within a bounded deadline", {skip: process.platform === "win32"}, async t => {
  const {options} = environment(t);
  const start = Date.now();
  await assert.rejects(captureProcess(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>process.stdout.write('x'),10)"], {...options, timeout: 200}), {code: "ETIMEDOUT"});
  assert.ok(Date.now() - start < 3000);
});

test("late descendant output remains available until its invocation owner cleans up", async t => {
  const {options} = environment(t);
  const source = "const{spawn}=require('node:child_process');spawn(process.execPath,['-e',\"setTimeout(()=>process.stdout.write('late-output'),300)\"],{stdio:'inherit',detached:true}).unref()";
  const result = await captureProcess(process.execPath, ["-e", source], options);
  if (process.platform === "win32") {
    const output = path.join(result.captureDirectory, "stdout");
    const deadline = Date.now() + 5000;
    while (!fs.readFileSync(output, "utf8").includes("late-output") && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(fs.readFileSync(output, "utf8"), "late-output");
  } else assert.equal(result.stdout, "late-output");
});

test("file snapshots enforce byte limits independently of an earlier size check", t => {
  const {root} = environment(t);
  const file = path.join(root, "capture");
  fs.writeFileSync(file, "中文");
  assert.equal(readBoundedCapture(file, 6), "中文");
  fs.appendFileSync(file, "x".repeat(1024 * 1024));
  assert.throws(() => readBoundedCapture(file, 6), {code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"});
});

test("timeout failures preserve the emitted diagnostics and capture location", async t => {
  const {options} = environment(t);
  await assert.rejects(executeCaptured(process.execPath, ["-e", "console.error('diagnostic before timeout');setInterval(()=>{},1000)"], {...options, timeout: 1000}), error => {
    assert.equal(error.code, "ETIMEDOUT");
    assert.match(error.stderr, /diagnostic before timeout/);
    if (process.platform === "win32") assert.ok(fs.existsSync(error.captureDirectory));
    return true;
  });
});

test("unsupported timer delays are rejected before creating or starting a helper", async t => {
  const {root, options} = environment(t);
  await assert.rejects(captureProcess(process.execPath, ["-e", "process.exit(99)"], {...options, timeout: 2147483648}), /Invalid helper capture limits/);
  assert.deepEqual(fs.readdirSync(root), []);
});

test("a post-spawn termination error keeps escalation and reports an uncertain stop", async t => {
  const {options} = environment(t);
  const originalKill = ChildProcess.prototype.kill;
  let helper, signals = 0;
  t.mock.method(ChildProcess.prototype, "kill", function () {
    helper = this; signals++;
    this.emit("error", Object.assign(new Error("injected terminate denial"), {code: "EPERM"}));
    return false;
  });
  try {
    await assert.rejects(captureProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {...options, timeout: 100}), {code: "PROCESS_STOP_UNCERTAIN"});
    assert.ok(signals >= 2, "Both termination and force-kill attempts must occur");
  } finally {
    if (helper) {
      const closed = once(helper, "close");
      originalKill.call(helper, "SIGKILL");
      await closed;
    }
  }
});
