// @vitest-environment node
import {
  embeddingProfileHash,
  type IndexerPort,
  type ScopedIndexerPort,
  type VectorProfile,
  vectorProfileHash,
} from '@brainstrike/indexer';
import type { SqliteGrepRows } from '@brainstrike/sqlite-query';
import { expect, it, vi } from 'vitest';
import {
  createNativeScopedSearchCapability,
  type NativeSearchAuthority,
} from '../native-scoped-search';

const storeId = 'a'.repeat(64);
const scope = { embeddingSetId: 'selected', kind: 'collection' } as const;
const profile = {
  dimensions: 384,
  distance: 'cosine',
  dtype: 'q8',
  modelId: 'Xenova/all-MiniLM-L6-v2',
  provider: 'local',
  revision: '751bff37182d3f1213fa05d7196b954e230abad9',
  tokenCap: 256,
} as const;
const binding = {
  embeddingSetId: 'selected',
  fileId: 'retained',
  relativePath: null,
  rootId: null,
  sourcePath: null,
};
const hit = {
  ...binding,
  chunkId: 'b'.repeat(64),
  chunkIndex: 0,
  chunkSize: 384,
  chunkType: 'text' as const,
  content: 'retained marker',
  contentHash: 'c'.repeat(64),
  endLine: 1,
  endOffset: 15,
  score: 1,
  startLine: 1,
  startOffset: 0,
  tokenCount: 3,
};
const unused = async (): Promise<never> => {
  throw new Error('Unexpected legacy index API.');
};
function fixture(selectedProfile: VectorProfile | null = null) {
  let authority: NativeSearchAuthority = {
    bindings: [{ ...binding, profile: selectedProfile }],
    collectionId: 'selected',
    generation: 1,
    profile: selectedProfile,
    queryPlan: undefined,
    readiness: [{ scanComplete: true, scope }],
    rootIds: [],
  };
  const searchScopes = vi.fn<ScopedIndexerPort['searchScopes']>(async () => ({
    candidateCount: 1,
    candidatesTruncated: false,
    hits: [hit],
    profile: selectedProfile,
    profileHash: selectedProfile === null ? null : vectorProfileHash(selectedProfile),
    scanLimited: false,
    storeId,
    truncated: false,
  }));
  const port: IndexerPort & ScopedIndexerPort = {
    close: unused,
    commitFile: unused,
    commitScopedFile: unused,
    commitScopedTextFile: unused,
    commitTextFile: unused,
    configureVectorProfile: unused,
    coverage: unused,
    coverageScope: async () => ({
      authorityEpoch: 'd'.repeat(64),
      authorityRevision: 1,
      counts: {
        chunks: 1,
        indexedFiles: 1,
        missingVectors: selectedProfile === null ? 1 : 0,
        vectors: selectedProfile === null ? 0 : 1,
      },
      profile: selectedProfile,
      profileHash: selectedProfile === null ? null : vectorProfileHash(selectedProfile),
      scope,
      storeId,
      vectorCoverageComplete: selectedProfile !== null,
    }),
    destroy: unused,
    info: async () => ({
      dbPath: '/actual/index.sqlite',
      embedding: { indexMode: 'text-only' },
      journalMode: 'wal',
      pid: 1,
      readerQueryOnly: 1,
      storeId,
      vecVersion: '0.1.9',
      writerThreadId: 1,
    }),
    prepareFile: unused,
    prepareScopedFile: unused,
    removeFile: unused,
    removeScopedFile: unused,
    replaceFileBindings: unused,
    search: unused,
    searchScopes,
    verifyManifest: unused,
    verifyScopedManifest: unused,
  };
  const grep = vi.fn(
    async (): Promise<SqliteGrepRows> => ({
      columns: [
        'id',
        'root_id',
        'file_record_id',
        'path',
        'content',
        'content_hash',
        'start_line',
        'end_line',
        'chunk_index',
        'chunk_size',
        'chunk_type',
        'start_offset',
        'end_offset',
        'token_count',
        'embedding_set_id',
        'source_path',
      ],
      identity: { embedding: { indexMode: 'text-only' }, storeId },
      matchedChunks: 1,
      rows: [
        [
          hit.chunkId,
          null,
          binding.fileId,
          null,
          hit.content,
          hit.contentHash,
          1,
          1,
          0,
          384,
          'text',
          0,
          15,
          3,
          'selected',
          null,
        ],
      ],
      truncated: false,
    })
  );
  const close = vi.fn(async () => {});
  const capability = createNativeScopedSearchCapability({
    acquireIndexer: async () => port,
    getAuthority: async () => authority,
    openQuery: async () => ({ close, grep }),
    rebuild: async () => {},
  });
  return {
    capability,
    close,
    getAuthority: () => authority,
    grep,
    replaceAuthority: (next: NativeSearchAuthority) => {
      authority = next;
    },
    searchScopes,
  };
}

