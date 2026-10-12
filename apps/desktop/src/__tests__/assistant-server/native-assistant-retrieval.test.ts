// @vitest-environment node

import { EventEmitter } from 'node:events';
import { vectorProfileHash } from '@brainstrike/indexer';
import type { IndexerStatus } from '@brainstrike/indexing-contract/indexer-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const lifecycle = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock('electron', () => ({ powerSaveBlocker: { start: vi.fn(), stop: vi.fn() } }));
vi.mock('../../renderer-host-lifecycle', () => ({
  RendererHostLifecycle: vi.fn().mockImplementation(function MockLifecycle() {
    return lifecycle.current;
  }),
}));
const pg = vi.hoisted(() => ({ files: vi.fn(), fts: vi.fn(), query: vi.fn(), search: vi.fn() }));
vi.mock('../../db-main', () => ({ getDatabase: async () => ({ query: pg.query }) }));
vi.mock('@brainstrike/db', async (original) => ({
  ...(await original<typeof import('@brainstrike/db')>()),
  FileChunkRepository: class {
    searchSimilar = pg.search;
    fullTextSearch = pg.fts;
  },
  FileRecordRepository: class {
    findByIds = pg.files;
  },
}));

import type { HybridSearchInput, QueryEmbeddingSpaceInput, RuntimeData } from '@brainstrike/agent';
import { runHybridSearchWith } from '../../assistant-server/hybrid-search-core';
import { searchNativeAssistantChunks } from '../../assistant-server/native-assistant-retrieval';
import {
  type RetrievalToolDependencies,
  runQueryEmbeddingSpaceWith,
} from '../../assistant-server/retrieval-core';
import { pgliteRetrievalStore } from '../../assistant-server/retrieval-store-pglite';
import {
  projectHybridSearchModelOutput,
  projectQueryEmbeddingSpaceModelOutput,
} from '../../assistant-server/workspace-retrieval-model-projections';
import { EmbeddingHostManager } from '../../embedding-host-manager';
import type { EmbeddingHostQueryEmbeddingRequest } from '../../embedding-host-shared';
import {
  createEmbeddingHostQueryCancellationError,
  createEmbeddingHostQueryEmbeddingErrorReport,
} from '../../embedding-host-shared';
import {
  catalogOnly,
  nativeCounts as counts,
  nativeEmbedding as embedding,
  nativeRetrievalFixture as fixture,
  nativeHit as hit,
  nativeProfile as profile,
  nativeQueryPlan as queryPlan,
} from './_c1-a-helpers';

/**
 * The host's queryEmbeddingSpace and hybridSearch: the shared cores
 * `retrievalToolExecutors` runs, over Main's catalog reads (no legacy PG path).
 */
