import { afterEach, expect, test } from 'vitest';
import { StateStore } from '../src/state-store.js';
import { cleanupDirs, freshDir } from './helpers/fs.js';

afterEach(cleanupDirs);

// ADR-0034 build decisions: a scratch thread's folder becomes a project. The host moves the folder
// to the place the person chose, then the roots domain turns its record, in one commit, into a
// folder of the person's with a project of its own, under the same root id, so the thread's
// binding and its threads follow it.
const scratch = {
  canonicalPath: '/disposable/userData/scratch/quiet-otter',
  displayName: 'quiet-otter',
  path: '/disposable/userData/scratch/quiet-otter',
  preferredId: '8c1f6a2e-4d3b-4f7a-9e21-6b0d5c4a3f18',
};
const folder = {
  canonicalPath: '/disposable/Alpha',
  displayName: 'Alpha',
  path: '/disposable/Alpha',
  preferredId: 'ae303e9c-29a4-4ec4-a1cc-835d655dcb70',
};
const moved = {
  canonicalPath: '/private/disposable/Projects/quiet-otter',
  displayName: 'quiet-otter',
  path: '/disposable/Projects/quiet-otter',
};

test("a scratch folder's record becomes a folder of the person's at its new place, with a project, under the same root id", async () => {
  const root = freshDir('scratch-project');
  let store = await StateStore.open(root);
  try {
    await store.workspaceRoots({ operation: 'register', root: folder });
    await store.workspaceRoots({
      operation: 'register-scratch',
      root: scratch,
      threadId: 'thread-1',
    });

    const { roots } = await store.workspaceRoots({
      operation: 'scratch-to-project',
      root: moved,
      rootId: scratch.preferredId,
    });

    const turned = expect.objectContaining({
      canonicalPath: moved.canonicalPath,
      displayName: moved.displayName,
      id: scratch.preferredId,
      kind: 'path',
      path: moved.path,
      projectId: expect.stringMatching(/\S/u),
      status: 'live',
    });
    expect(roots).toEqual([turned]);
    const projectId = roots[0]?.projectId;
    expect(projectId).not.toBe(
      (await store.workspaceRoots({ operation: 'list' })).roots[0]?.projectId
    );
    await store.close();
    store = await StateStore.open(root);
    // Its scratch record went in the same commit: the thread has no scratch folder now.
    expect(
      (await store.workspaceRoots({ operation: 'scratch-of-thread', threadId: 'thread-1' })).roots
    ).toEqual([]);
    expect((await store.workspaceRoots({ operation: 'list-scratch' })).roots).toEqual([]);
    // It joined the end of the open folders, as a folder the person adds does.
    expect((await store.workspaceRoots({ operation: 'list-open' })).roots).toEqual([
      expect.objectContaining({ id: folder.preferredId }),
      expect.objectContaining({ id: scratch.preferredId, projectId }),
    ]);
    // Its project is the one recorded for its new place: registering it again keeps it.
    expect(
      (
        await store.workspaceRoots({
          operation: 'register',
          root: { ...moved, preferredId: scratch.preferredId },
        })
      ).roots
    ).toEqual([expect.objectContaining({ id: scratch.preferredId, projectId })]);
    // The scratch place is free again, for another thread's folder.
    await store.workspaceRoots({
      operation: 'register-scratch',
      root: { ...scratch, preferredId: '1e7d3c5a-2b9f-4a6e-8d40-7c3b2a1f0e59' },
      threadId: 'thread-2',
    });
  } finally {
    await store.close();
  }
});

test('only a scratch folder the store has turns into a project, and only to a place no other record has', async () => {
  const store = await StateStore.open(freshDir('scratch-project-refused'));
  try {
    await store.workspaceRoots({ operation: 'register', root: folder });
    await store.workspaceRoots({
      operation: 'register-scratch',
      root: scratch,
      threadId: 'thread-1',
    });
    const before = (await store.workspaceRoots({ operation: 'list' })).roots;

    await expect(
      store.workspaceRoots({
        operation: 'scratch-to-project',
        root: moved,
        rootId: 'no-such-root',
      })
    ).rejects.toThrow(/no folder with this id/u);
    await expect(
      store.workspaceRoots({
        operation: 'scratch-to-project',
        root: moved,
        rootId: folder.preferredId,
      })
    ).rejects.toThrow(/not a scratch folder/u);
    // Another record already has that place, by its path or by its identity.
    for (const place of [
      { ...moved, path: folder.path },
      { ...moved, canonicalPath: folder.canonicalPath },
    ]) {
      await expect(
        store.workspaceRoots({
          operation: 'scratch-to-project',
          root: place,
          rootId: scratch.preferredId,
        })
      ).rejects.toThrow(/already recorded/u);
    }

    // Each refusal changed nothing.
    expect((await store.workspaceRoots({ operation: 'list' })).roots).toEqual(before);
    expect(
      (await store.workspaceRoots({ operation: 'scratch-of-thread', threadId: 'thread-1' })).roots
    ).toEqual([expect.objectContaining({ id: scratch.preferredId, kind: 'scratch' })]);
  } finally {
    await store.close();
  }
});
