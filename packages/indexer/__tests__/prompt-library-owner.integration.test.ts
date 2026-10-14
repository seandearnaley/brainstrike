import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStateStoreIndexer, openIndexer } from '@brainstrike/indexer';
import { StateStore } from '@brainstrike/state-store';
import { expect, test } from 'vitest';

const deadlines = { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 };
const vector = Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
test('public prompt operations join the real metadata and vector owners across edits, reopen and deletion', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'prompt-library-owner-')));
  const options = {
    dbPath: path.join(root, 'index.sqlite'),
    embedding: { indexMode: 'text-only' },
    rootIds: [],
    stateProjection: {
      mode: 'dev',
      module: new URL('./fixtures/state-search-schema.mjs', import.meta.url).href,
    },
    stateRoot: root,
  };
  let index = await openIndexer(options, deadlines);
  let store = await StateStore.open(root, { indexer: createStateStoreIndexer(index) });
  try {
    const created = await store.promptLibrary({
      input: {
        content: 'Review the current changes',
        id: 'prompt-item-canonical',
        kind: 'prompt',
        tags: ['review'],
        title: 'Review',
      },
      operation: 'create',
    });
    const item = created.items[0];
    if (!item) {
      throw new Error('Missing created prompt');
    }
    expect(item).toMatchObject({ embeddingStatus: 'pending', revision: 1 });
    await store.promptLibrary({
      input: { embedding: vector, itemId: item.id, revision: 1 },
      operation: 'store-embedding',
    });
    expect(
      (await store.promptLibrary({ operation: 'similar', options: {}, vector })).similarities
    ).toEqual([{ id: item.id, revision: 1, similarity: 1 }]);
    await expect(
      store.promptLibrary({
        input: {
          content: '   ',
          expectedRevision: 1,
          id: item.id,
          isFavorite: false,
          kind: 'prompt',
          tags: [],
          title: 'Invalid',
        },
        operation: 'update',
      })
    ).rejects.toThrow();
    expect(
      (await store.promptLibrary({ operation: 'similar', options: {}, vector })).similarities
    ).toEqual([{ id: item.id, revision: 1, similarity: 1 }]);
    const changed = await store.promptLibrary({
      input: {
        content: 'Review the changes and risks',
        expectedRevision: 1,
        id: item.id,
        isFavorite: true,
        kind: 'prompt',
        tags: ['review'],
        title: 'Safer review',
      },
      operation: 'update',
    });
    expect(changed.items[0]).toMatchObject({
      embeddingStatus: 'pending',
      id: item.id,
      revision: 2,
    });
    expect(
      (
        await store.promptLibrary({
          input: { embedding: vector, itemId: item.id, revision: 1 },
          operation: 'store-embedding',
        })
      ).accepted
    ).toBe(false);
    expect(
      (await store.promptLibrary({ operation: 'similar', options: {}, vector })).items
    ).toEqual([]);
    expect(
      (await store.promptLibrary({ id: item.id, operation: 'revisions' })).revisions[0]
    ).toMatchObject({ content: item.content, revision: 1 });
    await store.promptLibrary({
      input: { embedding: vector, itemId: item.id, revision: 2 },
      operation: 'store-embedding',
    });
    const used = await store.promptLibrary({
      action: 'new-thread',
      id: item.id,
      operation: 'usage',
    });
    await store.close();
    await index.close();
    index = await openIndexer(options, deadlines);
    store = await StateStore.open(root, { indexer: createStateStoreIndexer(index) });
    expect(await store.promptLibrary({ id: item.id, operation: 'get' })).toEqual(used);
    expect(
      (
        await store.promptLibrary({
          operation: 'similar',
          options: { excludeIds: [item.id] },
          vector,
        })
      ).items
    ).toEqual([]);
    await store.promptLibrary({ id: item.id, operation: 'delete' });
    expect(
      (await store.promptLibrary({ filter: { includeArchived: true }, operation: 'list' })).items
    ).toEqual([]);
    expect(
      (await index.promptVectors({ items: [{ id: item.id, revision: 2 }], operation: 'status' }))
        .rows
    ).toEqual([]);
  } finally {
    await store.close();
    await index.close();
    await rm(root, { force: true, recursive: true });
  }
});