function hostSemantic(
  input: QueryEmbeddingSpaceInput,
  runtimeData: RuntimeData | undefined,
  dependencies: RetrievalToolDependencies,
  signal?: AbortSignal
) {
  return runQueryEmbeddingSpaceWith(
    input,
    runtimeData,
    dependencies,
    catalogOnly(pgliteRetrievalStore()),
    signal
  );
}
function hostHybrid(
  input: HybridSearchInput,
  runtimeData: RuntimeData | undefined,
  dependencies: RetrievalToolDependencies,
  signal?: AbortSignal
) {
  return runHybridSearchWith(
    input,
    runtimeData,
    dependencies,
    catalogOnly(pgliteRetrievalStore()),
    signal
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  pg.query.mockResolvedValue({
    rows: [
      {
        dimensions: 384,
        distance: 'cosine',
        modelId: profile.modelId,
        modelKey: queryPlan.modelKey,
      },
    ],
  });
  pg.files.mockResolvedValue([
    { id: 'file', name: 'retained.txt', path: 'retained.txt', rootId: null, tokenCount: 3 },
  ]);
  pg.search.mockResolvedValue([]);
  pg.fts.mockResolvedValue([]);
});
const tools = [
  { name: 'semantic', run: hostSemantic },
  { name: 'hybrid', run: hostHybrid },
] as const;
describe('native assistant retrieval cutover', () => {
  it.each(tools)(
    'runs $name on valid indexed vectors while the source scan and publication advance',
    async ({ run }) => {
      const f = fixture();
      f.setStatus({
        ...f.status,
        collectionReadiness: [{ embeddingSetId: 'selected', scanComplete: false }],
      } as IndexerStatus);
      vi.mocked(f.capability.search).mockResolvedValue({ ...f.result, scanLimited: true });
      vi.mocked(f.capability.grep).mockResolvedValue({ ...f.result, scanLimited: true });
      f.queryEmbedding.mockImplementationOnce(async () => {
        f.setStatus({
          ...f.status,
          collectionReadiness: [{ embeddingSetId: 'selected', scanComplete: true }],
        } as IndexerStatus);
        return Array.from({ length: 384 }, () => 0.1);
      });
      const result = await run({ query: 'native marker' }, undefined, {
        embeddingHostManager: { queryEmbedding: f.queryEmbedding },
        nativeIndexSearch: f.capability,
      });
      expect(result).toMatchObject({ hint: expect.stringMatching(/partial.*coverage/i) });
      const projected =
        run === hostHybrid
          ? projectHybridSearchModelOutput(result)
          : projectQueryEmbeddingSpaceModelOutput(result);
      expect(projected.value).toMatch(/hint: Partial index coverage observed/);
      expect(f.queryEmbedding).toHaveBeenCalledOnce();
      expect(f.capability.search).toHaveBeenCalledWith(expect.objectContaining({ mode: 'vector' }));
      if (run === hostHybrid) {
        expect(f.capability.search).toHaveBeenCalledWith(expect.objectContaining({ mode: 'bm25' }));
        expect(f.capability.grep).toHaveBeenCalledOnce();
      }
      expect(pg.search).not.toHaveBeenCalled();
      expect(pg.fts).not.toHaveBeenCalled();
    }
  );

  it.each(tools)(
    'routes $name through native vectors with the exact saved query plan and signal',
    async ({ run }) => {
      const f = fixture();
      const signal = new AbortController().signal;
      const result = await run(
        { embeddingSetId: 'selected', query: 'native marker' },
        undefined,
        {
          embeddingHostManager: { queryEmbedding: f.queryEmbedding },
          nativeIndexSearch: f.capability,
        },
        signal
      );
      expect(f.queryEmbedding).toHaveBeenCalledWith(
        {
          dimensions: 384,
          inferencePlan: queryPlan.inferencePlan,
          modelId: profile.modelId,
          modelKey: queryPlan.modelKey,
          query: 'native marker',
        },
        { signal }
      );
      expect(f.capability.coverageBatch).toHaveBeenCalledWith([
        { collectionId: 'selected', rootIds: [] },
      ]);
      expect(f.capability.search).toHaveBeenCalledWith({
        collectionId: 'selected',
        limit: 100,
        mode: 'vector',
        profile,
        rootIds: [],
        vector: Array.from({ length: 384 }, () => 0.1),
      });
      expect(JSON.stringify(result)).toContain('native marker');
      expect(pg.search).not.toHaveBeenCalled();
      expect(pg.fts).not.toHaveBeenCalled();
    }
  );
  it.each(tools)(
    'refuses TEXT and unauthorized collections before inference in $name',
    async ({ run }) => {
      const f = fixture();
      f.setStatus({ ...f.status, embedding: { indexMode: 'text-only' } } as IndexerStatus);
      await expect(
        run({ embeddingSetId: 'selected', query: 'marker' }, undefined, {
          embeddingHostManager: { queryEmbedding: f.queryEmbedding },
          nativeIndexSearch: f.capability,
        })
      ).rejects.toThrow();
      f.setStatus(f.status);
      await expect(
        run({ embeddingSetId: 'foreign', query: 'marker' }, undefined, {
          embeddingHostManager: { queryEmbedding: f.queryEmbedding },
          nativeIndexSearch: f.capability,
        })
      ).rejects.toThrow();
      expect(f.queryEmbedding).not.toHaveBeenCalled();
      expect(pg.search).not.toHaveBeenCalled();
    }
  );
  it.each(tools)('refuses unsupported explicit file filters in $name', async ({ run }) => {
    const f = fixture();
    await expect(
      run({ embeddingSetId: 'selected', filePaths: [], query: 'marker' }, undefined, {
        embeddingHostManager: { queryEmbedding: f.queryEmbedding },
        nativeIndexSearch: f.capability,
      })
    ).rejects.toThrow();
    expect(f.queryEmbedding).not.toHaveBeenCalled();
    expect(pg.search).not.toHaveBeenCalled();
  });
  it.each(tools)('does not fall through after native failure in $name', async ({ run }) => {
    const f = fixture();
    vi.mocked(f.capability.search).mockRejectedValue(new Error('native failure'));
    await expect(
      run({ embeddingSetId: 'selected', query: 'marker' }, undefined, {
        embeddingHostManager: { queryEmbedding: f.queryEmbedding },
        nativeIndexSearch: f.capability,
      })
    ).rejects.toThrow();
    expect(pg.search).not.toHaveBeenCalled();
    expect(pg.fts).not.toHaveBeenCalled();
  });
  it.each([
    {
      message: 'Unable to retrieve context right now. Try again.',
      name: 'semantic',
      run: hostSemantic,
    },
    { message: 'Hybrid search failed. Please try again.', name: 'hybrid', run: hostHybrid },
  ] as const)(
    'refuses $name when no native index serves the request on the host catalog store',
    async ({ message, run }) => {
      // The host's store has no PG similarity path: without a native index the
      // request fails visibly (sanitized) instead of reading Main's PGlite chunks.
      const f = fixture();
      await expect(
        run({ embeddingSetId: 'selected', query: 'marker' }, undefined, {
          embeddingHostManager: { queryEmbedding: f.queryEmbedding },
        })
      ).rejects.toThrow(message);
      expect(pg.search).not.toHaveBeenCalled();
      expect(pg.fts).not.toHaveBeenCalled();
    }
  );
  it('exposes native truncation to the semantic model projection', async () => {
    const f = fixture();
    f.result.candidatesTruncated = true;
    const result = await hostSemantic({ embeddingSetId: 'selected', query: 'marker' }, undefined, {
      embeddingHostManager: { queryEmbedding: f.queryEmbedding },
      nativeIndexSearch: f.capability,
    });
    if (!('hint' in result && result.hint)) {
      throw new Error('Missing native limitation notice');
    }
    expect(result.truncated).toBe(true);
    expect(JSON.stringify(projectQueryEmbeddingSpaceModelOutput(result))).toContain(result.hint);
  });
  it.each(tools)(
    'joins held real-manager inference before rejecting cancellation in $name',
    async ({ run }) => {
      const f = fixture();
      const hostStatus = {
        active: false,
        lastError: null,
        runtimeId: 'query-runtime',
        runtimeKind: 'embedding-host' as const,
        state: 'running' as const,
      };
      const send = vi.fn();
      const window = Object.assign(new EventEmitter(), {
        isDestroyed: () => false,
        webContents: Object.assign(new EventEmitter(), { id: 91, send }),
      });
      lifecycle.current = {
        clearHostWindow: vi.fn(),
        destroyHostWindow: vi.fn(),
        dispose: vi.fn(),
        ensureStarted: async () => hostStatus,
        getHostWindow: () => window,
        getStatus: () => hostStatus,
        setStatus: vi.fn(),
        waitForStatus: vi.fn(),
      };
      const manager = new EmbeddingHostManager({ platform: 'linux' });
      const signalOwner = new AbortController();
      const reason = { source: 'assistant Stop' };
      const queryEmbedding = vi.spyOn(manager, 'queryEmbedding');
      const settled = vi.fn();
      const outcome = run(
        { embeddingSetId: 'selected', query: 'held query' },
        undefined,
        { embeddingHostManager: manager, nativeIndexSearch: f.capability },
        signalOwner.signal
      ).then(
        (value) => {
          settled();
          return value;
        },
        (error: unknown) => {
          settled();
          return error;
        }
      );
      await vi.waitFor(() => expect(send).toHaveBeenCalled());
      const request = send.mock.calls[0]?.[1] as EmbeddingHostQueryEmbeddingRequest;
      expect(request.channel).toBe('query-embedding');
      expect(request.payload).toEqual({
        dimensions: 384,
        inferencePlan: queryPlan.inferencePlan,
        modelId: profile.modelId,
        modelKey: queryPlan.modelKey,
        query: 'held query',
      });
      expect(queryEmbedding.mock.calls[0]?.[1]?.signal).toBe(signalOwner.signal);
      signalOwner.abort(reason);
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      expect(manager.getPlatformStatus().pendingRequestCount).toBe(1);
      expect(f.capability.search).not.toHaveBeenCalled();
      manager.acceptQueryEmbeddingResponseReport(
        91,
        createEmbeddingHostQueryEmbeddingErrorReport(
          request,
          createEmbeddingHostQueryCancellationError()
        )
      );
      await expect(outcome).resolves.toBe(reason);
      expect(manager.getPlatformStatus().pendingRequestCount).toBe(0);
      expect(pg.search).not.toHaveBeenCalled();
    }
  );

  it.each(tools)(
    'retains independent inference failure alongside cancellation in $name',
    async ({ run }) => {
      const f = fixture();
      const hostStatus = {
        active: false,
        lastError: null,
        runtimeId: 'fault-runtime',
        runtimeKind: 'embedding-host' as const,
        state: 'running' as const,
      };
      const send = vi.fn();
      const window = Object.assign(new EventEmitter(), {
        isDestroyed: () => false,
        webContents: Object.assign(new EventEmitter(), { id: 91, send }),
      });
      lifecycle.current = {
        clearHostWindow: vi.fn(),
        destroyHostWindow: vi.fn(),
        dispose: vi.fn(),
        ensureStarted: async () => hostStatus,
        getHostWindow: () => window,
        getStatus: () => hostStatus,
        setStatus: vi.fn(),
        waitForStatus: vi.fn(),
      };
      const manager = new EmbeddingHostManager({ platform: 'linux' });
      const owner = new AbortController();
      const reason = { source: 'Stop with independent fault' };
      const outcome = run(
        { embeddingSetId: 'selected', query: 'held query' },
        undefined,
        { embeddingHostManager: manager, nativeIndexSearch: f.capability },
        owner.signal
      ).catch((error: unknown) => error);
      await vi.waitFor(() => expect(send).toHaveBeenCalled());
      const request = send.mock.calls[0]?.[1] as EmbeddingHostQueryEmbeddingRequest;
      owner.abort(reason);
      manager.acceptQueryEmbeddingResponseReport(
        91,
        createEmbeddingHostQueryEmbeddingErrorReport(
          request,
          new Error('independent inference fault')
        )
      );
      const error = await outcome;
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error && error.cause instanceof AggregateError)) {
        throw new Error('Independent native failure cause was lost');
      }
      expect(error.cause.errors).toContain(reason);
      expect(error.cause.errors).toHaveLength(2);
      expect(manager.getPlatformStatus().pendingRequestCount).toBe(0);
      expect(f.capability.search).not.toHaveBeenCalled();
      expect(pg.search).not.toHaveBeenCalled();
    }
  );
  it.each(['revision', 'dimensions', 'dtype', 'modelId', 'device', 'pooling', 'prompts'] as const)(
    'refuses a mismatched saved query %s before inference',
    async (field) => {
      const f = fixture();
      // BST-1993: CLS or a prompted query plan against the saved profile is another vector space.
      const value =
        field === 'dimensions'
          ? 768
          : field === 'pooling'
            ? 'cls'
            : field === 'prompts'
              ? { document: '', query: 'ask: ' }
              : 'unsupported';
      const mismatch = { ...queryPlan.inferencePlan, [field]: value };
      f.setStatus({
        ...f.status,
        queryPlan: { ...queryPlan, inferencePlan: mismatch },
      } as IndexerStatus);
      await expect(
        hostSemantic({ embeddingSetId: 'selected', query: 'marker' }, undefined, {
          embeddingHostManager: { queryEmbedding: f.queryEmbedding },
          nativeIndexSearch: f.capability,
        })
      ).rejects.toThrow();
      expect(f.queryEmbedding).not.toHaveBeenCalled();
      expect(pg.search).not.toHaveBeenCalled();
    }
  );
  it.each(tools)(
    'refuses saved query plan changes while inference is held in $name',
    async ({ run }) => {
      const f = fixture();
      f.queryEmbedding.mockImplementation(async () => {
        f.setStatus({
          ...f.status,
          queryPlan: {
            ...queryPlan,
            inferencePlan: { ...queryPlan.inferencePlan, device: 'webgpu' },
          },
        } as IndexerStatus);
        return Array.from({ length: 384 }, () => 0.1);
      });
      await expect(
        run({ embeddingSetId: 'selected', query: 'marker' }, undefined, {
          embeddingHostManager: { queryEmbedding: f.queryEmbedding },
          nativeIndexSearch: f.capability,
        })
      ).rejects.toThrow();
      expect(f.capability.search).not.toHaveBeenCalled();
      expect(pg.search).not.toHaveBeenCalled();
    }
  );
  it.each(['store', 'profile', 'scope'] as const)(
    'refuses native pool %s mismatches',
    async (field) => {
      const f = fixture();
      vi.mocked(f.capability.search).mockResolvedValue({
        ...f.result,
        ...(field === 'store'
          ? { storeId: 'b'.repeat(64) }
          : field === 'profile'
            ? { embedding: { ...embedding, profile: { ...profile, tokenCap: 512 } } }
            : { hits: [{ ...hit, embeddingSetId: 'foreign' }] }),
      });
      await expect(
        hostSemantic({ embeddingSetId: 'selected', query: 'marker' }, undefined, {
          embeddingHostManager: { queryEmbedding: f.queryEmbedding },
          nativeIndexSearch: f.capability,
        })
      ).rejects.toThrow();
      expect(pg.search).not.toHaveBeenCalled();
    }
  );
  it('joins the remaining hybrid read arms after one fails', async () => {
    const f = fixture();
    const held = Promise.withResolvers<typeof f.result>();
    const settled = vi.fn();
    vi.mocked(f.capability.grep).mockImplementation(() => held.promise);
    vi.mocked(f.capability.search).mockRejectedValue(new Error('native read failed'));
    const outcome = hostHybrid({ embeddingSetId: 'selected', query: 'marker' }, undefined, {
      embeddingHostManager: { queryEmbedding: f.queryEmbedding },
      nativeIndexSearch: f.capability,
    }).catch((error: unknown) => {
      settled();
      return error;
    });
    await vi.waitFor(() => expect(f.capability.grep).toHaveBeenCalled());
    expect(settled).not.toHaveBeenCalled();
    held.resolve(f.result);
    await outcome;
    expect(settled).toHaveBeenCalledOnce();
    expect(pg.search).not.toHaveBeenCalled();
  });
  it.each([{ limit: 11 }, { chunkType: 'text' as const }, { vectorWeight: 0.5 }, { ftsWeight: 0 }])(
    'refuses unsupported native hybrid options %j before inference',
    async (options) => {
      const f = fixture();
      await expect(
        hostHybrid({ embeddingSetId: 'selected', query: 'marker', ...options }, undefined, {
          embeddingHostManager: { queryEmbedding: f.queryEmbedding },
          nativeIndexSearch: f.capability,
        })
      ).rejects.toThrow();
      expect(f.queryEmbedding).not.toHaveBeenCalled();
      expect(pg.search).not.toHaveBeenCalled();
    }
  );
  it.each(['coverage', 'token-cap'] as const)(
    'refuses incomplete or mismatched native %s before inference',
    async (failure) => {
      const f = fixture();
      if (failure === 'token-cap') {
        f.setStatus({
          ...f.status,
          embedding: { ...embedding, profile: { ...profile, tokenCap: 512 } },
        } as IndexerStatus);
      }
      if (failure === 'coverage') {
        vi.mocked(f.capability.coverage).mockResolvedValue({
          collections: [{ ...counts, embeddingSetId: 'selected', missingVectors: 1, vectors: 0 }],
          embedding,
          roots: [],
          storeId: f.result.storeId,
          totals: { ...counts, missingVectors: 1, vectors: 0 },
          vectorCoverageComplete: false,
        });
      }
      await expect(
        hostSemantic({ embeddingSetId: 'selected', query: 'marker' }, undefined, {
          embeddingHostManager: { queryEmbedding: f.queryEmbedding },
          nativeIndexSearch: f.capability,
        })
      ).rejects.toThrow();
      expect(f.queryEmbedding).not.toHaveBeenCalled();
      expect(pg.search).not.toHaveBeenCalled();
    }
  );
  it('preserves explicit query task input when the saved device is WebGPU', async () => {
    const f = fixture();
    const plan = {
      ...queryPlan,
      inferencePlan: { ...queryPlan.inferencePlan, device: 'webgpu' as const },
    };
    f.setStatus({ ...f.status, queryPlan: plan } as IndexerStatus);
    await hostSemantic({ embeddingSetId: 'selected', query: 'raw query text' }, undefined, {
      embeddingHostManager: { queryEmbedding: f.queryEmbedding },
      nativeIndexSearch: f.capability,
    });
    expect(f.queryEmbedding.mock.calls[0]?.[0]).toEqual({
      dimensions: 384,
      inferencePlan: plan.inferencePlan,
      modelId: profile.modelId,
      modelKey: plan.modelKey,
      query: 'raw query text',
    });
    expect(f.queryEmbedding.mock.calls[0]?.[0]).not.toHaveProperty('texts');
  });

  it.each(tools)(
    'resolves omitted collection from actual native authority despite stale legacy status in $name',
    async ({ run }) => {
      const f = fixture();
      const result = await run(
        { query: 'native marker' },
        { workspaceIndexEmbeddingSetId: 'stale-legacy-set', workspaceIndexingEnabled: false },
        {
          embeddingHostManager: { queryEmbedding: f.queryEmbedding },
          nativeIndexSearch: f.capability,
        }
      );
      if (!('embeddingSetId' in result)) {
        throw new Error('Native retrieval unexpectedly unavailable');
      }
      expect(result.embeddingSetId).toBe('selected');
      expect(pg.search).not.toHaveBeenCalled();
    }
  );
});

