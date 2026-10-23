import { afterEach, expect, test } from 'vitest';
import { StateStore } from '../src/state-store.js';
import { cleanupDirs, freshDir } from './helpers/fs.js';

afterEach(cleanupDirs);
const collection = {
  createdAt: '2026-10-13T19:45:00.000Z',
  dimensions: 384,
  distance: 'cosine' as const,
  id: 'collection-one',
  modelId: 'Xenova/all-MiniLM-L6-v2',
  modelKey: 'local::Xenova/all-MiniLM-L6-v2',
  name: 'Project reference',
};

test('collection choice keeps its original identity and complete metadata across reopen', async () => {
  const directory = freshDir('collection-owner');
  let store = await StateStore.open(directory);
  try {
    const created = await store.collections({ collection, operation: 'create' });
    expect(created.collections).toEqual([collection]);
    await expect(
      store.collections({
        collection: { ...collection, modelId: 'different' },
        operation: 'create',
      })
    ).rejects.toThrow();
    await store.close();
    store = await StateStore.open(directory);
    expect(await store.collections({ id: collection.id, operation: 'get' })).toEqual(created);
    expect((await store.collections({ id: 'absent', operation: 'get' })).collections).toEqual([]);
  } finally {
    await store.close();
  }
});

test('workspace collection creation is a single writer decision, ordinary collections stay distinct', async () => {
  const store = await StateStore.open(freshDir('workspace-collection'));
  try {
    const [first, second] = await Promise.all([
      store.collections({
        collection: { ...collection, systemRole: 'workspace-index' },
        operation: 'create',
      }),
      store.collections({
        collection: { ...collection, id: 'other-candidate', systemRole: 'workspace-index' },
        operation: 'create',
      }),
    ]);
    expect(first.collections).toEqual(second.collections);
    await store.collections({
      collection: { ...collection, id: 'ordinary-copy' },
      operation: 'create',
    });
    expect((await store.collections({ operation: 'list' })).collections).toHaveLength(2);
  } finally {
    await store.close();
  }
});

test('collection deletion preserves its canonical source bytes and identity', async () => {
  const directory = freshDir('collection-retains-source');
  const { TruthIndexer } = await import('./helpers/truth-indexer.js');
  const { createHash } = await import('node:crypto');
  const indexer = new TruthIndexer(directory);
  const store = await StateStore.open(directory, { indexer });
  try {
    await store.collections({ collection, operation: 'create' });
    await store.workspaceRoots({
      operation: 'register',
      root: { displayName: 'root', path: '/disposable/root', preferredId: 'root' },
    });
    const content = 'Source retained after removing its collection';
    const files = (
      await store.sourceCatalog({
        embeddingSetId: collection.id,
        files: [
          {
            content,
            contentHash: createHash('sha256').update(content).digest('hex'),
            fileName: 'retained.txt',
            path: 'retained.txt',
            stat: { mtimeMs: null, size: Buffer.byteLength(content) },
          },
        ],
        operation: 'prepare',
        rootId: 'root',
      })
    ).files;
    const first = files[0];
    if (!first) {
      throw new Error('Source write omitted identity');
    }
    await store.sourceCatalog({
      files: [{ chunkCount: 3, expected: first }],
      operation: 'complete',
    });
    await store.collections({ id: collection.id, operation: 'delete' });
    expect((await store.collections({ operation: 'list' })).collections).toEqual([]);
    expect(
      (
        await store.sourceCatalog({
          fileIds: [first.fileId],
          maxContentBytes: Buffer.byteLength(content),
          operation: 'read',
        })
      ).files[0]
    ).toEqual({ ...first, chunksCount: 3, chunksProcessed: true, content });
  } finally {
    await store.close();
    indexer.close();
  }
});
