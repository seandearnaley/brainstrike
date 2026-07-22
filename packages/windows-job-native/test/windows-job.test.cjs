'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdir, mkdtemp, readFile, rm, stat } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const windowsJob = require('..');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForFile(filePath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(filePath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${filePath}.`);
}

test('owns an orphaned late-writing grandchild without terminating an unrelated process', {
  skip: process.platform !== 'win32',
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-windows-job-test-'));
  const profile = path.join(root, 'profile');
  const readyPath = path.join(root, 'ready');
  const latePath = path.join(profile, 'late-write');
  await mkdir(profile);

  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  try {
    windowsJob.initialize();
    const grandchildSource = `
        const fs = require('node:fs');
        setTimeout(() => {
          fs.mkdirSync(${JSON.stringify(profile)}, { recursive: true });
          fs.writeFileSync(${JSON.stringify(latePath)}, 'late');
        }, 700);
        setInterval(() => {}, 1000);
      `;
    const childSource = `
        const { spawn } = require('node:child_process');
        const fs = require('node:fs');
        const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}], {
          detached: true,
          stdio: 'ignore',
        });
        grandchild.unref();
        fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready');
      `;
    const child = spawn(process.execPath, ['-e', childSource], { stdio: 'ignore' });
    await waitForFile(readyPath);
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });

    assert.ok(windowsJob.activeProcessCount() > 1);
    assert.ok(windowsJob.terminateOtherProcesses(91) > 0);
    for (let attempts = 0; windowsJob.activeProcessCount() > 1 && attempts < 100; attempts += 1) {
      await sleep(25);
    }
    assert.equal(windowsJob.activeProcessCount(), 1);

    await rm(profile, { force: true, recursive: true });
    await sleep(900);
    await assert.rejects(stat(profile), { code: 'ENOENT' });
    assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
  } finally {
    unrelated.kill('SIGKILL');
    await rm(root, { force: true, recursive: true });
  }
});

test('kills inherited descendants when an owning launcher exits unexpectedly', {
  skip: process.platform !== 'win32',
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-windows-job-close-test-'));
  const profile = path.join(root, 'profile');
  const readyPath = path.join(root, 'ready');
  const latePath = path.join(profile, 'late-write');
  await mkdir(profile);

  try {
    const grandchildSource = `
        const fs = require('node:fs');
        setTimeout(() => {
          fs.mkdirSync(${JSON.stringify(profile)}, { recursive: true });
          fs.writeFileSync(${JSON.stringify(latePath)}, 'late');
        }, 700);
        setInterval(() => {}, 1000);
      `;
    const helperSource = `
        const { spawn } = require('node:child_process');
        const fs = require('node:fs');
        const job = require(${JSON.stringify(path.resolve(__dirname, '..'))});
        job.initialize();
        const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}], {
          detached: true,
          stdio: 'ignore',
        });
        grandchild.unref();
        fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready');
        setTimeout(() => process.exit(0), 100);
      `;
    const helper = spawn(process.execPath, ['-e', helperSource], { stdio: 'ignore' });
    await waitForFile(readyPath);
    await new Promise((resolve, reject) => {
      helper.once('error', reject);
      helper.once('exit', resolve);
    });

    await rm(profile, { force: true, recursive: true });
    await sleep(900);
    await assert.rejects(stat(profile), { code: 'ENOENT' });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