it('projects actual rootless collection scope through text, grep and coverage without legacy reads', async () => {
  const f = fixture();
  expect(await f.capability.status()).toMatchObject({
    authorizedCollectionIds: ['selected'],
    authorizedRootIds: [],
    kind: 'ready',
  });
  const result = await f.capability.search({
    collectionId: 'selected',
    limit: 100,
    mode: 'bm25',
    rootIds: [],
    text: 'marker',
  });
  expect(result.hits).toEqual([hit]);
  expect(f.searchScopes).toHaveBeenCalledExactlyOnceWith({
    limit: 100,
    mode: 'bm25',
    scopes: [scope],
    text: 'marker',
  });
  await f.capability.grep({
    caseSensitive: false,
    collectionId: 'selected',
    isRegex: false,
    limit: 100,
    pattern: 'marker',
    rootIds: [],
  });
  expect(f.grep).toHaveBeenCalledExactlyOnceWith({
    caseSensitive: false,
    fileIds: ['retained'],
    isRegex: false,
    maxRows: 100,
    pattern: 'marker',
    rootIds: [],
  });
  expect(f.close).toHaveBeenCalledOnce();
  expect(await f.capability.coverage({ collectionId: 'selected', rootIds: [] })).toMatchObject({
    collections: [{ chunks: 1, embeddingSetId: 'selected' }],
    roots: [],
  });
  await expect(
    f.capability.search({
      collectionId: 'foreign',
      limit: 10,
      mode: 'bm25',
      rootIds: [],
      text: 'marker',
    })
  ).rejects.toThrow('not authorized');
});

it('uses the full saved scoped vector profile while the independent legacy engine is TEXT', async () => {
  const f = fixture(profile);
  const { provider: _provider, distance: _distance, ...queryProfile } = profile;
  expect(await f.capability.status()).toMatchObject({
    embedding: {
      indexMode: 'vector-configured',
      profile: queryProfile,
      profileHash: embeddingProfileHash(queryProfile),
    },
  });
  const vector = Array.from({ length: 384 }, () => 1);
  await f.capability.search({
    collectionId: 'selected',
    limit: 100,
    mode: 'vector',
    profile: queryProfile,
    rootIds: [],
    vector,
  });
  expect(f.searchScopes).toHaveBeenCalledWith({
    limit: 100,
    mode: 'vector',
    profile,
    scopes: [scope],
    vector,
  });
  expect(await f.capability.coverage({ collectionId: 'selected', rootIds: [] })).toMatchObject({
    totals: { missingVectors: 0, vectors: 1 },
    vectorCoverageComplete: true,
  });
  await expect(
    f.capability.search({
      collectionId: 'selected',
      limit: 100,
      mode: 'vector',
      profile: { ...queryProfile, tokenCap: 128 },
      rootIds: [],
      vector,
    })
  ).rejects.toThrow('differs');
});

it('joins the grep reader but refuses its result after canonical collection authority changes', async () => {
  const f = fixture();
  const held = Promise.withResolvers<SqliteGrepRows>();
  f.grep.mockReturnValueOnce(held.promise);
  const outcome = f.capability.grep({
    caseSensitive: false,
    collectionId: 'selected',
    isRegex: false,
    limit: 100,
    pattern: 'marker',
    rootIds: [],
  });
  await vi.waitFor(() => expect(f.grep).toHaveBeenCalledOnce());
  f.replaceAuthority({ ...f.getAuthority(), generation: 2 });
  held.resolve({
    columns: [
      'id',
      'root_id',
      'file_record_id',
      'path',
      'content',
      'content_hash',
      'start_line',
      'end_line',
      'chunk_index',
      'chunk_size',
      'chunk_type',
      'start_offset',
      'end_offset',
      'token_count',
      'embedding_set_id',
      'source_path',
    ],
    identity: { embedding: { indexMode: 'text-only' }, storeId },
    matchedChunks: 0,
    rows: [],
    truncated: false,
  });
  await expect(outcome).rejects.toThrow('changed during search');
  expect(f.close).toHaveBeenCalledOnce();
});
