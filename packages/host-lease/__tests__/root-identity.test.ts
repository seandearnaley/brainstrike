import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { RootLock } from '@brainstrike/state-store';
import { afterEach, expect, test, vi } from 'vitest';
import { launchHost } from '../src/launcher.js';

// BST-2234: the lock's writer (state-store) and the launcher's comparer (host-lease) each derived a root's identity,
// and the two derivations disagreed on Windows. Both must take it from state-store's one canonicalizer. This test
// replaces that canonicalizer with one whose spelling no realpath produces (a trailing separator): the writer has to
// record it and the comparer has to derive it, or the launcher refuses its own root as foreign.
vi.mock('../../state-store/src/root-identity.js', async (importOriginal) => {
  const actual =
    await importOriginal<Pick<typeof import('@brainstrike/state-store'), 'canonicalRoot'>>();
  return { canonicalRoot: (path: string): string => `${actual.canonicalRoot(path)}${sep}` };
});

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

test("the lock's writer and the launcher's comparer derive a root's identity from the same canonicalizer", async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-root-identity-'));
  roots.push(root);
  const lease = await RootLock.acquire(root);
  try {
    expect(lease.owner.root.endsWith(sep)).toBe(true);
    await expect(
      launchHost(root, {
        lifetime: 'cli',
        spawn: async () => {
          throw new Error('This launch must not start a host');
        },
        startupTimeoutMs: 50,
      })
    ).rejects.toThrow(new RegExp(`Live host pid ${process.pid}`, 'u'));
  } finally {
    lease.release();
  }
});
