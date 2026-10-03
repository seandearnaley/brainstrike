import type {
  IndexerSearchHit,
  IndexerSearchResult,
  IndexSearchCapability,
} from '@brainstrike/indexing-contract/indexer-client';
import { describe, expect, it, vi } from 'vitest';
import {
  fuseNativeSearchPools,
  getNativeSemanticAvailability,
  NativeWorkspaceSearchExecutor,
} from '../native-workspace-search';

const profile = {
  dimensions: 384,
  dtype: 'fp16' as const,
  modelId: 'onnx-community/all-MiniLM-L6-v2-ONNX',
  revision: 'aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f',
  tokenCap: 256,
};
const profileHash = '60a05b1084b11c2add2e01bb8112960f51e83e68c88ad4151b0dc54eb69e1914';
const identity = {
  embedding: { indexMode: 'vector-configured' as const, profile, profileHash },
  storeId: 'store-a',
};
const counts = { chunks: 4, indexedFiles: 2, missingVectors: 0, vectors: 4 };
function ready() {
  return {
    authorizedRootIds: ['root-a', 'root-b'],
    kind: 'ready' as const,
    ...identity,
    rootReadiness: [
      { rootId: 'root-a', scanComplete: true },
      { rootId: 'root-b', scanComplete: true },
    ],
  };
}
function covered() {
  return {
    ...identity,
    roots: [{ rootId: 'root-a', ...counts }],
    totals: { ...counts },
    vectorCoverageComplete: true,
  };
}
function capability() {
  return {
    coverage: vi.fn<IndexSearchCapability['coverage']>(async () => covered()),
    grep: vi.fn<IndexSearchCapability['grep']>(async () => pool([])),
    rebuild: vi.fn<IndexSearchCapability['rebuild']>(async () => {}),
    search: vi.fn<IndexSearchCapability['search']>(async () => pool([])),
    status: vi.fn<IndexSearchCapability['status']>(async () => ready()),
  };
}

