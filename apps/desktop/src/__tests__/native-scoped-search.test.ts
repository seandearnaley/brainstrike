// @vitest-environment node
import {
  embeddingProfileHash,
  type IndexerPort,
  type ScopedCoverageRequest,
  type ScopedIndexerPort,
  type VectorProfile,
  vectorProfileHash,
} from '@brainstrike/indexer';
import type { SqliteGrepRows } from '@brainstrike/sqlite-query';
import { expect, it, vi } from 'vitest';
import { createBenchmarkProgress } from '../../qualification/m2-native/benchmark-progress';
import { nativeBuildComplete } from '../../qualification/m2-native/native-benchmark';
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

function progressAuthority(f: ReturnType<typeof fixture>): NativeSearchAuthority {
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

it('projects historical native ACK identity independently of newer admission revision', async () => {
  const f = fixture(profile);
  f.replaceAuthority(progressAuthority(f));
  expect(await f.capability.status()).toMatchObject({
    collectionReadiness: [{ scanComplete: false }],
    publicationProgress: [
      {
        acknowledgedFiles: 1,
        authorityEpoch: 'historical-epoch',
        authorityRevision: 3,
        mutationRevision: 2,
        ownerGeneration: 1,
        profileHash: embeddingProfileHash({
          dimensions: profile.dimensions,
          dtype: profile.dtype,
          modelId: profile.modelId,
          revision: profile.revision,
          tokenCap: profile.tokenCap,
        }),
        requestId: 'scan',
        scanGeneration: 1,
        scope,
        storeId,
      },
    ],
  });
});

it('refuses a progress identity whose scan generation changes during status capture', async () => {
  const f = fixture(profile);
  f.replaceAuthority(progressAuthority(f));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const info = f.port.info;
  let calls = 0;
  f.port.info = async () => {
    if (++calls === 1) {
      entered.resolve();
      await release.promise;
    }
    return info();
  };
  const result = f.capability.status();
  await entered.promise;
  f.replaceAuthority({
    ...f.getAuthority(),
    readiness: [{ generation: 2, mutationRevision: 100, scanComplete: false, scope }],
  });
  release.resolve();
  expect(await result).toMatchObject({
    kind: 'unavailable',
    reason: expect.stringContaining('changed'),
  });
});

it('keeps scan-start status interleaving nonterminal in the actual benchmark progress seam without credit', async () => {
  const f = fixture(profile);
  const workspace = { kind: 'workspace', rootId: 'root' } as const;
  f.replaceAuthority({
    ...f.getAuthority(),
    readiness: [scope, workspace].map((selected) => ({
      generation: 0,
      mutationRevision: 0,
      scanComplete: false,
      scope: selected,
    })),
    rootIds: ['root'],
  });
  const baseline = await f.capability.status();
  if (baseline.kind !== 'ready') {
    throw new Error('Expected the cold ready status');
  }
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const info = f.port.info;
  let calls = 0;
  f.port.info = async () => {
    if (++calls === 1) {
      entered.resolve();
      await release.promise;
    }
    return info();
  };
  const reading = f.capability.status();
  await entered.promise;
  f.replaceAuthority({
    ...f.getAuthority(),
    readiness: f
      .getAuthority()
      .readiness.map((receipt) => ({ ...receipt, generation: 1, mutationRevision: 1 })),
  });
  release.resolve();
  const status = await reading;
  expect(status.kind).toBe('unavailable');
  let now = 0;
  const record = vi.fn(async (_phase: string, _value: unknown) => {});
  const snapshot = {
    collectionCoverage: null,
    coverage: null,
    inference: {
      active: false,
      lastError: null,
      runtimeId: 'stopped',
      runtimeKind: 'embedding-host' as const,
      state: 'stopped' as const,
    },
    status,
  };
  const progress = createBenchmarkProgress({
    baseline,
    now: () => now,
    readCoverage: async () => snapshot,
    readStatus: async () => status,
    record,
    startedAt: 0,
  });
  expect(await progress.observe()).toBe(snapshot);
  expect(record).toHaveBeenCalledOnce();
  expect(record.mock.calls[0]?.[0]).toBe('benchmark-progress-baseline');
  expect(await f.capability.status()).toMatchObject({ kind: 'ready', publicationProgress: [] });
  now = 200_001;
  expect(progress.assertLive).toThrow(/200-second stall window/);
});

it('returns a same-owner historical ACK snapshot when later ACK authority advances during status capture', async () => {
  const f = fixture(profile);
  f.replaceAuthority(progressAuthority(f));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const info = f.port.info;
  let calls = 0;
  f.port.info = async () => {
    if (++calls === 1) {
      entered.resolve();
      await release.promise;
    }
    return info();
  };
  const reading = f.capability.status();
  await entered.promise;
  const receipt = f.getAuthority().readiness[0]!;
  f.replaceAuthority({
    ...f.getAuthority(),
    readiness: [
      {
        ...receipt,
        mutationRevision: 100,
        publication: {
          ...receipt.publication!,
          acknowledgedFiles: 2,
          authorityEpoch: 'advanced',
          authorityRevision: 10,
          mutationRevision: 100,
        },
      },
    ],
  });
  release.resolve();
  expect(await reading).toMatchObject({
    kind: 'ready',
    publicationProgress: [
      { acknowledgedFiles: 1, authorityEpoch: 'historical-epoch', mutationRevision: 2 },
    ],
  });
  expect(await f.capability.status()).toMatchObject({
    kind: 'ready',
    publicationProgress: [
      { acknowledgedFiles: 2, authorityEpoch: 'advanced', mutationRevision: 100 },
    ],
  });
});

it.each(['store', 'profile', 'generation', 'scope'] as const)(
  'refuses a mismatched historical publication %s',
  async (field) => {
    const f = fixture(profile);
    const authority = progressAuthority(f);
    const receipt = authority.readiness[0]!;
    const publication = receipt.publication!;
    f.replaceAuthority({
      ...authority,
      readiness: [
        {
          ...receipt,
          ...(field === 'scope'
            ? { scope: { embeddingSetId: 'foreign', kind: 'collection' } as const }
            : {}),
          publication: {
            ...publication,
            ...(field === 'store'
              ? { storeId: 'foreign' }
              : field === 'profile'
                ? { profileHash: 'foreign' }
                : field === 'generation'
                  ? { generation: 99 }
                  : {}),
          },
        },
      ],
    });
    expect(await f.capability.status()).toMatchObject({ kind: 'unavailable' });
  }
);

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

it.each(['generation', 'root', 'collection', 'profile', 'store'] as const)(
  'refuses a held scoped search after genuine %s replacement',
  async (changed) => {
    const f = fixture(profile);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = await f.searchScopes({
      limit: 10,
      mode: 'bm25',
      scopes: [scope],
      text: 'marker',
    });
    f.searchScopes.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return original;
    });
    const outcome = f.capability
      .search({ collectionId: 'selected', limit: 10, mode: 'bm25', rootIds: [], text: 'marker' })
      .catch((error: unknown) => error);
    await entered.promise;
    const authority = f.getAuthority();
    if (changed === 'generation') {
      f.replaceAuthority({ ...authority, generation: 2 });
    }
    if (changed === 'root') {
      f.replaceAuthority({ ...authority, rootIds: ['foreign'] });
    }
    if (changed === 'collection') {
      f.replaceAuthority({ ...authority, collectionId: 'replacement' });
    }
    if (changed === 'profile') {
      f.replaceAuthority({ ...authority, profile: { ...profile, tokenCap: 128 } });
    }
    if (changed === 'store') {
      f.replaceStore();
    }
    release.resolve();
    expect(await outcome).toEqual(
      new Error('Native source or saved profile changed during search.')
    );
  }
);

