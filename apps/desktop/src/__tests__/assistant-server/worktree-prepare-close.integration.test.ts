// @vitest-environment node
import { StateStore } from '@brainstrike/state-store';
import { afterEach, expect, test, vi } from 'vitest';
import { buildTestService, createTestWorkspace } from './worktree-service.shared';

const workspace = createTestWorkspace();
const databases = new Set<StateStore>();
afterEach(async () => {
  for (const database of databases) {
    await database.close();
  }
  databases.clear();
  workspace.cleanup();
});

test('terminal preparation joins setup and queued worktree mutations through their final durable replies', async () => {
  const root = workspace.freshTempDir('bst-worktree-close-state-');
  const db = await StateStore.open(root);
  databases.add(db);
  const setupStarted = Promise.withResolvers<void>();
  const releaseSetup = Promise.withResolvers<void>();
  const runSetup = vi.fn(async () => {
    setupStarted.resolve();
    await releaseSetup.promise;
    return {
      copiedPaths: [],
      output: 'setup finished',
      reason: null,
      skippedCopies: [],
      status: 'succeeded' as const,
      truncated: false,
    };
  });
  const service = buildTestService(
    { db, managedDirectory: workspace.freshManagedDir(), repo: workspace.freshRepo('close') },
    { runSetup }
  );
  const first = service.create({
    baseRef: 'main',
    branch: { name: 'close-first' },
    createdBy: 'user',
    name: 'close-first',
    rootId: 'r-1',
  });
  const second = service.create({
    baseRef: 'main',
    branch: { name: 'close-second' },
    createdBy: 'user',
    name: 'close-second',
    rootId: 'r-1',
  });
  await setupStarted.promise;
  let prepared = false;
  const preparation = service.prepareClose();
  expect(service.prepareClose()).toBe(preparation);
  void preparation.then(() => {
    prepared = true;
  });
  await expect(service.list()).resolves.toMatchObject({
    error: expect.stringContaining('closing'),
    ok: false,
  });
  await expect(
    service.create({
      baseRef: 'main',
      branch: { name: 'late' },
      createdBy: 'user',
      name: 'late',
      rootId: 'r-1',
    })
  ).resolves.toMatchObject({ error: expect.stringContaining('closing'), ok: false });
  expect(prepared).toBe(false);
  releaseSetup.resolve();
  const results = await Promise.all([first, second]);
  expect(results.every((result) => result.ok)).toBe(true);
  await preparation;
  expect(runSetup).toHaveBeenCalledTimes(2);
  await db.close();
  databases.delete(db);
  const reopened = await StateStore.open(root);
  databases.add(reopened);
  const { rows } = await reopened.worktreeLedger({ operation: 'list-active' });
  expect(rows).toHaveLength(2);
  expect(
    rows.every((row) => row.setupStatus === 'succeeded' && row.setupOutput === 'setup finished')
  ).toBe(true);
});

test('terminal preparation joins a ledger read that has not received its reply', async () => {
  const db = await StateStore.open(workspace.freshTempDir('bst-worktree-close-read-'));
  databases.add(db);
  const admitted = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<void>();
  const service = buildTestService(
    { db, managedDirectory: workspace.freshManagedDir(), repo: workspace.freshRepo('close-read') },
    {
      getWorktreeStore: async () => ({
        worktreeLedger: async (request) => {
          const result = await db.worktreeLedger(request);
          admitted.resolve();
          await reply.promise;
          return result;
        },
      }),
    }
  );
  const listing = service.list();
  await admitted.promise;
  let prepared = false;
  const preparation = service.prepareClose().then(() => {
    prepared = true;
  });
  await Promise.resolve();
  expect(prepared).toBe(false);
  reply.resolve();
  await expect(listing).resolves.toEqual({ ok: true, value: [] });
  await preparation;
});

test('an ordinary business refusal stays caller-owned during preparation', async () => {
  const db = await StateStore.open(workspace.freshTempDir('bst-worktree-close-refusal-'));
  databases.add(db);
  const repo = workspace.freshRepo('close-refusal');
  const release = Promise.withResolvers<void>();
  const admitted = Promise.withResolvers<void>();
  const service = buildTestService(
    { db, managedDirectory: workspace.freshManagedDir(), repo },
    {
      resolveRootCwd: async () => {
        admitted.resolve();
        await release.promise;
        return { ok: true, value: repo };
      },
    }
  );
  const creating = service.create({
    baseRef: 'main',
    branch: { name: 'main' },
    createdBy: 'user',
    name: 'refused',
    rootId: 'r-1',
  });
  await admitted.promise;
  const preparation = service.prepareClose();
  release.resolve();
  await expect(creating).resolves.toEqual({
    error: 'local branch "main" already exists',
    ok: false,
  });
  await expect(preparation).resolves.toBeUndefined();
});

test('a caught ledger fault stays visible to the caller and preparation with its original cause', async () => {
  const db = await StateStore.open(workspace.freshTempDir('bst-worktree-close-fault-'));
  databases.add(db);
  const admitted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const cause = new Error('Expected rejected ledger acknowledgement');
  const service = buildTestService(
    { db, managedDirectory: workspace.freshManagedDir(), repo: workspace.freshRepo('close-fault') },
    {
      getWorktreeStore: async () => ({
        worktreeLedger: async () => {
          admitted.resolve();
          await release.promise;
          throw cause;
        },
      }),
    }
  );
  const listing = service.list();
  await admitted.promise;
  const preparation = service.prepareClose();
  const failed = expect(preparation).rejects.toMatchObject({ errors: [cause] });
  release.resolve();
  await expect(listing).resolves.toEqual({ error: cause.message, ok: false });
  await failed;
});