it.each([
  { distance: 'cosine', score: 0.4, similarity: 0.8 },
  { distance: 'l2', score: 0.25, similarity: 0.8 },
  { distance: 'ip', score: -Math.log(4), similarity: 0.8 },
] as const)(
  'preserves original $distance similarity threshold semantics for semantic and hybrid retrieval',
  async ({ distance, score, similarity }) => {
    const selectedProfile = { ...profile, distance, provider: 'local' as const };
    const metricEmbedding = {
      indexMode: 'vector-configured' as const,
      profile: selectedProfile,
      profileHash: vectorProfileHash(selectedProfile),
    };
    for (const mode of ['semantic', 'hybrid'] as const) {
      const f = fixture();
      f.setStatus({ ...f.status, embedding: metricEmbedding });
      vi.mocked(f.capability.coverage).mockResolvedValue({
        collections: [{ ...counts, embeddingSetId: 'selected' }],
        embedding: metricEmbedding,
        roots: [],
        storeId: f.result.storeId,
        totals: counts,
        vectorCoverageComplete: true,
      });
      vi.mocked(f.capability.search).mockImplementation(async () => ({
        ...f.result,
        embedding: metricEmbedding,
        hits: [{ ...hit, score }],
      }));
      vi.mocked(f.capability.grep).mockResolvedValue({
        ...f.result,
        embedding: metricEmbedding,
        hits: [],
      });
      const input = {
        capability: f.capability,
        embeddingHostManager: { queryEmbedding: f.queryEmbedding },
        embeddingSet: {
          dimensions: 384,
          distance,
          modelId: profile.modelId,
          modelKey: queryPlan.modelKey,
        },
        embeddingSetId: 'selected',
        mode,
        query: 'native marker',
        threshold: similarity,
      };
      const accepted = await searchNativeAssistantChunks(input);
      expect(accepted.vectorResultCount).toBe(1);
      expect(accepted.hits[0]?.similarity).toBeCloseTo(similarity);
      const excluded = await searchNativeAssistantChunks({
        ...input,
        threshold: similarity + 0.001,
      });
      expect(excluded.vectorResultCount).toBe(0);
    }
  }
);
