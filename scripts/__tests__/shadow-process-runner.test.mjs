import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { runBoundedProcess } from '../agent-routines/shared/bounded-process.mjs';

test('bounded process runner distinguishes pass, ordinary failure, and timeout', async () => {
  const pass = await runBoundedProcess({
    command: [process.execPath, '-e', "process.stdout.write('ok')"],
    timeoutMs: 1000,
  });
  assert.equal(pass.outcome, 'passed');
  assert.equal(pass.stdoutTail, 'ok');
  const fail = await runBoundedProcess({
    command: [process.execPath, '-e', 'process.exit(7)'],
    timeoutMs: 1000,
  });
  assert.equal(fail.outcome, 'failed');
  assert.equal(fail.exitCode, 7);
  const timeout = await runBoundedProcess({
    command: [process.execPath, '-e', 'setTimeout(() => {}, 10000)'],
    timeoutMs: 20,
  });
  assert.equal(timeout.outcome, 'timed-out');
});

test('bounded process runner kills descendants that retain inherited pipes', async (context) => {
  if (process.platform === 'win32') {
    context.skip('POSIX process-group behavior');
    return;
  }

  const grandchildSource = "process.on('SIGTERM', () => {}); setInterval(() => {}, 10000)";
  const parentSource = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    process.stdout.write(String(child.pid) + '\\n');
    setInterval(() => {}, 10000);
  `;
  const started = performance.now();
  const result = await runBoundedProcess({
    command: [process.execPath, '-e', parentSource],
    timeoutMs: 50,
  });
  const elapsedMs = performance.now() - started;

  assert.equal(result.outcome, 'timed-out');
  assert.ok(elapsedMs < 1000, `timeout took ${elapsedMs.toFixed(0)}ms`);
  const grandchildPid = Number.parseInt(result.stdoutTail.trim(), 10);
  assert.ok(Number.isSafeInteger(grandchildPid));
  assert.throws(() => process.kill(grandchildPid, 0), { code: 'ESRCH' });
});

test('bounded process runner retains only a capped output tail', async () => {
  const result = await runBoundedProcess({
    command: [process.execPath, '-e', "process.stdout.write('x'.repeat(70000) + 'END')"],
    timeoutMs: 1000,
  });
  assert.equal(Buffer.byteLength(result.stdoutTail), 64 * 1024);
  assert.ok(result.stdoutTail.endsWith('END'));
});
