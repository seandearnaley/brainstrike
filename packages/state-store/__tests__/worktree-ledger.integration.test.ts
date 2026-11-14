import { afterEach, expect, test } from 'vitest';
import { StateStore } from '../src/state-store.js';
import { cleanupDirs, freshDir } from './helpers/fs.js';

afterEach(cleanupDirs);
const row = {
  archivedAt: null,
  archiveSnapshotRef: null,
  // The commit it was made at, recorded with it and kept through every change (BST-2518).
  baseCommit: 'b'.repeat(40),
  baseRef: 'a'.repeat(40),
  branch: 'feature',
  createdAt: '2026-10-13T00:00:00.000Z',
  createdBy: 'user' as const,
  id: 'worktree-current',
  path: '/disposable/linked',
  repoCommonDir: '/disposable/repo/.git',
  runId: null,
  setupOutput: null,
  setupReason: null,
  setupStatus: 'none' as const,
  threadId: 'thread-current',
};

test('worktree identity, setup, archive and restore survive real writer reopen', async () => {
  const root = freshDir('worktree-domain');
  let store = await StateStore.open(root);
  try {
    expect((await store.worktreeLedger({ operation: 'insert', row })).rows).toEqual([row]);
    await store.worktreeLedger({
      id: row.id,
      operation: 'setup',
      output: 'exit 1',
      reason: 'script failed',
      status: 'failed',
    });
    await store.worktreeLedger({ branch: 'next', id: row.id, operation: 'branch' });
    const archived = (
      await store.worktreeLedger({
        id: row.id,
        operation: 'archive',
        snapshotRef: 'refs/brainstrike/archive/current',
      })
    ).rows[0];
    expect(archived?.archivedAt).toEqual(expect.any(String));
    expect((await store.worktreeLedger({ operation: 'list-active' })).rows).toEqual([]);
    await store.close();
    store = await StateStore.open(root);
    expect((await store.worktreeLedger({ id: row.id, operation: 'get' })).rows).toEqual([archived]);
    const restored = (await store.worktreeLedger({ id: row.id, operation: 'restore' })).rows[0];
    expect(restored).toEqual({
      ...row,
      branch: 'next',
      setupOutput: 'exit 1',
      setupReason: 'script failed',
      setupStatus: 'failed',
    });
    expect((await store.worktreeLedger({ operation: 'by-path', path: row.path })).rows).toEqual([
      restored,
    ]);
    expect(
      (
        await store.worktreeLedger({
          operation: 'list-repository',
          repoCommonDir: row.repoCommonDir,
        })
      ).rows
    ).toEqual([restored]);
    await expect(
      store.worktreeLedger({ branch: 'next', id: 'absent', operation: 'branch' })
    ).rejects.toThrow();
    await expect(
      store.worktreeLedger({ operation: 'insert', row: { ...row, id: 'duplicate-path' } })
    ).rejects.toThrow();
  } finally {
    await store.close();
  }
});