describe('native vector availability', () => {
  it('requires the native capability even when a profile is configured', async () => {
    const result = await getNativeSemanticAvailability({
      capability: null,
      profile,
      rootIds: ['root-a'],
    });
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/native.*unavailable/i);
  });

  it('requires a complete explicitly configured profile', async () => {
    const bridge = capability();
    expect(
      await getNativeSemanticAvailability({
        capability: bridge,
        profile: null,
        rootIds: ['root-a'],
      })
    ).toEqual({
      available: false,
      reason: 'Vector search requires a complete configured embedding profile.',
    });
    expect(bridge.status).not.toHaveBeenCalled();
  });

  it('admits a matching profile only after actual root scan and vector coverage', async () => {
    const bridge = capability();
    expect(
      await getNativeSemanticAvailability({ capability: bridge, profile, rootIds: ['root-a'] })
    ).toEqual({ available: true, reason: null });
    expect(bridge.coverage).toHaveBeenCalledExactlyOnceWith({ rootIds: ['root-a'] });
    expect(bridge.search).not.toHaveBeenCalled();
  });

  it('does not accept complete vectors from an incomplete source scan', async () => {
    const bridge = capability();
    bridge.status.mockResolvedValueOnce({
      ...ready(),
      rootReadiness: [{ rootId: 'root-a', scanComplete: false }],
    });
    const result = await getNativeSemanticAvailability({
      capability: bridge,
      profile,
      rootIds: ['root-a'],
    });
    expect(result.available).toBe(false);
    expect(result.reason).toBe(
      'Vector search requires a complete source scan for every requested root.'
    );
    expect(bridge.coverage).not.toHaveBeenCalled();
  });

  it('requires scan readiness for every requested root', async () => {
    const bridge = capability();
    bridge.status.mockResolvedValueOnce({
      ...ready(),
      rootReadiness: [{ rootId: 'root-a', scanComplete: true }],
    });
    expect(
      (
        await getNativeSemanticAvailability({
          capability: bridge,
          profile,
          rootIds: ['root-a', 'root-b'],
        })
      ).available
    ).toBe(false);
  });

  it('rejects an unauthorized requested root before reading coverage', async () => {
    const bridge = capability();
    expect(
      (await getNativeSemanticAvailability({ capability: bridge, profile, rootIds: ['outside'] }))
        .available
    ).toBe(false);
    expect(bridge.coverage).not.toHaveBeenCalled();
  });

  it('rejects empty scope rather than widening it', async () => {
    const bridge = capability();
    expect(
      (await getNativeSemanticAvailability({ capability: bridge, profile, rootIds: [] })).available
    ).toBe(false);
    expect(bridge.status).not.toHaveBeenCalled();
  });

  it('rejects a changed configured revision despite matching dimensions', async () => {
    const bridge = capability();
    const result = await getNativeSemanticAvailability({
      capability: bridge,
      profile: { ...profile, revision: '0'.repeat(40) },
      rootIds: ['root-a'],
    });
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/profile/i);
    expect(bridge.coverage).not.toHaveBeenCalled();
  });

  it('rejects coverage from another profile', async () => {
    const bridge = capability();
    bridge.coverage.mockResolvedValueOnce({
      ...covered(),
      embedding: { ...identity.embedding, profileHash: '0'.repeat(64) },
    });
    expect(
      (await getNativeSemanticAvailability({ capability: bridge, profile, rootIds: ['root-a'] }))
        .available
    ).toBe(false);
  });

  it('rejects unknown or missing per-root coverage', async () => {
    const bridge = capability();
    bridge.coverage.mockResolvedValueOnce({ ...covered(), roots: [] });
    expect(
      (await getNativeSemanticAvailability({ capability: bridge, profile, rootIds: ['root-a'] }))
        .available
    ).toBe(false);
  });

  it('rejects a root with zero chunks instead of treating equality as completeness', async () => {
    const bridge = capability();
    const empty = { chunks: 0, indexedFiles: 0, missingVectors: 0, vectors: 0 };
    bridge.coverage.mockResolvedValueOnce({
      ...covered(),
      roots: [{ rootId: 'root-a', ...empty }],
      totals: empty,
    });
    expect(
      (await getNativeSemanticAvailability({ capability: bridge, profile, rootIds: ['root-a'] }))
        .available
    ).toBe(false);
  });

  it('rejects partial vectors and a false completeness flag', async () => {
    for (const coverage of [
      { ...covered(), vectorCoverageComplete: false },
      {
        ...covered(),
        roots: [{ rootId: 'root-a', ...counts, missingVectors: 1, vectors: 3 }],
        totals: { ...counts, missingVectors: 1, vectors: 3 },
      },
    ]) {
      const bridge = capability();
      bridge.coverage.mockResolvedValueOnce(coverage);
      expect(
        (await getNativeSemanticAvailability({ capability: bridge, profile, rootIds: ['root-a'] }))
          .available
      ).toBe(false);
    }
  });

  it('surfaces bridge failure without requesting a search or rewriting selection', async () => {
    const bridge = capability();
    bridge.coverage.mockRejectedValueOnce(new Error('Native coverage is offline.'));
    expect(
      await getNativeSemanticAvailability({ capability: bridge, profile, rootIds: ['root-a'] })
    ).toEqual({ available: false, reason: 'Native coverage is offline.' });
    expect(bridge.search).not.toHaveBeenCalled();
  });
});

describe('frozen native pool fusion', () => {
  it('requires the named BM25 and grep pools', async () => {
    const { fuseNativeSearchPools } = await import('../native-workspace-search');
    expect(() => fuseNativeSearchPools({ bm25: null, grep: null }, identity)).toThrow(
      /BM25.*grep/i
    );
  });
});

function hit(chunkId: string, content = 'const needle = 1;'): IndexerSearchHit {
  return {
    chunkId,
    chunkIndex: 0,
    chunkSize: 256,
    chunkType: 'recursive',
    content,
    contentHash: 'a'.repeat(64),
    endLine: 2,
    endOffset: 1 + content.length,
    fileId: 'file-a',
    relativePath: 'src/a.ts',
    rootId: 'root-a',
    score: 1,
    startLine: 2,
    startOffset: 1,
    tokenCount: 8,
  };
}
function pool(hits: IndexerSearchHit[]): IndexerSearchResult {
  return {
    candidateCount: hits.length,
    candidatesTruncated: false,
    hits,
    ...identity,
    scanLimited: false,
    truncated: false,
  };
}
const request = {
  caseSensitive: false,
  collectionId: null,
  isRegex: false,
  query: 'needle',
  rootIds: ['root-a'],
  wholeWord: false,
};

