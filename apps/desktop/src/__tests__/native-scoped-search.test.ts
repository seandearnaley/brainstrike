// @vitest-environment node
import { createHash } from 'node:crypto';
import { describeBoundaryFailure } from '@brainstrike/assistant-contract/boundary-failure';
import {
  createNativeScopedSearchCapability,
  NativeAuthorityTransitionError,
} from '@brainstrike/assistant-service/node-native-text-services';
import { vectorProfileHash } from '@brainstrike/indexer';
import { NativeIndexRefusalError } from '@brainstrike/indexing-contract/indexer-client';
import type { SqliteGrepRows } from '@brainstrike/sqlite-query';
import { expect, it, vi } from 'vitest';
import { nativeIndexBoundaryFailure } from '../native-index-boundary-failure';
import {
  binding,
  fixture,
  profile,
  progressAuthority,
  rootId,
  scope,
  storeId,
  unused,
} from './native-scoped-search-fixture';

it.each(['unchanged', 'complete-during-read', 'invalidate-during-read'] as const)(
  'projects source proof separately from bounded results: %s',
  async (change) => {
    const f = fixture();
    const initialComplete = change !== 'complete-during-read';
    f.replaceAuthority({
      ...f.getAuthority(),
      readiness: f
        .getAuthority()
        .readiness.map((receipt) => ({ ...receipt, scanComplete: initialComplete })),
    });
    const read = f.searchScopes.getMockImplementation()!;
    f.searchScopes.mockImplementation(async (request) => {
      const result = await read(request);
      if (change !== 'unchanged') {
        f.replaceAuthority({
          ...f.getAuthority(),
          readiness: f.getAuthority().readiness.map((receipt) => ({
            ...receipt,
            mutationRevision: receipt.mutationRevision + 1,
            scanComplete: change === 'complete-during-read',
          })),
        });
      }
      return { ...result, scanLimited: true };
    });
    await expect(
      f.capability.search({ limit: 100, mode: 'bm25', rootIds: [rootId], text: 'notes' })
    ).resolves.toMatchObject({
      scanLimited: true,
      sourceComplete: change === 'unchanged',
    });
    await expect(
      f.capability.grep({
        caseSensitive: false,
        isRegex: false,
        limit: 100,
        pattern: 'notes',
        rootIds: [rootId],
      })
    ).resolves.toMatchObject({
      sourceComplete: change !== 'invalidate-during-read',
    });
  }
);

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
    publicationProgress: [
      {
        acknowledgedFiles: 1,
        authorityEpoch: 'historical-epoch',
        authorityRevision: 3,
        mutationRevision: 2,
        ownerGeneration: 1,
        profileHash: vectorProfileHash(profile),
        requestId: 'scan',
        scanGeneration: 1,
        scope,
        storeId,
      },
    ],
    rootReadiness: [{ rootId, scanComplete: false }],
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
    kind: 'ready',
    publicationProgress: [],
    rootReadiness: [{ rootId, scanComplete: false }],
  });
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
    kind: 'ready',
    publicationProgress: [],
    rootReadiness: [{ rootId, scanComplete: false }],
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
            ? { scope: { kind: 'workspace', rootId: 'foreign' } as const }
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
            ? { scope: { kind: 'workspace' as const, rootId: 'foreign' } }
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
    await expect(f.capability.coverageBatch([{ rootIds: [rootId] }])).rejects.toThrow(
      'Native publication progress differs'
    );
  }
);

it('refuses a workspace search with no folder in words the person acts on, logging nothing', async () => {
  const f = fixture();
  const log = vi.fn();
  for (const read of [
    () => f.capability.search({ limit: 10, mode: 'bm25', rootIds: [], text: 'marker' }),
    () =>
      f.capability.grep({
        caseSensitive: false,
        isRegex: false,
        limit: 10,
        pattern: 'marker',
        rootIds: [],
      }),
  ]) {
    const error = await read().catch((caught: unknown) => caught);
    const failure = nativeIndexBoundaryFailure(error, log);
    expect(failure).toMatchObject({ code: 'native-search.no-folders', kind: 'refusal' });
    expect(describeBoundaryFailure(failure)).toBe(
      'No folder is open in the workspace. Add a folder in the left file tree first.'
    );
  }
  expect(log).not.toHaveBeenCalled();
});

