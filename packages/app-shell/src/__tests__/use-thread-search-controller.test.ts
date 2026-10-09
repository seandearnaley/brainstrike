import type { ThreadSearchExtraArms } from '@brainstrike/db';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantThreadSearchSemantic } from '../assistant-thread-host-context';
import type { HostThreadSearchVectors } from '../host-thread-search-vectors';
import { resetThreadSearchStore, useThreadSearchStore } from '../thread-search-store';
import {
  THREAD_SEARCH_DEBOUNCE_MS,
  type ThreadSearchControllerRepository,
  useThreadSearchController,
} from '../use-thread-search-controller';

vi.mock('../prompt-embedding-model-info', () => ({
  resolveSingletonProfileModelInfo: vi.fn(() => ({
    dimensions: 3,
    modelConfig: { description: '', dimensions: 3, id: 'test-model', name: 'Test', tags: [] },
    modelKey: 'local::test-model',
  })),
}));

const PROFILE = {
  dimensions: 3,
  distance: 'cosine' as const,
  id: 'default',
  modelId: 'test-model',
  modelKey: 'local::test-model',
};

const COVERAGE = {
  embeddableMessages: 0,
  embeddedMessages: 0,
  erroredMessages: 0,
  indexedMessages: 0,
  totalMessages: 0,
};

const FTS_MATCH = {
  headline: '<mark>hnsw</mark>',
  messageCreatedAt: new Date('2026-07-19T00:00:00Z'),
  messageId: 'msg-1',
  rank: 0.5,
  role: 'assistant',
  threadId: 'thread-1',
};

function createRepository(
  overrides: Partial<ThreadSearchControllerRepository> = {}
): ThreadSearchControllerRepository {
  return {
    fullTextSearch: vi.fn(async () => [FTS_MATCH]),
    getCoverage: vi.fn(async () => COVERAGE),
    getEmbeddingProfile: vi.fn(async () => PROFILE),
    listNeedingEmbedding: vi.fn(async () => []),
    markEmbeddingError: vi.fn(async () => true),
    searchSimilar: vi.fn(async () => []),
    searchThreadTitles: vi.fn(async () => []),
    storeEmbedding: vi.fn(async () => true),
    sync: vi.fn(async () => ({ deletedOrphans: 0, inserted: 0, refreshed: 0 })),
    ...overrides,
  };
}

/** The search embedder's identity on a WASM runtime: a 3-dimension model loads quantized. */
const VECTOR_PROFILE = {
  dimensions: 3,
  distance: 'cosine',
  dtype: 'q4',
  modelId: 'test-model',
  provider: 'local',
};

function createEmbedder(query: number[] | Error = [0.1, 0.2, 0.3]) {
  return {
    embedDocumentWithRecovery: vi.fn(async (_info: unknown, text: string) =>
      text === 'host text two' ? [0.4, 0.5, 0.6] : [0.1, 0.2, 0.3]
    ),
    embedQueryWithRecovery: vi.fn(async () => {
      if (query instanceof Error) {
        throw query;
      }
      return query;
    }),
    ensureEmbedderReady: vi.fn(async () => ({ runtime: 'wasm' as const }) as never),
  };
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(THREAD_SEARCH_DEBOUNCE_MS + 10);
  });
}

