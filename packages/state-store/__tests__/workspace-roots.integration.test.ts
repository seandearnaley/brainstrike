import { afterEach, expect, test } from 'vitest';
import { StateStore } from '../src/state-store.js';
import { cleanupDirs, freshDir } from './helpers/fs.js';

afterEach(cleanupDirs);

// Main supplies the securely resolved path and its existing grant ID; the writer
// never mints a second ID. These are the A/B shapes from the normal-dev incident.
const folderA = {
  displayName: 'Alpha',
  path: '/disposable/Alpha',
  preferredId: 'ae303e9c-29a4-4ec4-a1cc-835d655dcb70',
};
const folderB = {
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