it.each([
  ['a folder the index leaves out', ['root-a', 'worktree']],
  ['the same folder twice', ['root-a', 'root-a']],
])('refuses a search naming %s with a typed refusal, logging nothing', async (_case, rootIds) => {
  const f = fixture();
  f.replaceAuthority({ ...f.getAuthority(), rootIds: ['root-a'] });
  const log = vi.fn();
  for (const read of [
    () => f.capability.search({ limit: 10, mode: 'bm25', rootIds, text: 'marker' }),
    () =>
      f.capability.grep({ caseSensitive: false, isRegex: false, limit: 10, pattern: 'm', rootIds }),
    () => f.capability.coverage({ rootIds }),
  ]) {
    const error = await read().catch((caught: unknown) => caught);
    const failure = nativeIndexBoundaryFailure(error, log);
    expect(failure).toMatchObject({
      category: 'configuration',
      code: 'native-search.folder-not-indexed',
      kind: 'refusal',
    });
    expect(describeBoundaryFailure(failure)).toBe(
      'A folder in this search is not indexed or is no longer open. Search again, and turn a worktree on in Settings, Search & Indexing to include it.'
    );
  }
  expect(log).not.toHaveBeenCalled();
});

it('refuses coverage under Off with the typed Off refusal, logging nothing', async () => {
  const message = 'Search is off. Turn it on in Settings, Search & Indexing.';
  const off = new NativeIndexRefusalError({ kind: 'off', message }, message);
  const capability = createNativeScopedSearchCapability({
    openQuery: unused,
    rebuild: unused,
    withRead: () => Promise.reject(off),
  });
  const error = await capability.coverage({ rootIds: ['root'] }).catch((caught: unknown) => caught);
  expect(error).toBe(off);
  const log = vi.fn();
  expect(describeBoundaryFailure(nativeIndexBoundaryFailure(error, log))).toBe(message);
  expect(log).not.toHaveBeenCalled();
});

it('uses the full saved scoped vector profile for vector search and coverage', async () => {
  const f = fixture(profile);
  expect(await f.capability.status()).toMatchObject({
    embedding: {
      indexMode: 'vector-configured',
      profile,
      profileHash: vectorProfileHash(profile),
    },
  });
  const vector = Array.from({ length: profile.dimensions }, () => 1);
  await f.capability.search({
    limit: 100,
    mode: 'vector',
    profile,
    rootIds: [rootId],
    vector,
  });
  expect(f.searchScopes).toHaveBeenCalledWith({
    limit: 100,
    mode: 'vector',
    profile,
    scopes: [scope],
    vector,
  });
  expect(await f.capability.coverage({ rootIds: [rootId] })).toMatchObject({
    totals: { missingVectors: 0, vectors: 1 },
    vectorCoverageComplete: true,
  });
  await expect(
    f.capability.search({
      limit: 100,
      mode: 'vector',
      profile: { ...profile, modelId: 'text-embedding-3-large' },
      rootIds: [rootId],
      vector,
    })
  ).rejects.toThrow('differs');
});

it('reports the saved profile in status with the identity the renderer mirror computes', async () => {
  const voyage = {
    dimensions: 1024,
    distance: 'ip',
    modelId: 'voyage-3',
    provider: 'voyage',
  } as const;
  const f = fixture(voyage);
  const status = await f.capability.status();
  if (status.kind !== 'ready' || status.embedding.indexMode !== 'vector-configured') {
    throw new Error('A configured vector store must report its vector profile.');
  }
  expect(status.embedding.profile).toEqual(voyage);
  expect(status.embedding.profileHash).toBe(vectorProfileHash(voyage));
  const mirrored = createHash('sha256')
    .update(
      JSON.stringify([
        status.embedding.profile.provider,
        status.embedding.profile.modelId,
        status.embedding.profile.dimensions,
        status.embedding.profile.distance,
      ])
    )
    .digest('hex');
  expect(mirrored).toBe(status.embedding.profileHash);
});

