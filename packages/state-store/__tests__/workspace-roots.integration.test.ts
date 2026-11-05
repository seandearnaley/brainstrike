import { afterEach, expect, test } from 'vitest';
import { StateStore } from '../src/state-store.js';
import { cleanupDirs, freshDir } from './helpers/fs.js';

afterEach(cleanupDirs);

// The host's root registry supplies the securely resolved path, its grant-time identity and its existing grant ID; the writer
// never mints a second ID. These are the A/B shapes from the normal-dev incident.
const folderA = {
  canonicalPath: '/disposable/Alpha',
  displayName: 'Alpha',
  path: '/disposable/Alpha',
  preferredId: 'ae303e9c-29a4-4ec4-a1cc-835d655dcb70',
};
const folderB = {
  canonicalPath: '/disposable/Bravo',
  displayName: 'Bravo',
  path: '/disposable/Bravo',
  preferredId: '5be9d0f1-a3ba-4b44-b7e7-7280906bdc78',
};

test('re-add and reopen retain the committed root ID without a PostgreSQL owner', async () => {
  const root = freshDir('workspace-roots');
  let store = await StateStore.open(root);
  try {
    const first = await store.workspaceRoots({ operation: 'register', root: folderA });
    expect(first.roots).toEqual([
      expect.objectContaining({ id: folderA.preferredId, path: folderA.path, status: 'live' }),
    ]);
    await store.workspaceRoots({ mountedPaths: [], operation: 'disconnect-except' });
    expect((await store.workspaceRoots({ operation: 'list' })).roots).toEqual([
      expect.objectContaining({ id: folderA.preferredId, status: 'disconnected' }),
    ]);
    await store.close();
    store = await StateStore.open(root);
    const readded = await store.workspaceRoots({
      operation: 'register',
      root: { ...folderA, preferredId: folderB.preferredId },
    });
    expect(readded.roots).toEqual([
      expect.objectContaining({ id: folderA.preferredId, status: 'live' }),
    ]);
    expect((await store.workspaceRoots({ operation: 'list' })).roots).toHaveLength(1);
  } finally {
    await store.close();
  }
});

test('concurrent registration commits one path identity, and disconnect keeps other roots live', async () => {
  const store = await StateStore.open(freshDir('workspace-roots-concurrent'));
  try {
    const [first, second] = await Promise.all([
      store.workspaceRoots({ operation: 'register', root: folderA }),
      store.workspaceRoots({
        operation: 'register',
        root: { ...folderA, preferredId: folderB.preferredId },
      }),
    ]);
    expect(first.roots[0]?.id).toBe(folderA.preferredId);
    expect(second.roots[0]?.id).toBe(folderA.preferredId);
    await store.workspaceRoots({ operation: 'register', root: folderB });
    const demoted = await store.workspaceRoots({
      mountedPaths: [folderB.path],
      operation: 'disconnect-except',
    });
    expect(demoted.roots).toEqual([
      expect.objectContaining({ id: folderA.preferredId, status: 'disconnected' }),
    ]);
    expect((await store.workspaceRoots({ operation: 'list' })).roots).toEqual([
      expect.objectContaining({ id: folderA.preferredId, status: 'disconnected' }),
      expect.objectContaining({ id: folderB.preferredId, status: 'live' }),
    ]);
  } finally {
    await store.close();
  }
});

test('one supplied ID cannot be rebound to another path and refusal leaves the owner usable', async () => {
  const store = await StateStore.open(freshDir('workspace-roots-identity'));
  try {
    await store.workspaceRoots({ operation: 'register', root: folderA });
    await expect(
      store.workspaceRoots({
        operation: 'register',
        root: { ...folderB, preferredId: folderA.preferredId },
      })
    ).rejects.toThrow();
    expect((await store.workspaceRoots({ operation: 'list' })).roots).toEqual([
      expect.objectContaining({ id: folderA.preferredId, path: folderA.path }),
    ]);
  } finally {
    await store.close();
  }
});

