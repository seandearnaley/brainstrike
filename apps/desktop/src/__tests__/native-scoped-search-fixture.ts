import {
  type IndexerPort,
  type ScopedCoverageRequest,
  type ScopedIndexerPort,
  type VectorProfile,
  vectorProfileHash,
} from '@brainstrike/indexer';
import type { SqliteGrepRows } from '@brainstrike/sqlite-query';
import { vi } from 'vitest';
import {
  createNativeScopedSearchCapability,
  type NativeSearchAuthority,
} from '../native-scoped-search';

export const storeId = 'a'.repeat(64);
export const scope = { embeddingSetId: 'selected', kind: 'collection' } as const;
export const profile = {
  dimensions: 384,
  distance: 'cosine',
  dtype: 'q8',
  modelId: 'Xenova/all-MiniLM-L6-v2',
  provider: 'local',
  revision: '751bff37182d3f1213fa05d7196b954e230abad9',
  tokenCap: 256,
} as const;
export const binding = {
  embeddingSetId: 'selected',
  fileId: 'retained',
  relativePath: null,
  rootId: null,
  sourcePath: null,
};
export const hit = {
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
export const unused = async (): Promise<never> => {
  throw new Error('Unexpected legacy index API.');
};
export function fixture(selectedProfile: VectorProfile | null = null) {
  let currentStoreId = storeId;
  let authority: NativeSearchAuthority = {
    bindings: [{ ...binding, profile: selectedProfile }],
    collectionId: 'selected',
    generation: 1,
    profile: selectedProfile,
    queryPlan: undefined,
    readiness: [{ generation: 1, mutationRevision: 0, scanComplete: true, scope }],
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
  const coverageBatch = vi.fn<ScopedIndexerPort['coverageBatch']>(async (input) =>
    (input as readonly ScopedCoverageRequest[]).map(({ scope: requestedScope }) => ({
      authorityEpoch: 'd'.repeat(64),
      authorityRevision: 1,
      counts: {
        chunks: authority.rootIds.length === 0 ? 1 : requestedScope.kind === 'workspace' ? 2 : 3,
        indexedFiles: 1,
        missingVectors:
          selectedProfile === null
            ? authority.rootIds.length === 0
              ? 1
              : requestedScope.kind === 'workspace'
                ? 2
                : 3
            : 0,
        vectors:
          selectedProfile === null
            ? 0
            : authority.rootIds.length === 0
              ? 1
              : requestedScope.kind === 'workspace'
                ? 2
                : 3,
      },
      profile: selectedProfile,
      profileHash: selectedProfile === null ? null : vectorProfileHash(selectedProfile),
      scope: requestedScope,
      storeId,
      vectorCoverageComplete: selectedProfile !== null,
    }))
  );
  const port: IndexerPort & ScopedIndexerPort = {
    close: unused,
    commitFile: unused,
    commitScopedFile: unused,
    commitScopedTextFile: unused,
    commitTextFile: unused,
    configureVectorProfile: unused,
    coverage: unused,
    coverageBatch,
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
      storeId: currentStoreId,
      vecVersion: '0.1.9',
      writerThreadId: 1,
    }),
    prepareFile: unused,
    prepareScopedFile: unused,
    readScopedFileChunkBounds: unused,
    readScopedFilePage: unused,
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
    openQuery: async () => ({ close, grep }),
    rebuild: async () => {},
    withRead: (work) => work({ getAuthority: async () => authority, port }),
  });
  return {
    capability,
    close,
    coverageBatch,
    getAuthority: () => authority,
    grep,
    port,
    replaceAuthority: (next: NativeSearchAuthority) => {
      authority = next;
    },
    replaceStore: () => {
      currentStoreId = 'e'.repeat(64);
    },
    searchScopes,
  };
}

export function progressAuthority(f: ReturnType<typeof fixture>): NativeSearchAuthority {
  return {
    ...f.getAuthority(),
    readiness: [
      {
        generation: 1,
        mutationRevision: 99,
        publication: {
          acknowledgedFiles: 1,
          authorityEpoch: 'historical-epoch',
          authorityRevision: 3,
          generation: 1,
          mutationRevision: 2,
          profileHash: vectorProfileHash(profile),
          requestId: 'scan',
          storeId,
        },
        scanComplete: false,
        scope,
      },
    ],
  };
}