it('joins the grep reader but refuses its result after canonical source authority changes', async () => {
  const f = fixture();
  const held = Promise.withResolvers<SqliteGrepRows>();
  f.grep.mockReturnValueOnce(held.promise);
  const outcome = f.capability.grep({
    caseSensitive: false,
    isRegex: false,
    limit: 100,
    pattern: 'marker',
    rootIds: [rootId],
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
    identity: { storeId },
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
      .search({ limit: 10, mode: 'bm25', rootIds: [rootId], text: 'marker' })
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
      f.replaceAuthority({ ...authority, profile: { ...profile, dimensions: 512 } });
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
    bindings: [
      { ...binding, profile },
      {
        ...binding,
        fileId: 'file',
        profile,
        relativePath: 'file.txt',
        rootId: 'root',
        sourcePath: '/workspace/root/file.txt',
      },
    ],
    readiness: [
      { generation: 1, mutationRevision: 0, scanComplete: true, scope },
      {
        generation: 1,
        mutationRevision: 0,
        scanComplete: true,
        scope: { kind: 'workspace', rootId: 'root' },
      },
    ],
    rootIds: [rootId, 'root'],
  });
  return f;
}
const pairedRequests = [{ rootIds: [rootId] }, { rootIds: ['root'] }];
it.each([
  { emptyScanned: true, expected: true, rootIds: ['root', 'empty'] },
  { emptyScanned: false, expected: false, rootIds: ['root', 'empty'] },
  { emptyScanned: true, expected: true, rootIds: ['empty'] },
])(
  'counts a root with no chunks as vector-covered only with its scan receipt: $rootIds, scanned=$emptyScanned (BST-2053)',
  async ({ emptyScanned, expected, rootIds }) => {
    const f = pairedFixture();
    const empty = { kind: 'workspace', rootId: 'empty' } as const;
    f.replaceAuthority({
      ...f.getAuthority(),
      readiness: [
        ...f.getAuthority().readiness,
        { generation: 1, mutationRevision: 0, scanComplete: emptyScanned, scope: empty },
      ],
      rootIds: [rootId, 'root', 'empty'],
    });
    const original = f.coverageBatch.getMockImplementation()!;
    f.coverageBatch.mockImplementation(async (requests) =>
      (await original(requests)).map((result) =>
        result.scope.kind === 'workspace' && result.scope.rootId === 'empty'
          ? {
              ...result,
              // The indexer's own answer: alone, an empty scope is never vector readiness.
              counts: { chunks: 0, indexedFiles: 0, missingVectors: 0, vectors: 0 },
              vectorCoverageComplete: false,
            }
          : result
      )
    );
    const result = await f.capability.coverageBatch([{ rootIds }]);
    if (result.kind !== 'current') {
      throw new Error('Expected a current fenced batch.');
    }
    expect(result.coverage[0]).toMatchObject({
      roots: rootIds.map((rootId) => ({ rootId })),
      vectorCoverageComplete: expected,
    });
    expect(result.status.rootReadiness).toContainEqual({
      rootId: 'empty',
      scanComplete: emptyScanned,
    });
  }
);
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
      status: { rootReadiness: [{ scanComplete: false }, { scanComplete: false }] },
    });
    if (observation.kind !== 'current') {
      throw new Error('Expected actual partial coverage during publication.');
    }
    expect(observation.coverage.map((entry) => entry.totals.chunks)).toEqual([1, 2]);
    expect(f.coverageBatch).toHaveBeenCalledOnce();
    expect(await f.capability.status()).toMatchObject({
      rootReadiness: [{ scanComplete: complete }, { scanComplete: complete }],
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
        publicationProgress: [],
        rootReadiness: [{ scanComplete: false }, { scanComplete: false }],
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
  expect(result.coverage.map((entry) => entry.totals.chunks)).toEqual([1, 2]);
  expect(result.status).toMatchObject({
    kind: 'ready',
    rootReadiness: [
      { rootId, scanComplete: true },
      { rootId: 'root', scanComplete: true },
    ],
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
          : capability.coverageBatch([{ rootIds: [rootId] }])
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
      method === 'status' ? capability.status() : capability.coverageBatch([{ rootIds: [rootId] }])
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
  f.replaceAuthority({
    ...f.getAuthority(),
    bindings: [
      { ...binding, profile: null },
      {
        ...binding,
        fileId: 'unselected',
        profile: null,
        relativePath: 'unselected.md',
        sourcePath: '/workspace/root-a/unselected.md',
      },
    ],
  });
  const result = await f.capability.grep({
    caseSensitive: false,
    filePaths: [binding.relativePath],
    isRegex: false,
    limit: 1,
    pattern: 'marker',
    rootIds: [rootId],
  });
  expect(f.grep).toHaveBeenCalledExactlyOnceWith({
    caseSensitive: false,
    fileIds: [binding.fileId],
    isRegex: false,
    maxRows: 1,
    pattern: 'marker',
    rootIds: [rootId],
  });
  expect(result.hits.map(({ fileId }) => fileId)).toEqual([binding.fileId]);
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
