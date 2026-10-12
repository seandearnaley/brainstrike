import { spawn } from 'node:child_process';
import type { PathLike } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import { processStartTime, RootLock, RootLockedError } from '@brainstrike/state-store';
import { Schema } from 'effect';
import { afterEach, expect, test, vi } from 'vitest';
import { launchHost } from '../src/launcher.js';
import { createNodeHostSpawner } from '../src/node-spawner.js';
import { acquireProfileResetLease, type ProfileResetLease } from '../src/reset-root.js';

const removal = vi.hoisted(() => ({
  before: undefined as ((path: PathLike) => Promise<void>) | undefined,
}));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>): Promise<void> => {
      await removal.before?.(args[0]);
      await actual.rm(...args);
    },
  };
});
const decodeResult = makeThrowingDecoder(
  Schema.Struct({
    event: Schema.Literals(['acquired', 'refused']),
    pid: Schema.optional(Schema.Int),
  }),
  { onExcessProperty: 'error' }
);
const roots: string[] = [];
const leases: ProfileResetLease[] = [];
const spawnHost = createNodeHostSpawner({
  entrypoint: fileURLToPath(new URL('../src/process-entry.ts', import.meta.url)),
  execArgv: ['--import', 'tsx'],
});
async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bs-reset-'));
  roots.push(root);
  await writeFile(join(root, 'a-truth'), 'private truth');
  await writeFile(join(root, 'b-cache'), 'derived bytes');
  return root;
}
async function contender(root: string): Promise<ReturnType<typeof decodeResult>> {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(new URL('./fixtures/reset-contender.ts', import.meta.url)),
      root,
    ],
    { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data: Buffer) => {
    stdout += data.toString();
  });
  child.stderr.on('data', (data: Buffer) => {
    stderr += data.toString();
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (code !== 0) {
    throw new Error(`Reset contender exited ${code}: ${stderr}`);
  }
  return decodeResult(JSON.parse(stdout));
}
async function waitGone(pid: number, start: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (processStartTime(pid) !== start) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Test host ${pid} did not exit`);
}
afterEach(async () => {
  removal.before = undefined;
  for (const lease of leases.splice(0)) {
    lease.release();
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

test('real contenders refuse before, during and after profile clear until the caller releases its retained guard', async () => {
  const root = await freshRoot();
  const lease = await acquireProfileResetLease(root);
  leases.push(lease);
  const token = RootLock.inspect(root)?.owner.token;
  expect(await contender(root)).toEqual({ event: 'refused', pid: process.pid });
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  let calls = 0;
  removal.before = async () => {
    calls += 1;
    if (calls === 2) {
      entered.resolve();
      await resume.promise;
    }
  };
  const clearing = lease.clearRootContents();
  expect(lease.clearRootContents()).toBe(clearing);
  try {
    await entered.promise;
    // One real entry is already removed; the next real removal is paused.
    expect((await readdir(root)).filter((entry) => entry !== 'lock')).toHaveLength(1);
    expect(await contender(root)).toEqual({ event: 'refused', pid: process.pid });
    expect(() => lease.release()).toThrow('clearing');
    expect(RootLock.inspect(root)?.owner.token).toBe(token);
  } finally {
    resume.resolve();
  }
  await clearing;
  removal.before = undefined;
  expect(await readdir(root)).toEqual(['lock']);
  expect(lease.isReleased).toBe(false);
  // Remaining userData/storage purge runs under this same still-owned guard.
  expect(await contender(root)).toEqual({ event: 'refused', pid: process.pid });
  lease.release();
  expect(lease.isReleased).toBe(true);
  expect(await contender(root)).toEqual({ event: 'acquired' });
  await expect(lease.clearRootContents()).rejects.toThrow('released');
});

test('a removal failure preserves its cause and accessible ownership for retry', async () => {
  const root = await freshRoot();
  const lease = await acquireProfileResetLease(root);
  leases.push(lease);
  const cause = new Error('injected removal failure');
  removal.before = async () => {
    throw cause;
  };
  await expect(lease.clearRootContents()).rejects.toBe(cause);
  expect(lease.isReleased).toBe(false);
  expect(await contender(root)).toEqual({ event: 'refused', pid: process.pid });
  expect(await readFile(join(root, 'a-truth'), 'utf8')).toBe('private truth');
  removal.before = undefined;
  await lease.clearRootContents();
  expect(await readdir(root)).toEqual(['lock']);
  lease.release();
  expect(await contender(root)).toEqual({ event: 'acquired' });
});

test('a real attached CLI owner refuses reset without deleting payload or discovery', async () => {
  const root = await freshRoot();
  const cli = await launchHost(root, { lifetime: 'cli', spawn: spawnHost });
  const discovery = await readFile(join(root, 'host.json'), 'utf8');
  try {
    await expect(acquireProfileResetLease(root)).rejects.toBeInstanceOf(RootLockedError);
    expect(await readFile(join(root, 'a-truth'), 'utf8')).toBe('private truth');
    expect(await readFile(join(root, 'b-cache'), 'utf8')).toBe('derived bytes');
    expect(await readFile(join(root, 'host.json'), 'utf8')).toBe(discovery);
    expect(processStartTime(cli.record.pid)).toBe(cli.record.start);
  } finally {
    await cli.close();
    await waitGone(cli.record.pid, cli.record.start);
  }
});
