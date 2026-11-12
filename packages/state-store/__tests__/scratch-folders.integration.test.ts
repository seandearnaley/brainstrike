import { afterEach, expect, test } from 'vitest';
import { StateStore } from '../src/state-store.js';
import { cleanupDirs, freshDir } from './helpers/fs.js';

afterEach(cleanupDirs);

// ADR-0034 (scratch threads): a thread sent with no folder while none is open works in a folder
// the host made for it. The store records it as that thread's scratch folder in the commit that
// records the root, so the root's kind comes from that record, never from a caller.
const scratch = {
  canonicalPath: '/disposable/scratch/quiet-otter',
  displayName: 'quiet-otter',
  path: '/disposable/scratch/quiet-otter',
  preferredId: '8c1f6a2e-4d3b-4f7a-9e21-6b0d5c4a3f18',
};
const folder = {
  canonicalPath: '/disposable/Alpha',
  displayName: 'Alpha',
  path: '/disposable/Alpha',
  preferredId: 'ae303e9c-29a4-4ec4-a1cc-835d655dcb70',
};

test('a scratch folder is recorded with its thread: live, never an open folder, with no project, across a restart', async () => {
  const root = freshDir('scratch-folders');
  let store = await StateStore.open(root);
  try {
    await store.workspaceRoots({ operation: 'register', root: folder });
    const { roots } = await store.workspaceRoots({
      operation: 'register-scratch',
      root: scratch,
      threadId: 'thread-1',
    });
    expect(roots).toEqual([
      expect.objectContaining({
        id: scratch.preferredId,
        kind: 'scratch',
        path: scratch.path,
        projectId: null,
        status: 'live',
      }),
    ]);
    await store.close();
    store = await StateStore.open(root);
    // A restart mounts it again through the ordinary registration, which keeps it out of the
    // open folders.
    await store.workspaceRoots({ operation: 'register', root: scratch });
    expect((await store.workspaceRoots({ operation: 'list-open' })).roots).toEqual([
      expect.objectContaining({ id: folder.preferredId }),
    ]);
    expect((await store.workspaceRoots({ operation: 'list-scratch' })).roots).toEqual([
      expect.objectContaining({ id: scratch.preferredId, kind: 'scratch', projectId: null }),
    ]);
    expect(
      (await store.workspaceRoots({ operation: 'scratch-of-thread', threadId: 'thread-1' })).roots
    ).toEqual([expect.objectContaining({ id: scratch.preferredId })]);
    expect(
      (await store.workspaceRoots({ operation: 'scratch-of-thread', threadId: 'thread-2' })).roots
    ).toEqual([]);
  } finally {
    await store.close();
  }
});

test('a scratch folder is never a folder that is already recorded, and a thread has one', async () => {
  const store = await StateStore.open(freshDir('scratch-folders-refused'));
  try {
    await store.workspaceRoots({ operation: 'register', root: folder });
    await expect(
      store.workspaceRoots({ operation: 'register-scratch', root: folder, threadId: 'thread-1' })
    ).rejects.toThrow(/already recorded/u);
    await store.workspaceRoots({
      operation: 'register-scratch',
      root: scratch,
      threadId: 'thread-1',
    });
    await expect(
      store.workspaceRoots({
        operation: 'register-scratch',
        root: {
          ...scratch,
          canonicalPath: '/disposable/scratch/brave-heron',
          path: '/disposable/scratch/brave-heron',
          preferredId: '1e7d3c5a-2b9f-4a6e-8d40-7c3b2a1f0e59',
        },
        threadId: 'thread-1',
      })
    ).rejects.toThrow(/already has a scratch folder/u);
    // The refusals changed nothing: the folder is still a folder, and the thread keeps its one.
    expect((await store.workspaceRoots({ operation: 'list' })).roots).toEqual([
      expect.objectContaining({ id: folder.preferredId, kind: 'path' }),
      expect.objectContaining({ id: scratch.preferredId, kind: 'scratch' }),
    ]);
  } finally {
    await store.close();
  }
});

test("forgetting a thread's scratch folder deletes its root and its record, and nothing else", async () => {
  const store = await StateStore.open(freshDir('scratch-folders-forget'));
  try {
    await store.workspaceRoots({ operation: 'register', root: folder });
    await store.workspaceRoots({
      operation: 'register-scratch',
      root: scratch,
      threadId: 'thread-1',
    });
    expect(
      (await store.workspaceRoots({ operation: 'forget-scratch', threadId: 'thread-1' })).roots
    ).toEqual([expect.objectContaining({ id: scratch.preferredId, path: scratch.path })]);
    expect((await store.workspaceRoots({ operation: 'list' })).roots).toEqual([
      expect.objectContaining({ id: folder.preferredId }),
    ]);
    expect(
      (await store.workspaceRoots({ operation: 'scratch-of-thread', threadId: 'thread-1' })).roots
    ).toEqual([]);
    // A thread with no scratch folder has nothing to forget.
    expect(
      (await store.workspaceRoots({ operation: 'forget-scratch', threadId: 'thread-1' })).roots
    ).toEqual([]);
    // Its path can be made again, for another thread.
    await store.workspaceRoots({
      operation: 'register-scratch',
      root: scratch,
      threadId: 'thread-2',
    });
  } finally {
    await store.close();
  }
});
