// @vitest-environment node
// Ported from host-lease's reset-root integration proofs (deleted in ADR-0031 stage 3): the
// profile reset lease holds the data root's lock from before the profile is cleared until its
// caller releases it, so no other opener can take the root while its contents are removed.
import type { PathLike } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RootLockedError, StateStore } from '@brainstrike/state-store';
import { afterEach, expect, it, vi } from 'vitest';
import { acquireProfileResetLease, type ProfileResetLease } from '../../profile-reset-lease';
import { isRootHeld } from '../helpers/root-held';

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
const roots: string[] = [];
const leases: ProfileResetLease[] = [];
async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bs-reset-'));
  roots.push(root);
  await writeFile(join(root, 'a-truth'), 'private truth');
  await writeFile(join(root, 'b-cache'), 'derived bytes');
  return root;
}
afterEach(async () => {
  removal.before = undefined;
  for (const lease of leases.splice(0)) {
    lease.release();
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

it('a contender is refused before, during and after profile clear until the caller releases its retained guard', async () => {
  const root = await freshRoot();
  const lease = await acquireProfileResetLease(root);
  leases.push(lease);
  expect(isRootHeld(root)).toBe(true);
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
    expect(isRootHeld(root)).toBe(true);
    expect(() => lease.release()).toThrow('clearing');
    expect(lease.isReleased).toBe(false);
  } finally {
    resume.resolve();
  }
  await clearing;
  removal.before = undefined;
  expect(await readdir(root)).toEqual(['lock']);
  expect(lease.isReleased).toBe(false);
  // Remaining userData/storage purge runs under this same still-owned guard.
  expect(isRootHeld(root)).toBe(true);
  lease.release();
  expect(lease.isReleased).toBe(true);
  expect(isRootHeld(root)).toBe(false);
  await expect(lease.clearRootContents()).rejects.toThrow('released');
});

it('a removal failure preserves its cause and accessible ownership for retry', async () => {
  const root = await freshRoot();
  const lease = await acquireProfileResetLease(root);
  leases.push(lease);
  const cause = new Error('injected removal failure');
  removal.before = async () => {
    throw cause;
  };
  await expect(lease.clearRootContents()).rejects.toBe(cause);
  expect(lease.isReleased).toBe(false);
  expect(isRootHeld(root)).toBe(true);
  expect(await readFile(join(root, 'a-truth'), 'utf8')).toBe('private truth');
  removal.before = undefined;
  await lease.clearRootContents();
  expect(await readdir(root)).toEqual(['lock']);
  lease.release();
  expect(isRootHeld(root)).toBe(false);
});

it('a live owner of the root refuses reset without deleting its payload', async () => {
  const root = await freshRoot();
  // The CLI's host is the process that opened the root's store; this one plays it.
  const owner = await StateStore.open(root);
  try {
    await expect(acquireProfileResetLease(root)).rejects.toBeInstanceOf(RootLockedError);
    expect(await readFile(join(root, 'a-truth'), 'utf8')).toBe('private truth');
    expect(await readFile(join(root, 'b-cache'), 'utf8')).toBe('derived bytes');
  } finally {
    await owner.close();
  }
  expect(isRootHeld(root)).toBe(false);
});
