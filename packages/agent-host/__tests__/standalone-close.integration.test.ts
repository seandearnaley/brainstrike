// ADR-0031: a standalone host's failure is reported before its close, which
// goes on holding the data root, as a host process's release goes on after Main
// reports a refused start.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RootLock, RootLockedError } from '@brainstrike/state-store';
import { afterEach, expect, test, vi } from 'vitest';
import { authenticateHostClient } from '../src/client-connection.js';
import { HOST_CLOSE_GRACE_MS } from '../src/protocol.js';
import { openStandaloneHost } from '../src/standalone-host.js';
import { holdPlatformClose } from './fixtures/held-close-platform.js';

vi.mock('../src/client-connection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client-connection.js')>();
  return { ...actual, authenticateHostClient: vi.fn(actual.authenticateHostClient) };
});

const platformModule = fileURLToPath(new URL('./fixtures/held-close-platform.ts', import.meta.url));
// The CLI as Node runs it, with a platform whose close keeps the process alive.
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const ignoredClose = fileURLToPath(
  new URL('./fixtures/ignored-close-platform.ts', import.meta.url)
);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});
async function freshRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-standalone-close-')));
  cleanups.push(() => rm(root, { force: true, recursive: true }));
  return root;
}
/** A held close whose release the test owns; cleanup releases it first. */
function heldClose(): PromiseWithResolvers<void> {
  const release = holdPlatformClose();
  cleanups.push(async () => release.resolve());
  return release;
}
function rootReleased(root: string): boolean {
  try {
    RootLock.acquire(root).release();
    return true;
  } catch {
    return false;
  }
}
/** Settles to a flag the test reads while the promise may still be pending. */
function tracked<T>(pending: Promise<T>) {
  const state = { settled: false };
  const result = pending.finally(() => {
    state.settled = true;
  });
  result.catch(() => undefined);
  return { result, state };
}

test("the CLI prints its failure, then exits with its code at the grace while its host's close never ends", async () => {
  const root = await freshRoot();
  const child = spawn(
    process.execPath,
    [
      cli,
      '--data-root',
      root,
      '--platform',
      ignoredClose,
      'thread',
      'read',
      '--thread',
      randomUUID(),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const exited = once(child, 'exit');
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  await expect.poll(() => stderr, { timeout: 45_000 }).toContain('Unknown thread');
  // Printed while the host's close still holds the process.
  expect(child.exitCode).toBeNull();
  const [code] = await exited;
  expect(code).toBe(1);
  expect(stderr).toContain(`The host did not close within ${HOST_CLOSE_GRACE_MS} ms`);
});

test("a failed connect is reported while the opened host's close is still held", async () => {
  const root = await freshRoot();
  const release = heldClose();
  const refused = new Error('In-process handshake refused');
  vi.mocked(authenticateHostClient).mockRejectedValueOnce(refused);
  const opening = tracked(openStandaloneHost(root, platformModule, { workspaceRoots: [root] }));
  await expect.poll(() => opening.state.settled).toBe(true);
  await expect(opening.result).rejects.toBe(refused);
  // The close goes on, and holds the data root until it ends.
  expect(() => RootLock.acquire(root)).toThrow(RootLockedError);
  release.resolve();
  await expect.poll(() => rootReleased(root)).toBe(true);
});