describe('native search consumer boundary', () => {
  it('text uses actual BM25 and grep IDs with no inference and a fixed pool limit', async () => {
    const bridge = capability();
    bridge.search.mockResolvedValueOnce(pool([hit('bm25-only', 'conceptual result')]));
    bridge.grep.mockResolvedValueOnce(pool([hit('grep-hit')]));
    const embedQuery = vi.fn();
    const result = await new NativeWorkspaceSearchExecutor({
      capability: bridge,
      embedQuery,
      profile,
    }).searchText(request);
    expect(embedQuery).not.toHaveBeenCalled();
    expect(bridge.search).toHaveBeenCalledExactlyOnceWith({
      limit: 100,
      mode: 'bm25',
      rootIds: ['root-a'],
      text: 'needle',
    });
    expect(bridge.grep).toHaveBeenCalledExactlyOnceWith({
      caseSensitive: false,
      isRegex: false,
      limit: 100,
      pattern: 'needle',
      rootIds: ['root-a'],
    });
    expect(result?.files[0]?.children).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ chunkId: 'bm25-only', kind: 'chunk' }),
        expect.objectContaining({
          chunkId: 'grep-hit',
          kind: 'match',
          line: 2,
          lineText: 'const needle = 1;',
        }),
      ])
    );
  });
  it('semantic rejects incomplete coverage before inference or any candidate arm', async () => {
    const bridge = capability();
    bridge.coverage.mockResolvedValueOnce({ ...covered(), vectorCoverageComplete: false });
    const embedQuery = vi.fn();
    await expect(
      new NativeWorkspaceSearchExecutor({ capability: bridge, embedQuery, profile }).searchSemantic(
        request
      )
    ).rejects.toThrow(/coverage.*incomplete/i);
    expect(embedQuery).not.toHaveBeenCalled();
    expect(bridge.search).not.toHaveBeenCalled();
    expect(bridge.grep).not.toHaveBeenCalled();
  });
  it('rechecks scope coverage after renderer inference and never runs lexical-only semantic search', async () => {
    const bridge = capability();
    bridge.coverage
      .mockResolvedValueOnce(covered())
      .mockResolvedValueOnce({ ...covered(), vectorCoverageComplete: false });
    const embedQuery = vi.fn(async () => Array.from({ length: 384 }, () => 1));
    await expect(
      new NativeWorkspaceSearchExecutor({ capability: bridge, embedQuery, profile }).searchSemantic(
        request
      )
    ).rejects.toThrow(/coverage.*incomplete/i);
    expect(embedQuery).toHaveBeenCalledExactlyOnceWith(profile, 'needle');
    expect(bridge.search).not.toHaveBeenCalled();
    expect(bridge.grep).not.toHaveBeenCalled();
  });
  it('does not remap an explicit collection selection', async () => {
    const bridge = capability();
    await expect(
      new NativeWorkspaceSearchExecutor({
        capability: bridge,
        embedQuery: vi.fn(),
        profile,
      }).searchText({ ...request, collectionId: 'user-selected' })
    ).rejects.toThrow(/collection.*not currently authorized/i);
    expect(bridge.status).toHaveBeenCalledOnce();
    expect(bridge.search).not.toHaveBeenCalled();
  });
  it('rejects a failed vector arm rather than returning lexical hits', async () => {
    const bridge = capability();
    bridge.search.mockImplementation(async (input) => {
      if (input.mode === 'vector') {
        throw new Error('Vector reader failed.');
      }
      return pool([hit('a')]);
    });
    bridge.grep.mockResolvedValue(pool([hit('a')]));
    const executor = new NativeWorkspaceSearchExecutor({
      capability: bridge,
      embedQuery: async () => Array.from({ length: 384 }, () => 1),
      profile,
    });
    await expect(executor.searchSemantic(request)).rejects.toThrow('Vector reader failed.');
  });
  it('keeps original ranks, one contribution per source, cap10 and explicit bounded flags', () => {
    const bm25 = pool([
      hit('a'),
      hit('b'),
      ...Array.from({ length: 15 }, (_, i) => hit(`other-${i}`)),
    ]);
    const grep = { ...pool([hit('b'), hit('b')]), candidatesTruncated: true, scanLimited: true };
    const result = fuseNativeSearchPools({ bm25, grep }, identity);
    expect(result.hits[0]?.hit.chunkId).toBe('b');
    expect(result.hits[0]?.rrfScore).toBe(1 / 62 + 1 / 61);
    expect(result.hits).toHaveLength(10);
    expect(result).toMatchObject({ candidatesTruncated: true, scanLimited: true, truncated: true });
  });
  it('rejects matching chunk IDs with conflicting source identity across candidate streams', () => {
    expect(() =>
      fuseNativeSearchPools(
        { bm25: pool([hit('a')]), grep: pool([{ ...hit('a'), contentHash: 'b'.repeat(64) }]) },
        identity
      )
    ).toThrow(/source chunk identity/i);
  });
  it('applies requested pattern options without changing original RRF ranks', async () => {
    const bridge = capability();
    bridge.search.mockResolvedValue(pool([hit('a', 'NEEDLE'), hit('b', 'needle')]));
    bridge.grep.mockResolvedValue(pool([hit('b', 'needle')]));
    const result = await new NativeWorkspaceSearchExecutor({
      capability: bridge,
      embedQuery: vi.fn(),
      profile,
    }).searchText({ ...request, caseSensitive: true });
    expect(result?.files.flatMap((file) => file.children).map((child) => child.chunkId)).toEqual([
      'b',
    ]);
  });
});

