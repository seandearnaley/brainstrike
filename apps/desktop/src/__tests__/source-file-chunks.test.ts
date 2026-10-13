import type { SourceCatalogRecord } from '@brainstrike/state-store';
import { expect, test, vi } from 'vitest';
import { createSourceChunkReader } from '../source-file-chunks';

const file: SourceCatalogRecord = {
  chunksCount: 1,
  chunksProcessed: true,
  content: null,
  contentHash: 'source',
  createdAt: '2026-10-13T20:00:00Z',
  embeddingSetId: 'collection',
  fileId: 'one',
  fileName: 'one.txt',
  path: '/one.txt',
  rootId: null,
  stat: { mtimeMs: null, size: 4 },
  updatedAt: '2026-10-13T20:00:00Z',
};
test('Library page uses catalog identity under an admitted native lease and observes authority after the read', async () => {
  const getAuthority = vi.fn(async () => ({
    bindings: [
      {
        embeddingSetId: 'collection',
        fileId: 'one',
        profile: null,
        relativePath: null,
        rootId: null,
        sourcePath: '/one.txt',
      },
    ],
  }));
  const readScopedFilePage = vi.fn(async () => ({
    authorityEpoch: 'epoch',
    authorityRevision: 1,
    chunks: [],
    contentHash: 'source',
    fileId: 'one',
    nextOffset: null,
    profileHash: null,
    snapshotHash: 'snapshot',
    storeId: 'store',
    total: 0,
  }));
  const read = createSourceChunkReader({
    catalog: { sourceCatalog: async () => ({ files: [file] }) },
    withRead: async (work) => await work({ getAuthority, port: { readScopedFilePage } }),
  });
  expect(await read({ fileId: 'one', limit: 100, offset: 0 })).toMatchObject({
    fileId: 'one',
    kind: 'available',
  });
  expect(readScopedFilePage).toHaveBeenCalledWith({
    contentHash: 'source',
    fileId: 'one',
    limit: 100,
    offset: 0,
    scope: { embeddingSetId: 'collection', kind: 'collection' },
  });
  expect(getAuthority).toHaveBeenCalledTimes(2);
});
test('an inactive canonical file is explicitly unavailable and never queried as an authorized root', async () => {
  const readScopedFilePage = vi.fn();
  const read = createSourceChunkReader({
    catalog: { sourceCatalog: async () => ({ files: [file] }) },
    withRead: async (work) =>
      await work({ getAuthority: async () => ({ bindings: [] }), port: { readScopedFilePage } }),
  });
  expect(await read({ fileId: 'one', limit: 100, offset: 0 })).toMatchObject({
    kind: 'unavailable',
  });
  expect(readScopedFilePage).not.toHaveBeenCalled();
});
