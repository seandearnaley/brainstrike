import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetThreadSearchStore, useThreadSearchStore } from '../thread-search-store';
import {
  THREAD_SEARCH_DEBOUNCE_MS,
  type ThreadSearchControllerRepository,
  useThreadSearchController,
} from '../use-thread-search-controller';

vi.mock('../prompt-embedding-model-info', () => ({
  resolveSingletonProfileModelInfo: vi.fn(() => ({
    dimensions: 3,
    modelConfig: null,
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

function createEmbedder(query: number[] | Error = [0.1, 0.2, 0.3]) {
  return {
    embedDocumentWithRecovery: vi.fn(async () => [0.1, 0.2, 0.3]),
    embedQueryWithRecovery: vi.fn(async () => {
      if (query instanceof Error) {
        throw query;
      }
      return query;
    }),
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
    loadEmbeddingQueue: (() => Promise<never>) | null = null
  ) {
    return renderHook(() =>
      useThreadSearchController({
        embedder,
        loadEmbeddingQueue,
        localModelConfigMap: new Map() as never,
        repository,
        resourceId: 'workspace-memory',
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
});
