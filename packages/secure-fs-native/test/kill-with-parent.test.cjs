'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('node:test');
const { killWithParent } = require('..');

const addon = path.join(__dirname, '..');

function isRunning(pid) {
  try {
    const stat = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
    return !stat.trim().startsWith('Z');
  } catch {
    return false;
  }
}

test('rejects a missing or invalid pid', () => {
  assert.throws(() => killWithParent(), TypeError);
  assert.throws(() => killWithParent(0), TypeError);
  assert.throws(() => killWithParent(1.5), TypeError);
});

test('a stopped child dies with its parent', { skip: process.platform !== 'linux' }, async () => {
  // The parent starts a child that arms the signal against it and stops itself, then the test
  // kills the parent. Nothing else ends the stopped child.
  const child = `const { killWithParent } = require(${JSON.stringify(addon)});
    process.stdout.write(killWithParent(process.ppid) + '\\n');
    process.kill(process.pid, 'SIGSTOP');`;
  const parent = spawn(
    process.execPath,
    [
      '-e',
      `const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { stdio: ['ignore', 'pipe', 'inherit'] });
       child.stdout.once('data', (chunk) => process.stdout.write(child.pid + ' ' + chunk));`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  );
  const [line] = await once(parent.stdout, 'data');
  const [pid, state] = String(line).trim().split(' ');
  assert.equal(state, 'armed');
  try {
    parent.kill('SIGKILL');
    await once(parent, 'exit');
    while (isRunning(Number(pid))) {
      await delay(25);
    }
  } finally {
    if (isRunning(Number(pid))) {
      process.kill(Number(pid), 'SIGKILL');
    }
  }
});

test('reports the absence of the signal off Linux', { skip: process.platform === 'linux' }, () => {
  assert.equal(killWithParent(process.ppid), 'unsupported');
});
