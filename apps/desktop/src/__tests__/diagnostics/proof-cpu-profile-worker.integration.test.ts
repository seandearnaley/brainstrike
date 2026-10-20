// @vitest-environment node

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { expect, it } from 'vitest';

it('exports the busy target thread before it can handle shutdown and retains the profile after kill', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-cpu-proof-'));
  const workerPath = path.join(directory, 'worker.cjs');
  await build({
    bundle: true,
    entryPoints: [
      path.resolve(import.meta.dirname, '../../diagnostics/proof-cpu-profile-worker.ts'),
    ],
    format: 'cjs',
    outfile: workerPath,
    platform: 'node',
  });
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
    const { Worker } = require('node:worker_threads');
    const worker = new Worker(${JSON.stringify(workerPath)}, { workerData: {
      directory: ${JSON.stringify(directory)}, captureMs: 10000, segmentMs: 250,
      samplingIntervalUs: 5000, identity: { role: 'controlled-startup', pid: process.pid }
    }});
    worker.on('message', ({ event }) => {
      if (event !== 'ready') return;
      process.stdout.write('PROFILING_READY\\n');
      function blockedStartup() {
        const end = Date.now() + 10000;
        while (Date.now() < end) Math.sqrt(Math.random());
      }
      blockedStartup();
      process.stdout.write('TARGET_UNBLOCKED\\n');
    });
  `,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const exited = once(child, 'exit');
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  try {
    await expect.poll(() => stdout, { timeout: 4000 }).toContain('PROFILING_READY');
    await expect
      .poll(
        async () =>
          (await readdir(directory)).filter((file) => file.endsWith('.cpuprofile')).length,
        { timeout: 4000 }
      )
      .toBeGreaterThan(0);
    expect(stdout).not.toContain('TARGET_UNBLOCKED');
    child.kill('SIGKILL');
    await exited;
    const profiles = (await readdir(directory)).filter((file) => file.endsWith('.cpuprofile'));
    expect(profiles.length).toBeGreaterThan(0);
    const profile = JSON.parse(await readFile(path.join(directory, profiles[0]!), 'utf8'));
    expect(profile.samples.length).toBeGreaterThan(0);
    expect(
      profile.nodes.some(
        (node: { callFrame: { functionName: string } }) =>
          node.callFrame.functionName === 'blockedStartup'
      )
    ).toBe(true);
    const records = (await readFile(path.join(directory, 'capture.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records[0].identity.pid).toBe(child.pid);
    expect(records.some((record) => record.event === 'segment')).toBe(true);
    expect(stderr).toBe('');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
    await exited;
    await rm(directory, { force: true, recursive: true });
  }
});
