import type {
  IndexerSearchHit,
  IndexerSearchResult,
  IndexSearchCapability,
} from '@brainstrike/indexing-contract/indexer-client';
import { describe, expect, it, vi } from 'vitest';
import {
  fuseNativeSearchPools,
  getNativeSemanticAvailability,
} from '../../assistant-server/native-search-fusion';

const profile = {
  dimensions: 1536,
  distance: 'cosine' as const,
  modelId: 'text-embedding-3-small',
  provider: 'openai' as const,
};
const profileHash = '288c9286093cddf9776cab7ba498f9b313a405ebc28471ffd1e9eba9811b7758';
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
  const bridge = {
    coverage: vi.fn<IndexSearchCapability['coverage']>(async () => covered()),
    coverageBatch: vi.fn<IndexSearchCapability['coverageBatch']>(),
    grep: vi.fn<IndexSearchCapability['grep']>(async () => pool([])),
    rebuild: vi.fn<IndexSearchCapability['rebuild']>(async () => {}),
    search: vi.fn<IndexSearchCapability['search']>(async () => pool([])),
    status: vi.fn<IndexSearchCapability['status']>(async () => ready()),
  };
  bridge.coverageBatch.mockImplementation(async (requests) => {
    const status = await bridge.status();
    if (status.kind !== 'ready') {
      return { kind: 'blocked', reason: status.reason };
    }
    return {
      coverage: await Promise.all(requests.map((request) => bridge.coverage(request))),
      kind: 'current',
      status,
    };
  });
  return bridge;
}

describe('native vector availability', () => {
  it('treats typed observation invalidation as pending without strict singleton coverage', async () => {
    const bridge = capability();
    bridge.coverage.mockRejectedValue(new Error('Strict singleton must not be called.'));
    bridge.coverageBatch.mockResolvedValueOnce({
      code: 'native-coverage-observation-invalidated',
      kind: 'invalidated',
    });
    expect(
      await getNativeSemanticAvailability({ capability: bridge, profile, rootIds: ['root-a'] })
    ).toEqual({ available: false, reason: 'Native vector availability is being verified.' });
    expect(bridge.coverage).not.toHaveBeenCalled();
    bridge.coverageBatch.mockResolvedValueOnce({
      coverage: [covered()],
      kind: 'current',
      status: ready(),
    });
    expect(
      await getNativeSemanticAvailability({ capability: bridge, profile, rootIds: ['root-a'] })
    ).toEqual({ available: true, reason: null });
  });

  it('refuses a malformed current observation without admitting semantics', async () => {
    const bridge = capability();
    bridge.coverageBatch.mockResolvedValueOnce({ coverage: [], kind: 'current', status: ready() });
    expect(
      await getNativeSemanticAvailability({ capability: bridge, profile, rootIds: ['root-a'] })
    ).toEqual({
      available: false,
      reason: 'Native vector availability returned a different coverage inventory.',
    });
  });

  it('requires the native capability even when a profile is configured', async () => {
    const result = await getNativeSemanticAvailability({
      capability: null,
      profile,
      rootIds: ['root-a'],
    });
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/native.*unavailable/iu);
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

  it('admits a matching profile with actual indexed vector coverage', async () => {
    const bridge = capability();
    expect(
      await getNativeSemanticAvailability({ capability: bridge, profile, rootIds: ['root-a'] })
    ).toEqual({ available: true, reason: null });
    expect(bridge.coverage).toHaveBeenCalledExactlyOnceWith({ rootIds: ['root-a'] });
    expect(bridge.search).not.toHaveBeenCalled();
  });

  it('admits indexed vectors during source scanning and explicitly reports partial coverage', async () => {
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
    expect(result).toMatchObject({
      available: true,
      hint: expect.stringMatching(
        /Partial index coverage.*2 files.*4 chunks.*4 vectors.*Source scan incomplete/u
      ),
    });
    expect(bridge.coverage).toHaveBeenCalledOnce();
  });

  it('requires actual coverage for every requested root', async () => {
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

  it('rejects an unauthorized requested root in the atomic observation', async () => {
    const bridge = capability();
    expect(
      (await getNativeSemanticAvailability({ capability: bridge, profile, rootIds: ['outside'] }))
        .available
    ).toBe(false);
    expect(bridge.coverageBatch).toHaveBeenCalled();
  });

  it('with no folder open, says to add one rather than widening the scope', async () => {
    const bridge = capability();
    expect(
      await getNativeSemanticAvailability({ capability: bridge, profile, rootIds: [] })
    ).toEqual({
      available: false,
      reason: 'No folder is open in the workspace. Add a folder in the left file tree first.',
    });
    expect(bridge.status).not.toHaveBeenCalled();
  });

  it('rejects a changed configured model despite matching dimensions', async () => {
    const bridge = capability();
    const result = await getNativeSemanticAvailability({
      capability: bridge,
      profile: { ...profile, modelId: 'text-embedding-3-large' },
      rootIds: ['root-a'],
    });
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/profile/iu);
    expect(bridge.coverageBatch).toHaveBeenCalled();
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

  it('admits the valid vector subset while refusing contradictory coverage counts', async () => {
    const bridge = capability();
    const partial = {
      ...covered(),
      roots: [{ rootId: 'root-a', ...counts, missingVectors: 1, vectors: 3 }],
      totals: { ...counts, missingVectors: 1, vectors: 3 },
      vectorCoverageComplete: false,
    };
    bridge.coverage.mockResolvedValueOnce(partial);
    expect(
      await getNativeSemanticAvailability({ capability: bridge, profile, rootIds: ['root-a'] })
    ).toMatchObject({
      available: true,
      hint: expect.stringContaining('3 vectors, 1 chunks awaiting vectors'),
    });
    bridge.coverage.mockResolvedValueOnce({ ...partial, vectorCoverageComplete: true });
    expect(
      (await getNativeSemanticAvailability({ capability: bridge, profile, rootIds: ['root-a'] }))
        .available
    ).toBe(false);
  });

  it('surfaces bridge failure without requesting a search or rewriting selection', async () => {
    const bridge = capability();
    const failure = new Error('Native coverage is offline.');
    bridge.coverage.mockRejectedValueOnce(failure);
    await expect(
      getNativeSemanticAvailability({ capability: bridge, profile, rootIds: ['root-a'] })
    ).rejects.toBe(failure);
    expect(bridge.search).not.toHaveBeenCalled();
  });
});

describe('frozen native pool fusion', () => {
  it('requires the named BM25 and grep pools', () => {
    expect(() => fuseNativeSearchPools({ bm25: null, grep: null }, identity)).toThrow(
      /BM25.*grep/iu
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
describe('native pool fusion', () => {
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
    ).toThrow(/source chunk identity/iu);
  });
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
