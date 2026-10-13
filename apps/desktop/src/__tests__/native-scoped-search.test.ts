// @vitest-environment node
import { createHash } from 'node:crypto';
import { embeddingProfileHash, vectorProfileHash } from '@brainstrike/indexer';
import { indexerEmbeddingProfileValues } from '@brainstrike/indexing-contract/indexer-client';
import type { SqliteGrepRows } from '@brainstrike/sqlite-query';
import { expect, it, vi } from 'vitest';
import { createBenchmarkProgress } from '../../qualification/m2-native/benchmark-progress';
import { nativeBuildComplete } from '../../qualification/m2-native/native-benchmark';
import { NativeAuthorityTransitionError } from '../native-authority-transition';
import { createNativeScopedSearchCapability } from '../native-scoped-search';
import {
  binding,
  fixture,
  hit,
  profile,
  progressAuthority,
  scope,
  storeId,
  unused,
} from './native-scoped-search-fixture';

it('keeps an unrelated same-message status failure fatal', async () => {
  const f = fixture();
  const failure = new Error('Native source authority changed.');
  f.port.info = async () => {
    throw failure;
  };
  await expect(f.capability.status()).rejects.toBe(failure);
});
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

it('withholds old progress while a new scan starts during status capture', async () => {
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
    collectionReadiness: [{ scanComplete: false }],
    kind: 'ready',
    publicationProgress: [],
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
  expect(status).toMatchObject({
    kind: 'ready',
    publicationProgress: [],
    rootReadiness: [{ scanComplete: false }],
  });
  let now = 0;
  const record = vi.fn(async (_phase: string, _value: unknown) => {});
  const progress = createBenchmarkProgress({
    baseline,
    now: () => now,
    readCoverage: async () => null,
    readStatus: async () => status,
    record,
    startedAt: 0,
  });
  expect(await progress.observe()).toBeNull();
  expect(record).toHaveBeenCalledOnce();
  expect(record.mock.calls[0]?.[0]).toBe('benchmark-progress-baseline');
  expect(await f.capability.status()).toMatchObject({ kind: 'ready', publicationProgress: [] });
  now = 200_001;
  expect(progress.assertLive).toThrow(/200-second stall window/);
});

it('withholds captured completion and ACK when publication advances during status capture', async () => {
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
    collectionReadiness: [{ scanComplete: false }],
    kind: 'ready',
    publicationProgress: [],
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
    await expect(f.capability.status()).rejects.toThrow(
      'Native publication progress differs from the current store, profile, generation or scope.'
    );
  }
);