it('rejects an unauthorized candidate even when a pattern filter would discard it', async () => {
  const bridge = capability();
  bridge.search.mockResolvedValueOnce(
    pool([{ ...hit('outside'), content: 'would not match', rootId: 'unauthorized' }])
  );
  const executor = new NativeWorkspaceSearchExecutor({
    capability: bridge,
    embedQuery: vi.fn(),
    profile,
  });
  await expect(
    executor.searchText({
      caseSensitive: true,
      collectionId: null,
      isRegex: false,
      query: 'needle',
      rootIds: ['root-a'],
      wholeWord: false,
    })
  ).rejects.toThrow('canonical source scope');
});

it('searches a text-only native store without a selected vector plan or inference', async () => {
  const bridge = capability();
  const embedding = { indexMode: 'text-only' as const };
  bridge.status.mockResolvedValue({ ...ready(), embedding, storeId: 'store-a' });
  bridge.search.mockResolvedValue({ ...pool([hit('text')]), embedding, storeId: 'store-a' });
  bridge.grep.mockResolvedValue({ ...pool([hit('text')]), embedding, storeId: 'store-a' });
  const embedQuery = vi.fn();
  const executor = new NativeWorkspaceSearchExecutor({
    capability: bridge,
    embedQuery,
    profile: null,
  });
  const result = await executor.searchText(request);
  expect(result?.totalMatches).toBe(1);
  expect(bridge.coverage).not.toHaveBeenCalled();
  expect(embedQuery).not.toHaveBeenCalled();
});

it('rejects changed native store identity even when profile and dimensions match', async () => {
  const bridge = capability();
  bridge.coverage.mockResolvedValueOnce({ ...covered(), storeId: 'replacement-store' });
  expect(
    await getNativeSemanticAvailability({ capability: bridge, profile, rootIds: ['root-a'] })
  ).toEqual({
    available: false,
    reason: 'Vector coverage profile does not match the configured profile.',
  });
  expect(bridge.search).not.toHaveBeenCalled();
});
it('refuses a candidate arm from a replacement store or a changed embedding state', () => {
  for (const changed of [
    { ...pool([hit('a')]), storeId: 'replacement-store' },
    { ...pool([hit('a')]), embedding: { indexMode: 'text-only' as const } },
  ]) {
    expect(() => fuseNativeSearchPools({ bm25: pool([]), grep: changed }, identity)).toThrow(
      'store and embedding identity'
    );
  }
});
it('does not admit vector search on a text-only store despite a selected profile', async () => {
  const bridge = capability();
  bridge.status.mockResolvedValue({ ...ready(), embedding: { indexMode: 'text-only' } });
  const embedQuery = vi.fn();
  await expect(
    new NativeWorkspaceSearchExecutor({ capability: bridge, embedQuery, profile }).searchSemantic(
      request
    )
  ).rejects.toThrow('no explicitly configured vector profile');
  expect(embedQuery).not.toHaveBeenCalled();
  expect(bridge.coverage).not.toHaveBeenCalled();
});

