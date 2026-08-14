import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { runBoundedProcess } from '../agent-routines/shared/bounded-process.mjs';

test('bounded process runner fails closed on Windows before spawning', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainstrike-bounded-process-windows-'));
  const sideEffectPath = path.join(root, 'spawned');
  let spawnCalls = 0;
  context.after(() => rm(root, { force: true, recursive: true }));

  const result = await runBoundedProcess({
    command: [
      process.execPath,
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(sideEffectPath)}, 'spawned')`,
    ],
    platform: 'win32',
    spawnProcess: () => {
      spawnCalls += 1;
      throw new Error('spawn must not be called');
    },
    timeoutMs: 1000,
  });

  assert.equal(result.outcome, 'spawn-error');
  assert.match(result.stderrTail, /unsupported platform: win32/u);
  assert.equal(spawnCalls, 0);
  assert.equal(existsSync(sideEffectPath), false);
});

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
    timeoutMs: 1000,
  });
  const elapsedMs = performance.now() - started;

  assert.equal(result.outcome, 'timed-out');
  assert.ok(elapsedMs < 2000, `timeout took ${elapsedMs.toFixed(0)}ms`);
  const grandchildPid = Number.parseInt(result.stdoutTail.trim(), 10);
  assert.ok(Number.isSafeInteger(grandchildPid));
  assert.throws(() => process.kill(grandchildPid, 0), { code: 'ESRCH' });
});

test('bounded process runner waits for escalation after the direct child exits', async (context) => {
  if (process.platform === 'win32') {
    context.skip('POSIX process-group behavior');
    return;
  }

  const grandchildSource = `
    process.on('SIGTERM', () => {});
    process.kill(process.ppid, 'SIGUSR1');
    setInterval(() => {}, 10000);
  `;
  const parentSource = `
    const { spawn } = require('node:child_process');
    process.once('SIGUSR1', () => process.stdout.write('ready\\n'));
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    process.stdout.write(String(child.pid) + '\\n');
    setInterval(() => {}, 10000);
  `;
  let grandchildPid;
  context.after(() => {
    if (Number.isSafeInteger(grandchildPid)) {
      try {
        process.kill(grandchildPid, 'SIGKILL');
      } catch (error) {
        if (error?.code !== 'ESRCH') {
          throw error;
        }
      }
    }
  });

  const result = await runBoundedProcess({
    command: [process.execPath, '-e', parentSource],
    timeoutMs: 1000,
  });

  assert.equal(result.outcome, 'timed-out');
  const [pidLine, readyLine] = result.stdoutTail.trim().split('\n');
  grandchildPid = Number.parseInt(pidLine, 10);
  assert.ok(Number.isSafeInteger(grandchildPid));
  assert.equal(readyLine, 'ready');
  assert.throws(() => process.kill(grandchildPid, 0), { code: 'ESRCH' });
});

test('bounded process runner reports termination failure when the group remains alive', async () => {
  const result = await runBoundedProcess({
    command: [process.execPath, '-e', 'setTimeout(() => {}, 10000)'],
    isProcessTreeAlive: () => true,
    timeoutMs: 20,
  });

  assert.equal(result.outcome, 'termination-failed');
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, 'SIGKILL');
});

test('bounded process runner retains only a capped output tail', async () => {
  const result = await runBoundedProcess({
    command: [process.execPath, '-e', "process.stdout.write('x'.repeat(70000) + 'END')"],
    timeoutMs: 1000,
  });
  assert.equal(Buffer.byteLength(result.stdoutTail), 64 * 1024);
  assert.ok(result.stdoutTail.endsWith('END'));
});
