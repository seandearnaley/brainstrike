import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, test } from 'vitest';
import { StateStore } from '../src/state-store.js';
import type { ForgeCacheRequest } from '../src/worktree-forge-types.js';
import { cleanupDirs, freshDir } from './helpers/fs.js';

afterEach(cleanupDirs);
const row = {
  archivedAt: null,
  archiveSnapshotRef: null,
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

test('Forge distinguishes never observed, durable absence, and draft true/false across reopen', async () => {
  const root = freshDir('forge-domain');
  let store = await StateStore.open(root);
  const key = { branch: 'feature', repoCommonDir: row.repoCommonDir };
  const observedAt = '2026-10-13T00:00:00.000Z';
  const pullRequest = {
    checks: [],
    checksRollup: 'none' as const,
    headSha: 'a'.repeat(40),
    isDraft: true,
    number: 42,
    reviewDecision: null,
    state: 'open' as const,
    title: '',
    url: 'https://github.example/acme/repo/pull/42',
  };
  try {
    expect((await store.forgeCache({ operation: 'get', ...key })).entry).toBeNull();
    await store.forgeCache({ operation: 'write', ...key, observedAt, pullRequest: null });
    await store.close();
    store = await StateStore.open(root);
    expect((await store.forgeCache({ operation: 'get', ...key })).entry).toEqual({
      observedAt,
      pullRequest: null,
    });
    expect(await store.forgeCacheSnapshot()).toEqual([]);
    await store.forgeCache({ operation: 'write', ...key, observedAt, pullRequest });
    await store.close();
    store = await StateStore.open(root);
    expect((await store.forgeCache({ operation: 'get', ...key })).entry).toEqual({
      observedAt,
      pullRequest,
    });
    await store.forgeCache({
      operation: 'write',
      ...key,
      observedAt,
      pullRequest: { ...pullRequest, isDraft: false },
    });
    expect((await store.forgeCache({ operation: 'get', ...key })).entry?.pullRequest?.isDraft).toBe(
      false
    );
    expect(await store.forgeCacheSnapshot()).toEqual([
      {
        ...key,
        checksRollup: 'none',
        isDraft: false,
        number: 42,
        state: 'open',
        url: pullRequest.url,
      },
    ]);
  } finally {
    await store.close();
  }
});

test('unreadable SQLite draft values refuse instead of becoming a published non-draft PR', async () => {
  const root = freshDir('forge-invalid-boolean');
  let store = await StateStore.open(root);
  const key = { branch: 'feature', repoCommonDir: row.repoCommonDir };
  const observedAt = '2026-10-13T00:00:00.000Z';
  const pullRequest = {
    checks: [],
    checksRollup: 'none' as const,
    headSha: 'a'.repeat(40),
    isDraft: true,
    number: 42,
    reviewDecision: null,
    state: 'open' as const,
    title: '',
    url: 'https://github.example/acme/repo/pull/42',
  };
  try {
    await store.forgeCache({ operation: 'write', ...key, observedAt, pullRequest });
    await expect(
      store.forgeCache({
        operation: 'write',
        ...key,
        observedAt,
        pullRequest: { ...pullRequest, isDraft: 1 },
      } as unknown as ForgeCacheRequest)
    ).rejects.toThrow();
    expect((await store.forgeCache({ operation: 'get', ...key })).entry).toEqual({
      observedAt,
      pullRequest,
    });
    await store.close();
    const raw = new Database(join(root, 'state.db'));
    try {
      raw.pragma('ignore_check_constraints=ON');
      raw.prepare('UPDATE brainstrike_forge_prs SET is_draft=2').run();
    } finally {
      raw.close();
    }
    store = await StateStore.open(root);
    await expect(store.forgeCache({ operation: 'get', ...key })).rejects.toThrow();
    await expect(store.forgeCacheSnapshot()).rejects.toThrow();
  } finally {
    await store.close();
  }
});