it.each(['store', 'profile', 'generation', 'scope'] as const)(
  'rejects corrupt current publication %s even when its readiness proof changes',
  async (field) => {
    const f = fixture(profile);
    f.replaceAuthority(progressAuthority(f));
    const original = f.coverageBatch.getMockImplementation()!;
    f.coverageBatch.mockImplementationOnce(async (requests) => {
      const rows = await original(requests);
      f.replaceAuthority({
        ...f.getAuthority(),
        readiness: f.getAuthority().readiness.map((entry) => ({
          ...entry,
          mutationRevision: entry.mutationRevision + 1,
          ...(field === 'scope'
            ? { scope: { embeddingSetId: 'foreign', kind: 'collection' as const } }
            : {}),
          publication: {
            ...entry.publication!,
            ...(field === 'store'
              ? { storeId: 'foreign' }
              : field === 'profile'
                ? { profileHash: 'foreign' }
                : field === 'generation'
                  ? { generation: 99 }
                  : {}),
          },
        })),
      });
      return rows;
    });
    await expect(
      f.capability.coverageBatch([{ collectionId: 'selected', rootIds: [] }])
    ).rejects.toThrow('Native publication progress differs');
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

it('reports a CLS, prompted profile in status with the identity the renderer mirror computes (BST-1993)', async () => {
  const granite = {
    dimensions: 384,
    distance: 'cosine',
    dtype: 'fp16',
    modelId: 'onnx-community/granite-embedding-small-english-r2-ONNX',
    pooling: 'cls',
    prompts: { document: 'doc: ', query: 'ask: ' },
    provider: 'local',
    revision: '1dc7835ba0cb9c76a3618d0bf0c427c97671b3c8',
  } as const;
  const f = fixture(granite);
  const status = await f.capability.status();
  if (status.kind !== 'ready' || status.embedding.indexMode !== 'vector-configured') {
    throw new Error('A configured granite store must report its vector profile.');
  }
  expect(status.embedding.profile).toEqual(granite);
  expect(status.embedding.profileHash).toBe(vectorProfileHash(granite));
  const mirrored = createHash('sha256')
    .update(JSON.stringify(indexerEmbeddingProfileValues(status.embedding.profile)))
    .digest('hex');
  expect(mirrored).toBe(status.embedding.profileHash);
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
    const failure = await outcome;
    expect(failure).toBeInstanceOf(changed === 'store' ? Error : NativeAuthorityTransitionError);
    expect(failure).toMatchObject({
      message:
        changed === 'store'
          ? 'Native store changed during search.'
          : 'Native source or saved profile changed during search.',
    });
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
it.each([
  { commits: 2, complete: false },
  { commits: 0, complete: true },
  { commits: 2, complete: true },
])(
  'retains partial coverage after $commits commits with completion=$complete',
  async ({ commits, complete }) => {
    const f = pairedFixture();
    f.replaceAuthority({
      ...f.getAuthority(),
      readiness: f.getAuthority().readiness.map((entry) => ({ ...entry, scanComplete: false })),
    });
    const original = f.coverageBatch.getMockImplementation()!;
    f.coverageBatch.mockImplementationOnce(async (requests) => {
      const result = await original(requests);
      f.replaceAuthority({
        ...f.getAuthority(),
        readiness: f.getAuthority().readiness.map((entry) => ({
          ...entry,
          mutationRevision: entry.mutationRevision + commits,
          scanComplete: complete,
        })),
      });
      return result;
    });
    const observation = await f.capability.coverageBatch(pairedRequests);
    expect(observation).toMatchObject({
      kind: 'current',
      status: {
        collectionReadiness: [{ scanComplete: false }],
        rootReadiness: [{ scanComplete: false }],
      },
    });
    if (observation.kind !== 'current') {
      throw new Error('Expected actual partial coverage during publication.');
    }
    expect(observation.coverage.map((entry) => entry.totals.chunks)).toEqual([3, 2]);
    expect(f.coverageBatch).toHaveBeenCalledOnce();
    expect(await f.capability.status()).toMatchObject({
      collectionReadiness: [{ scanComplete: complete }],
      rootReadiness: [{ scanComplete: complete }],
    });
  }
);

it.each(['new-scan', 'completed-mutation', 'completed-rescan'] as const)(
  'keeps committed coverage partial when %s changes its completion proof',
  async (change) => {
    const f = pairedFixture();
    f.replaceAuthority({
      ...f.getAuthority(),
      readiness: f.getAuthority().readiness.map((entry) => ({
        ...entry,
        scanComplete: true,
      })),
    });
    const original = f.coverageBatch.getMockImplementation()!;
    f.coverageBatch.mockImplementationOnce(async (requests) => {
      const result = await original(requests);
      f.replaceAuthority({
        ...f.getAuthority(),
        readiness: f.getAuthority().readiness.map((entry) => ({
          ...entry,
          generation: entry.generation + Number(change !== 'completed-mutation'),
          mutationRevision: entry.mutationRevision + 1,
          scanComplete: change !== 'new-scan',
        })),
      });
      return result;
    });
    await expect(f.capability.coverageBatch(pairedRequests)).resolves.toMatchObject({
      kind: 'current',
      status: {
        collectionReadiness: [{ scanComplete: false }],
        publicationProgress: [],
        rootReadiness: [{ scanComplete: false }],
      },
    });
  }
);

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
  'queryPlan',
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
        ...(change === 'queryPlan' ? { queryPlan: { modelKey: 'changed' } } : {}),
      });
    }
    return result;
  });
  if (change === 'owner') {
    await expect(f.capability.coverageBatch(pairedRequests)).rejects.toThrow(
      'Native store changed during search.'
    );
    return;
  }
  await expect(f.capability.coverageBatch(pairedRequests)).resolves.toEqual({
    cause: { kind: 'transitioning' },
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

it.each(['status', 'coverageBatch'] as const)(
  'keeps %s acquisition and cleanup failures fatal',
  async (method) => {
    const f = fixture();
    for (const failure of [
      new Error('Native read admission is closed.'),
      new AggregateError(
        [
          new NativeAuthorityTransitionError('Native source authority changed.'),
          new Error('Independent cleanup failed.'),
        ],
        'Read cleanup failed.'
      ),
    ]) {
      const capability = createNativeScopedSearchCapability({
        openQuery: unused,
        rebuild: unused,
        withRead: async () => {
          throw failure;
        },
      });
      await expect(
        method === 'status'
          ? capability.status()
          : capability.coverageBatch([{ collectionId: 'selected', rootIds: [] }])
      ).rejects.toBe(failure);
    }
    const entered = Promise.withResolvers<void>();
    const exited = Promise.withResolvers<void>();
    let settled = false;
    const capability = createNativeScopedSearchCapability({
      openQuery: unused,
      rebuild: unused,
      withRead: async () => {
        try {
          throw new NativeAuthorityTransitionError('Native source authority changed.');
        } finally {
          entered.resolve();
          await exited.promise;
        }
      },
    });
    const result = (
      method === 'status'
        ? capability.status()
        : capability.coverageBatch([{ collectionId: 'selected', rootIds: [] }])
    ).then((value) => {
      settled = true;
      return value;
    });
    await entered.promise;
    expect(settled).toBe(false);
    exited.resolve();
    expect(await result).toMatchObject({
      kind: method === 'status' ? 'unavailable' : 'invalidated',
    });
    expect(f.coverageBatch).not.toHaveBeenCalled();
  }
);

it('restricts canonical file membership before the native grep candidate limit', async () => {
  const f = fixture();
  const recorded = await f.grep();
  f.grep.mockClear();
  f.replaceAuthority({
    ...f.getAuthority(),
    bindings: [
      { ...binding, profile: null, relativePath: 'selected.md', rootId: 'root' },
      {
        ...binding,
        fileId: 'unselected',
        profile: null,
        relativePath: 'unselected.md',
        rootId: 'root',
      },
    ],
    rootIds: ['root'],
  });
  f.grep.mockResolvedValueOnce({
    ...recorded,
    rows: recorded.rows.map((row) =>
      row.map((value, i) => (i === 1 ? 'root' : i === 3 ? 'selected.md' : value))
    ),
  });
  const result = await f.capability.grep({
    caseSensitive: false,
    filePaths: ['selected.md'],
    isRegex: false,
    limit: 1,
    pattern: 'marker',
    rootIds: ['root'],
  });
  expect(f.grep).toHaveBeenCalledExactlyOnceWith({
    caseSensitive: false,
    fileIds: ['retained'],
    isRegex: false,
    maxRows: 1,
    pattern: 'marker',
    rootIds: ['root'],
  });
  expect(result.hits.map(({ fileId }) => fileId)).toEqual(['retained']);
  expect(f.close).toHaveBeenCalledOnce();
});

it('publishes the typed transition cause and refuses search without a failed-index wrapper', async () => {
  const transition = new NativeAuthorityTransitionError('Native index is transitioning.');
  const capability = createNativeScopedSearchCapability({
    openQuery: unused,
    rebuild: unused,
    withRead: async () => {
      throw transition;
    },
  });
  await expect(capability.status()).resolves.toMatchObject({
    cause: { kind: 'transitioning' },
    kind: 'unavailable',
    phase: 'preparing',
  });
  await expect(capability.coverageBatch([{ rootIds: ['root'] }])).resolves.toMatchObject({
    cause: { kind: 'transitioning' },
    kind: 'invalidated',
  });
  await expect(
    capability.search({ limit: 10, mode: 'bm25', rootIds: ['root'], text: 'read me' })
  ).rejects.toMatchObject({
    code: 'native-index-transitioning',
    refusal: { kind: 'transitioning' },
  });
});
