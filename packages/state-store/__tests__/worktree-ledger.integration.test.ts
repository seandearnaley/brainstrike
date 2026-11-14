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

// BST-2505: a deleted thread's own live worktrees, wherever it made them, by the thread the ledger
// records as their maker.
test("lists a thread's live worktrees in every repository, newest first, and no other thread's", async () => {
  const store = await StateStore.open(freshDir('worktree-domain-thread'));
  try {
    const made = (
      id: string,
      createdAt: string,
      extra: { readonly repoCommonDir?: string; readonly threadId?: string | null } = {}
    ) =>
      store.worktreeLedger({
        operation: 'insert',
        row: { ...row, createdAt, id, path: `/disposable/${id}`, ...extra },
      });
    await made('older', '2026-10-13T00:00:00.000Z');
    await made('newer', '2026-10-14T00:00:00.000Z', { repoCommonDir: '/disposable/other/.git' });
    await made('archived', '2026-10-15T00:00:00.000Z');
    await store.worktreeLedger({ id: 'archived', operation: 'archive', snapshotRef: 'refs/a' });
    await made('another-thread', '2026-10-16T00:00:00.000Z', { threadId: 'thread-other' });
    await made('no-thread', '2026-10-17T00:00:00.000Z', { threadId: null });

    const { rows } = await store.worktreeLedger({
      operation: 'list-thread',
      threadId: 'thread-current',
    });

    expect(rows.map(({ id }) => id)).toEqual(['newer', 'older']);
  } finally {
    await store.close();
  }
});