function pairedFixture() {
  const f = fixture(profile);
  f.replaceAuthority({
    ...f.getAuthority(),
    bindings: [{ ...binding, profile, relativePath: 'file.txt', rootId: 'root' }],
    readiness: [
      { generation: 1, mutationRevision: 0, scanComplete: true, scope },
      {
        generation: 1,
        mutationRevision: 0,
        scanComplete: true,
        scope: { kind: 'workspace', rootId: 'root' },
      },
    ],
    rootIds: ['root'],
  });
  return f;
}
const pairedRequests = [{ collectionId: 'selected', rootIds: [] }, { rootIds: ['root'] }];
it('returns both independent coverage results and readiness from the same fenced observation', async () => {
  const f = pairedFixture();
  const result = await f.capability.coverageBatch(pairedRequests);
  if (result.kind !== 'current') {
    throw new Error('Expected a current fenced batch.');
  }
  expect(result.coverage.map((entry) => entry.totals.chunks)).toEqual([3, 2]);
  expect(result.status).toMatchObject({
    collectionReadiness: [{ embeddingSetId: 'selected', scanComplete: true }],
    kind: 'ready',
    rootReadiness: [{ rootId: 'root', scanComplete: true }],
  });
  expect(f.coverageBatch).toHaveBeenCalledExactlyOnceWith([
    { profile, scope },
    { profile, scope: { kind: 'workspace', rootId: 'root' } },
  ]);
});
it.each([
  'roots',
  'bindings',
  'profile',
  'collection',
  'generation',
  'readiness',
  'owner',
] as const)('rejects a %s invalidation during the admitted batch', async (change) => {
  const f = pairedFixture();
  const original = f.coverageBatch.getMockImplementation()!;
  f.coverageBatch.mockImplementationOnce(async (requests) => {
    const result = await original(requests);
    const authority = f.getAuthority();
    if (change === 'owner') {
      f.replaceStore();
    } else {
      f.replaceAuthority({
        ...authority,
        ...(change === 'roots' ? { rootIds: [] } : {}),
        ...(change === 'bindings' ? { bindings: [] } : {}),
        ...(change === 'profile' ? { profile: null } : {}),
        ...(change === 'collection' ? { collectionId: 'replacement' } : {}),
        ...(change === 'generation' ? { generation: authority.generation + 1 } : {}),
        ...(change === 'readiness' ? { readiness: [] } : {}),
      });
    }
    return result;
  });
  await expect(f.capability.coverageBatch(pairedRequests)).resolves.toEqual({
    code: 'native-coverage-observation-invalidated',
    kind: 'invalidated',
  });
});
it('does not pair an earlier successful status with full counters after readiness invalidation', async () => {
  const f = pairedFixture();
  const staleStatus = await f.capability.status();
  expect(staleStatus).toMatchObject({ collectionReadiness: [{ scanComplete: true }] });
  f.replaceAuthority({
    ...f.getAuthority(),
    generation: 2,
    readiness: [
      { generation: 2, mutationRevision: 1, scanComplete: false, scope },
      {
        generation: 1,
        mutationRevision: 0,
        scanComplete: true,
        scope: { kind: 'workspace', rootId: 'root' },
      },
    ],
  });
  const result = await f.capability.coverageBatch(pairedRequests);
  if (result.kind !== 'current') {
    throw new Error('Expected a current fenced batch.');
  }
  expect(result.coverage.every((entry) => entry.vectorCoverageComplete)).toBe(true);
  expect(result.status).toMatchObject({ collectionReadiness: [{ scanComplete: false }] });
  const { provider: _provider, distance: _distance, ...queryProfile } = profile;
  const completionScope = {
    collectionId: 'selected',
    files: 1,
    mode: 'vector' as const,
    profile: queryProfile,
    rootId: 'root',
    storeId,
  };
  expect(
    nativeBuildComplete(staleStatus, result.coverage[1]!, completionScope, result.coverage[0]!)
  ).toBe(true);
  expect(
    nativeBuildComplete(result.status, result.coverage[1]!, completionScope, result.coverage[0]!)
  ).toBe(false);
});

it('rejects an invalidate-and-rescan cycle even when the readiness boolean returns to true', async () => {
  const f = pairedFixture();
  const original = f.coverageBatch.getMockImplementation()!;
  f.coverageBatch.mockImplementationOnce(async (requests) => {
    const result = await original(requests);
    const authority = f.getAuthority();
    f.replaceAuthority({
      ...authority,
      readiness: authority.readiness.map((entry) => ({
        ...entry,
        generation: entry.generation + 1,
        mutationRevision: entry.mutationRevision + 1,
      })),
    });
    return result;
  });
  await expect(f.capability.coverageBatch(pairedRequests)).resolves.toEqual({
    code: 'native-coverage-observation-invalidated',
    kind: 'invalidated',
  });
});