describe('useThreadSearchController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetThreadSearchStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function renderController(
    repository: ThreadSearchControllerRepository | null,
    embedder = createEmbedder(),
    loadEmbeddingQueue: (() => Promise<never>) | null = null,
    searchHost?: (
      query: string,
      semantic?: AssistantThreadSearchSemantic
    ) => Promise<ThreadSearchExtraArms>,
    hostSearchVectors?: HostThreadSearchVectors
  ) {
    return renderHook(() =>
      useThreadSearchController({
        embedder,
        hostSearchVectors,
        loadEmbeddingQueue,
        localModelConfigMap: new Map() as never,
        repository,
        resourceId: 'workspace-memory',
        ...(searchHost ? { searchHost } : {}),
      })
    );
  }

  it('debounces the query and resolves hybrid results', async () => {
    const repository = createRepository();
    const embedder = createEmbedder();
    const loadQueue = vi.fn(async () => ({}) as never);
    renderController(repository, embedder, loadQueue);

    act(() => {
      useThreadSearchStore.getState().setQuery('hnsw');
    });
    expect(repository.fullTextSearch).not.toHaveBeenCalled();

    await flushAsync();

    expect(repository.sync).toHaveBeenCalledTimes(1);
    expect(embedder.embedQueryWithRecovery).toHaveBeenCalledTimes(1);
    const state = useThreadSearchStore.getState();
    expect(state.status).toBe('results');
    expect(state.results?.[0]?.threadId).toBe('thread-1');
    expect(state.semantic).toEqual({ kind: 'used' });
  });

  it('reuses a fresh sync across quick successive searches (TTL)', async () => {
    const repository = createRepository();
    renderController(repository);

    act(() => {
      useThreadSearchStore.getState().setQuery('hnsw');
    });
    await flushAsync();
    act(() => {
      useThreadSearchStore.getState().setQuery('hnsw tuning');
    });
    await flushAsync();

    expect(repository.fullTextSearch).toHaveBeenCalledTimes(2);
    expect(repository.sync).toHaveBeenCalledTimes(1);
  });

  it('runs lexical-only with a visible reason when no embedding queue exists', async () => {
    const repository = createRepository();
    renderController(repository, createEmbedder(), null);

    act(() => {
      useThreadSearchStore.getState().setQuery('hnsw');
    });
    await flushAsync();

    const state = useThreadSearchStore.getState();
    expect(state.status).toBe('results');
    expect(repository.searchSimilar).not.toHaveBeenCalled();
    expect(state.semantic.kind).toBe('unavailable');
    if (state.semantic.kind === 'unavailable') {
      expect(state.semantic.reason).toMatch(/embedding queue/i);
    }
  });

  it('records a visible unavailable reason when query embedding fails', async () => {
    const repository = createRepository();
    const embedder = createEmbedder(new Error('embedder offline'));
    renderController(
      repository,
      embedder,
      vi.fn(async () => ({}) as never)
    );

    act(() => {
      useThreadSearchStore.getState().setQuery('hnsw');
    });
    await flushAsync();

    const state = useThreadSearchStore.getState();
    expect(state.status).toBe('results');
    expect(state.semantic).toEqual({ kind: 'unavailable', reason: 'embedder offline' });
  });

  it('caches an embedding failure so later searches resolve immediately lexical-only', async () => {
    const repository = createRepository();
    const embedder = createEmbedder(new Error('embedder offline'));
    renderController(
      repository,
      embedder,
      vi.fn(async () => ({}) as never)
    );

    act(() => {
      useThreadSearchStore.getState().setQuery('hnsw');
    });
    await flushAsync();
    expect(embedder.embedQueryWithRecovery).toHaveBeenCalledTimes(1);

    act(() => {
      useThreadSearchStore.getState().setQuery('hnsw tuning');
    });
    await flushAsync();

    // Within the retry window the slow re-attempt is skipped, but the reason
    // stays visible on the fresh results.
    expect(embedder.embedQueryWithRecovery).toHaveBeenCalledTimes(1);
    const state = useThreadSearchStore.getState();
    expect(state.status).toBe('results');
    expect(state.semantic).toEqual({ kind: 'unavailable', reason: 'embedder offline' });
  });

  it('does not let a superseded slow failure blind later searches to a healthy embedder', async () => {
    let failFirst: ((error: Error) => void) | null = null;
    const embedder = {
      embedDocumentWithRecovery: vi.fn(async () => [0.1, 0.2, 0.3]),
      embedQueryWithRecovery: vi
        .fn(async () => [0.1, 0.2, 0.3])
        .mockImplementationOnce(
          () =>
            new Promise<number[]>((_resolve, reject) => {
              failFirst = reject;
            })
        ),
      ensureEmbedderReady: vi.fn(async () => ({ runtime: 'wasm' as const }) as never),
    };
    const repository = createRepository();
    renderController(
      repository,
      embedder,
      vi.fn(async () => ({}) as never)
    );

    // Query A: its embedding attempt hangs.
    act(() => {
      useThreadSearchStore.getState().setQuery('first query');
    });
    await flushAsync();

    // Query B starts later and succeeds while A is still pending.
    act(() => {
      useThreadSearchStore.getState().setQuery('second query');
    });
    await flushAsync();
    expect(useThreadSearchStore.getState().semantic).toEqual({ kind: 'used' });

    // A's failure lands late: it must NOT poison the failure cache.
    await act(async () => {
      failFirst?.(new Error('stale failure'));
      await vi.advanceTimersByTimeAsync(10);
    });
    act(() => {
      useThreadSearchStore.getState().setQuery('third query');
    });
    await flushAsync();

    // The third search attempted the embedder again (no cached failure).
    expect(embedder.embedQueryWithRecovery).toHaveBeenCalledTimes(3);
    expect(useThreadSearchStore.getState().semantic).toEqual({ kind: 'used' });
  });

  it('clears results when the query shrinks below the minimum length', async () => {
    const repository = createRepository();
    renderController(repository);

    act(() => {
      useThreadSearchStore.getState().setQuery('hnsw');
    });
    await flushAsync();
    expect(useThreadSearchStore.getState().status).toBe('results');

    act(() => {
      useThreadSearchStore.getState().setQuery('h');
    });
    await flushAsync();

    const state = useThreadSearchStore.getState();
    expect(state.status).toBe('idle');
    expect(state.results).toBeNull();
    expect(state.query).toBe('h');
  });

  it('fails the search visibly when the repository throws', async () => {
    const repository = createRepository({
      fullTextSearch: vi.fn(async () => {
        throw new Error('index unavailable');
      }),
    });
    renderController(repository);

    act(() => {
      useThreadSearchStore.getState().setQuery('hnsw');
    });
    await flushAsync();

    const state = useThreadSearchStore.getState();
    expect(state.status).toBe('error');
    expect(state.error).toBe('index unavailable');
  });

  it('drops results from a superseded run (generation guard end-to-end)', async () => {
    let releaseFirst: ((value: (typeof FTS_MATCH)[]) => void) | null = null;
    const repository = createRepository({
      fullTextSearch: vi
        .fn(async () => [FTS_MATCH])
        .mockImplementationOnce(
          () =>
            new Promise<(typeof FTS_MATCH)[]>((resolve) => {
              releaseFirst = resolve;
            })
        ),
    });
    renderController(repository);

    act(() => {
      useThreadSearchStore.getState().setQuery('first query');
    });
    await flushAsync();
    expect(useThreadSearchStore.getState().status).toBe('searching');

    act(() => {
      useThreadSearchStore.getState().setQuery('second query');
    });
    await flushAsync();
    expect(useThreadSearchStore.getState().status).toBe('results');
    const resolvedResults = useThreadSearchStore.getState().results;

    // The first (stale) run resolves late; its results must not clobber.
    await act(async () => {
      releaseFirst?.([{ ...FTS_MATCH, threadId: 'stale-thread' }]);
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(useThreadSearchStore.getState().results).toBe(resolvedResults);
  });

  it("fuses the host's arms into the same result list as history's", async () => {
    const repository = createRepository();
    const searchHost = vi.fn(async () => ({
      messages: [
        {
          headline: '<mark>hnsw</mark> on the host',
          messageCreatedAt: new Date('2026-10-08T00:00:00Z'),
          messageId: 'host-message',
          role: 'user',
          threadId: 'host-thread',
        },
      ],
      titles: [],
    }));
    renderController(
      repository,
      createEmbedder(),
      vi.fn(async () => ({}) as never),
      searchHost
    );

    act(() => {
      useThreadSearchStore.getState().setQuery('hnsw');
    });
    await flushAsync();

    // The host's arms take the same query vector, under the embedder's identity.
    expect(searchHost).toHaveBeenCalledWith('hnsw', {
      profile: VECTOR_PROFILE,
      threshold: 0.35,
      vector: [0.1, 0.2, 0.3],
    });
    expect(useThreadSearchStore.getState().results?.map(({ threadId }) => threadId)).toEqual([
      'thread-1',
      'host-thread',
    ]);
  });

  it('fails the search visibly when the host search fails', async () => {
    const repository = createRepository();
    renderController(repository, createEmbedder(), null, async () => {
      throw new Error('The agent host is unavailable.');
    });

    act(() => {
      useThreadSearchStore.getState().setQuery('hnsw');
    });
    await flushAsync();

    expect(useThreadSearchStore.getState()).toMatchObject({
      error: 'The agent host is unavailable.',
      status: 'error',
    });
  });

  it('drains the embedding backlog and records coverage', async () => {
    const pendingCoverage = {
      embeddableMessages: 2,
      embeddedMessages: 0,
      erroredMessages: 0,
      indexedMessages: 2,
      totalMessages: 2,
    };
    const repository = createRepository({
      getCoverage: vi.fn(async () => pendingCoverage),
      listNeedingEmbedding: vi.fn(async () => [
        { contentHash: 'hash-1', contentText: 'text', messageId: 'msg-1' },
      ]),
    });
    const embedder = createEmbedder();
    renderController(
      repository,
      embedder,
      vi.fn(async () => ({}) as never)
    );

    act(() => {
      useThreadSearchStore.getState().setQuery('hnsw');
    });
    await flushAsync();

    expect(repository.listNeedingEmbedding).toHaveBeenCalled();
    expect(embedder.embedDocumentWithRecovery).toHaveBeenCalledWith(expect.anything(), 'text');
    expect(useThreadSearchStore.getState().coverage).toEqual(pendingCoverage);
  });

  it("drains the host's backlog after history's, at the same rows per pass", async () => {
    const repository = createRepository();
    const pending = vi
      .fn<HostThreadSearchVectors['pending']>()
      .mockResolvedValueOnce([
        { seq: 1, sourceHash: 'a'.repeat(64), text: 'host text one', threadId: 'host-thread' },
        { seq: 2, sourceHash: 'b'.repeat(64), text: 'host text two', threadId: 'host-thread' },
      ])
      .mockResolvedValue([]);
    const put = vi.fn<HostThreadSearchVectors['put']>(async () => ({ stale: 0, stored: 2 }));
    const embedder = createEmbedder();
    renderController(
      repository,
      embedder,
      vi.fn(async () => ({}) as never),
      undefined,
      { pending, put }
    );

    act(() => {
      useThreadSearchStore.getState().setQuery('hnsw');
    });
    await flushAsync();

    expect(pending).toHaveBeenCalledWith(VECTOR_PROFILE, 16);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith(VECTOR_PROFILE, [
      { seq: 1, sourceHash: 'a'.repeat(64), threadId: 'host-thread', vector: [0.1, 0.2, 0.3] },
      { seq: 2, sourceHash: 'b'.repeat(64), threadId: 'host-thread', vector: [0.4, 0.5, 0.6] },
    ]);
    // The second pass found an empty backlog and stopped.
    expect(pending).toHaveBeenCalledTimes(2);
  });
});
