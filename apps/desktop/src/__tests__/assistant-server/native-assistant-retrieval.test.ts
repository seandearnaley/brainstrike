// @vitest-environment node

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type {
  IndexerStatus,
  IndexSearchCapability,
} from '@brainstrike/indexing-contract/indexer-client';
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

import { runHybridSearch } from '../../assistant-server/hybrid-search-tool';
import { runQueryEmbeddingSpace } from '../../assistant-server/retrieval-tool';
import { projectQueryEmbeddingSpaceModelOutput } from '../../assistant-server/workspace-retrieval-model-projections';
import { EmbeddingHostManager } from '../../embedding-host-manager';
import type { EmbeddingHostQueryEmbeddingRequest } from '../../embedding-host-shared';
import {
  createEmbeddingHostQueryCancellationError,
  createEmbeddingHostQueryEmbeddingErrorReport,
} from '../../embedding-host-shared';

const profile = {
  dimensions: 384,
  dtype: 'q8',
  modelId: 'Xenova/all-MiniLM-L6-v2',
  revision: '751bff37182d3f1213fa05d7196b954e230abad9',
  tokenCap: 256,
} as const;
const profileHash = createHash('sha256')
  .update(
    JSON.stringify([
      profile.modelId,
      profile.revision,
      profile.dtype,
      profile.dimensions,
      profile.tokenCap,
    ])
  )
  .digest('hex');
const queryPlan = {
  inferencePlan: {
    device: 'wasm',
    dimensions: profile.dimensions,
    dtype: profile.dtype,
    modelId: profile.modelId,
    revision: profile.revision,
  },
  modelKey: `local::${profile.modelId}`,
} as const;
const embedding = { indexMode: 'vector-configured', profile, profileHash } as const;
const hit = {
  chunkId: 'native-chunk',
  chunkIndex: 0,
  chunkSize: 384,
  chunkType: 'text',
  content: 'native marker',
  contentHash: 'c'.repeat(64),
  embeddingSetId: 'selected',
  endLine: 1,
  endOffset: 13,
  fileId: 'file',
  relativePath: null,
  rootId: null,
  score: 0.1,
  sourcePath: null,
  startLine: 1,
  startOffset: 0,
  tokenCount: 3,
} as const;
const counts = { chunks: 1, indexedFiles: 1, missingVectors: 0, vectors: 1 };
function fixture() {
  let status: IndexerStatus = {
    authorizedCollectionIds: ['selected'],
    authorizedRootIds: [],
    collectionReadiness: [{ embeddingSetId: 'selected', scanComplete: true }],
    embedding,
    kind: 'ready',
    queryPlan,
    rootReadiness: [],
    storeId: 'a'.repeat(64),
  };
  const result = {
    candidateCount: 1,
    candidatesTruncated: false,
    embedding,
    hits: [hit],
    scanLimited: false,
    storeId: 'a'.repeat(64),
    truncated: false,
  };
  const capability: IndexSearchCapability = {
    coverage: vi.fn(async () => ({
      collections: [{ ...counts, embeddingSetId: 'selected' }],
      embedding,
      roots: [],
      storeId: result.storeId,
      totals: counts,
      vectorCoverageComplete: true,
    })),
    grep: vi.fn(async () => result),
    rebuild: vi.fn(),
    search: vi.fn(async () => result),
    status: vi.fn(async () => status),
  };
  const queryEmbedding = vi.fn(async (_payload: unknown, _options?: { signal?: AbortSignal }) =>
    Array.from({ length: 384 }, () => 0.1)
  );
  return {
    capability,
    queryEmbedding,
    result,
    setStatus: (next: IndexerStatus) => {
      status = next;
    },
    status,
  };
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
  { name: 'semantic', run: runQueryEmbeddingSpace },
  { name: 'hybrid', run: runHybridSearch },
] as const;
describe('native assistant retrieval cutover', () => {
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
  it('preserves the PG route when native capability is absent', async () => {
    const f = fixture();
    await runQueryEmbeddingSpace({ embeddingSetId: 'selected', query: 'marker' }, undefined, {
      embeddingHostManager: { queryEmbedding: f.queryEmbedding },
    });
    expect(pg.search).toHaveBeenCalled();
    expect(f.queryEmbedding.mock.calls[0]?.[0]).not.toHaveProperty('inferencePlan');
  });
  it('exposes native truncation to the semantic model projection', async () => {
    const f = fixture();
    f.result.candidatesTruncated = true;
    const result = await runQueryEmbeddingSpace(
      { embeddingSetId: 'selected', query: 'marker' },
      undefined,
      {
        embeddingHostManager: { queryEmbedding: f.queryEmbedding },
        nativeIndexSearch: f.capability,
      }
    );
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
  it.each(['revision', 'dimensions', 'dtype', 'modelId', 'device'] as const)(
    'refuses a mismatched saved query %s before inference',
    async (field) => {
      const f = fixture();
      const mismatch = {
        ...queryPlan.inferencePlan,
        [field]: field === 'dimensions' ? 768 : 'unsupported',
      };
      f.setStatus({
        ...f.status,
        queryPlan: { ...queryPlan, inferencePlan: mismatch },
      } as IndexerStatus);
      await expect(
        runQueryEmbeddingSpace({ embeddingSetId: 'selected', query: 'marker' }, undefined, {
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
        runQueryEmbeddingSpace({ embeddingSetId: 'selected', query: 'marker' }, undefined, {
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
    const outcome = runHybridSearch({ embeddingSetId: 'selected', query: 'marker' }, undefined, {
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
        runHybridSearch({ embeddingSetId: 'selected', query: 'marker', ...options }, undefined, {
          embeddingHostManager: { queryEmbedding: f.queryEmbedding },
          nativeIndexSearch: f.capability,
        })
      ).rejects.toThrow();
      expect(f.queryEmbedding).not.toHaveBeenCalled();
      expect(pg.search).not.toHaveBeenCalled();
    }
  );
  it.each(['receipt', 'coverage', 'token-cap'] as const)(
    'refuses incomplete or mismatched native %s before inference',
    async (failure) => {
      const f = fixture();
      if (failure === 'receipt') {
        f.setStatus({
          ...f.status,
          collectionReadiness: [{ embeddingSetId: 'selected', scanComplete: false }],
        } as IndexerStatus);
      }
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
        runQueryEmbeddingSpace({ embeddingSetId: 'selected', query: 'marker' }, undefined, {
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
    await runQueryEmbeddingSpace(
      { embeddingSetId: 'selected', query: 'raw query text' },
      undefined,
      {
        embeddingHostManager: { queryEmbedding: f.queryEmbedding },
        nativeIndexSearch: f.capability,
      }
    );
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