test('the open folders keep their order across reopen; a closed folder leaves it and re-adding appends it', async () => {
  const root = freshDir('workspace-roots-open');
  const folderC = {
    canonicalPath: '/disposable/Charlie',
    displayName: 'Charlie',
    path: '/disposable/Charlie',
    preferredId: '9d4f2a51-6b0e-4c7f-a7a2-3f1e0c2b8d64',
  };
  const openIds = async (store: StateStore) =>
    (await store.workspaceRoots({ operation: 'list-open' })).roots.map((entry) => entry.id);
  let store = await StateStore.open(root);
  try {
    for (const folder of [folderA, folderB, folderC]) {
      await store.workspaceRoots({ operation: 'register', root: folder });
    }
    // An unmountable folder disconnects but stays open, so the next launch retries it.
    await store.workspaceRoots({
      mountedPaths: [folderA.path, folderC.path],
      operation: 'disconnect-except',
    });
    expect(await openIds(store)).toEqual([
      folderA.preferredId,
      folderB.preferredId,
      folderC.preferredId,
    ]);
    // A folder the person removed leaves the open list but keeps its identity.
    await store.workspaceRoots({
      closeRootIds: [folderA.preferredId],
      mountedPaths: [folderC.path],
      operation: 'disconnect-except',
    });
    await store.close();
    store = await StateStore.open(root);
    expect(await openIds(store)).toEqual([folderB.preferredId, folderC.preferredId]);
    const readded = await store.workspaceRoots({
      operation: 'register',
      root: { ...folderA, preferredId: folderB.preferredId },
    });
    expect(readded.roots[0]?.id).toBe(folderA.preferredId);
    expect(await openIds(store)).toEqual([
      folderB.preferredId,
      folderC.preferredId,
      folderA.preferredId,
    ]);
  } finally {
    await store.close();
  }
});

test('a recorded path that now resolves to another folder is refused unless the person grants it afresh', async () => {
  const store = await StateStore.open(freshDir('workspace-roots-identity'));
  try {
    await store.workspaceRoots({ operation: 'register', root: folderA });
    const swapped = { ...folderA, canonicalPath: '/disposable/Elsewhere' };

    await expect(store.workspaceRoots({ operation: 'register', root: swapped })).rejects.toThrow(
      'not the one that was granted'
    );
    expect((await store.workspaceRoots({ operation: 'list' })).roots).toEqual([
      expect.objectContaining({ canonicalPath: folderA.canonicalPath, id: folderA.preferredId }),
    ]);

    await store.workspaceRoots({ operation: 'register', repin: true, root: swapped });
    expect((await store.workspaceRoots({ operation: 'list' })).roots).toEqual([
      expect.objectContaining({ canonicalPath: '/disposable/Elsewhere', id: folderA.preferredId }),
    ]);
  } finally {
    await store.close();
  }
});

test('a managed worktree registers live but never opens, and is listed while unarchived', async () => {
  const store = await StateStore.open(freshDir('workspace-roots-worktree'));
  const linked = {
    canonicalPath: '/disposable/linked',
    displayName: 'linked',
    path: '/disposable/linked',
    preferredId: '0b8f3d2e-7c41-4a5e-9d36-2f1e8a4c6b90',
  };
  try {
    await store.worktreeLedger({
      operation: 'insert',
      row: {
        archivedAt: null,
        archiveSnapshotRef: null,
        baseRef: 'a'.repeat(40),
        branch: 'feature',
        createdAt: '2026-11-01T00:00:00.000Z',
        createdBy: 'user',
        id: 'worktree-linked',
        path: linked.path,
        repoCommonDir: '/disposable/Alpha/.git',
        runId: null,
        setupOutput: null,
        setupReason: null,
        setupStatus: 'none',
        threadId: 'thread-linked',
      },
    });
    await store.workspaceRoots({ operation: 'register', root: folderA });
    expect((await store.workspaceRoots({ operation: 'register', root: linked })).roots).toEqual([
      expect.objectContaining({ id: linked.preferredId, kind: 'worktree', status: 'live' }),
    ]);
    // Re-registering (a restart re-mounting the checkout) still leaves it out of the open folders.
    await store.workspaceRoots({ operation: 'register', root: linked });
    expect((await store.workspaceRoots({ operation: 'list-open' })).roots).toEqual([
      expect.objectContaining({ id: folderA.preferredId }),
    ]);
    expect((await store.workspaceRoots({ operation: 'list-worktrees' })).roots).toEqual([
      expect.objectContaining({ id: linked.preferredId }),
    ]);
    await store.worktreeLedger({
      id: 'worktree-linked',
      operation: 'archive',
      snapshotRef: 'refs/brainstrike/archive/linked',
    });
    expect((await store.workspaceRoots({ operation: 'list-worktrees' })).roots).toEqual([]);
  } finally {
    await store.close();
  }
});
