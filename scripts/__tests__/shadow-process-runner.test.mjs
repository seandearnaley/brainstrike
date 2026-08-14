import assert from 'node:assert/strict';
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

test('bounded process runner retains only a capped output tail', async () => {
  const result = await runBoundedProcess({
    command: [process.execPath, '-e', "process.stdout.write('x'.repeat(70000) + 'END')"],
    timeoutMs: 1000,
  });
  assert.equal(Buffer.byteLength(result.stdoutTail), 64 * 1024);
  assert.ok(result.stdoutTail.endsWith('END'));
});