it('surfaces the selected renderer plan refusal without blocking text or substituting a profile', async () => {
  const bridge = capability();
  const reason = 'The selected embedding request requires an explicit revision, device and dtype.';
  const embedQuery = vi.fn();
  const executor = new NativeWorkspaceSearchExecutor({
    capability: bridge,
    embedQuery,
    profile: null,
    profileUnavailableReason: reason,
  });
  await expect(executor.searchSemantic(request)).rejects.toThrow(reason);
  const result = await executor.searchText(request);
  expect(result?.mode).toBe('text');
  expect(embedQuery).not.toHaveBeenCalled();
  expect(
    await getNativeSemanticAvailability({
      capability: bridge,
      profile: null,
      profileUnavailableReason: reason,
      rootIds: ['root-a'],
    })
  ).toEqual({ available: false, reason });
});

it('searches the actual retained collection without manufacturing a workspace root or invoking inference in TEXT', async () => {
  const bridge = capability();
  bridge.status.mockResolvedValue({
    ...ready(),
    authorizedCollectionIds: ['selected'],
    authorizedRootIds: [],
    collectionReadiness: [{ embeddingSetId: 'selected', scanComplete: true }],
    rootReadiness: [],
  });
  const retained = {
    ...hit('retained-chunk'),
    content: 'needle retained source',
    embeddingSetId: 'selected',
    fileId: 'retained-file',
    relativePath: null,
    rootId: null,
    sourcePath: null,
  };
  bridge.search.mockResolvedValue(pool([retained]));
  bridge.grep.mockResolvedValue(pool([retained]));
  const embedQuery = vi.fn();
  const result = await new NativeWorkspaceSearchExecutor({
    capability: bridge,
    embedQuery,
    profile,
  }).searchText({ ...request, collectionId: 'selected', rootIds: [] });
  expect(result?.files).toMatchObject([
    { dbRootId: null, fileRecordId: 'retained-file', path: 'retained-file' },
  ]);
  expect(bridge.search).toHaveBeenCalledWith({
    collectionId: 'selected',
    limit: 100,
    mode: 'bm25',
    rootIds: [],
    text: 'needle',
  });
  expect(bridge.grep).toHaveBeenCalledWith(
    expect.objectContaining({ collectionId: 'selected', rootIds: [] })
  );
  expect(embedQuery).not.toHaveBeenCalled();
});

it('requires the actual collection receipt and scoped vector coverage for a rootless semantic query', async () => {
  const bridge = capability();
  const status = {
    ...ready(),
    authorizedCollectionIds: ['selected'],
    authorizedRootIds: [],
    collectionReadiness: [{ embeddingSetId: 'selected', scanComplete: true }],
    rootReadiness: [],
  };
  bridge.status.mockResolvedValue(status);
  bridge.coverage.mockResolvedValue({
    ...covered(),
    collections: [{ embeddingSetId: 'selected', ...counts }],
    roots: [],
  });
  const scope = { capability: bridge, collectionId: 'selected', profile, rootIds: [] };
  expect(await getNativeSemanticAvailability(scope)).toEqual({ available: true, reason: null });
  expect(bridge.coverage).toHaveBeenCalledWith({ collectionId: 'selected', rootIds: [] });
  bridge.status.mockResolvedValue({
    ...status,
    collectionReadiness: [{ embeddingSetId: 'selected', scanComplete: false }],
  });
  expect((await getNativeSemanticAvailability(scope)).available).toBe(false);
});
