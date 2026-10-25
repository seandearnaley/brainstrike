import { act } from '@brainstrike/test-utils/react-act';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantThreadSearchSemantic } from '../assistant-thread-host-context';
import type { HostThreadSearchVectors } from '../host-thread-search-vectors';
import type { ThreadSearchExtraArms } from '../thread-search-service';
import { resetThreadSearchStore, useThreadSearchStore } from '../thread-search-store';
import {
  THREAD_SEARCH_DEBOUNCE_MS,
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

const FTS_MATCH = {
  headline: '<mark>hnsw</mark>',
  messageCreatedAt: new Date('2026-07-19T00:00:00Z'),
  messageId: 'msg-1',
  rank: 0.5,
  role: 'assistant',
  threadId: 'thread-1',
};

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

function hostArms(): ThreadSearchExtraArms {
  return { messages: [FTS_MATCH], similarMessages: [], titles: [] };
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
    searchHost: (
      query: string,
      semantic?: AssistantThreadSearchSemantic
    ) => Promise<ThreadSearchExtraArms> = vi.fn(async () => hostArms()),
    embedder = createEmbedder(),
    hostSearchVectors?: HostThreadSearchVectors
  ) {
    return renderHook(() =>
      useThreadSearchController({
        embedder,
        hostSearchVectors,
        localModelConfigMap: new Map() as never,
        readEmbeddingProfile: async () => PROFILE,
        resourceId: 'workspace-memory',
        searchHost,
      })
    );
  }

  it('searches the host with its unchanged profile', async () => {
    const searchHost = vi.fn(async () => hostArms());
    const readEmbeddingProfile = vi.fn(async () => PROFILE);
    renderHook(() =>
      useThreadSearchController({
        embedder: createEmbedder(),
        localModelConfigMap: new Map() as never,
        readEmbeddingProfile,
        resourceId: 'workspace-memory',
        searchHost,
      })
    );
    act(() => useThreadSearchStore.getState().setQuery('hnsw'));
    await flushAsync();
    expect(searchHost).toHaveBeenCalledWith('hnsw', {
      profile: VECTOR_PROFILE,
      threshold: 0.35,
      vector: [0.1, 0.2, 0.3],
    });
    expect(useThreadSearchStore.getState().semantic).toEqual({ kind: 'used' });
    expect(readEmbeddingProfile).toHaveBeenCalled();
    expect(useThreadSearchStore.getState().status).toBe('results');
    expect(useThreadSearchStore.getState().results?.[0]?.threadId).toBe('thread-1');
  });

  it('debounces the query before searching the host', async () => {
    const searchHost = vi.fn(async () => hostArms());
    const embedder = createEmbedder();
    renderController(searchHost, embedder);

    act(() => {
      useThreadSearchStore.getState().setQuery('hnsw');
    });
    expect(searchHost).not.toHaveBeenCalled();

    await flushAsync();

    expect(embedder.embedQueryWithRecovery).toHaveBeenCalledTimes(1);
    const state = useThreadSearchStore.getState();
    expect(state.status).toBe('results');
    expect(state.results?.[0]?.threadId).toBe('thread-1');
    expect(state.semantic).toEqual({ kind: 'used' });
  });

  it('records a visible unavailable reason when query embedding fails', async () => {
    const searchHost = vi.fn(async () => hostArms());
    renderController(searchHost, createEmbedder(new Error('embedder offline')));

    act(() => {
      useThreadSearchStore.getState().setQuery('hnsw');
    });
    await flushAsync();

    const state = useThreadSearchStore.getState();
    expect(state.status).toBe('results');
    expect(searchHost).toHaveBeenCalledWith('hnsw', undefined);
    expect(state.semantic).toEqual({ kind: 'unavailable', reason: 'embedder offline' });
  });

  it('caches an embedding failure so later searches resolve immediately lexical-only', async () => {
    const embedder = createEmbedder(new Error('embedder offline'));
    renderController(undefined, embedder);

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
    renderController(undefined, embedder);

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
    renderController();

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

  it('drops results from a superseded run (generation guard end-to-end)', async () => {
    let releaseFirst: ((value: ThreadSearchExtraArms) => void) | null = null;
    const searchHost = vi
      .fn(async () => hostArms())
      .mockImplementationOnce(
        () =>
          new Promise<ThreadSearchExtraArms>((resolve) => {
            releaseFirst = resolve;
          })
      );
    renderController(searchHost);

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
      releaseFirst?.({
        messages: [{ ...FTS_MATCH, threadId: 'stale-thread' }],
        similarMessages: [],
        titles: [],
      });
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(useThreadSearchStore.getState().results).toBe(resolvedResults);
  });

  it('searches the host catalog', async () => {
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
    renderController(searchHost);

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
      'host-thread',
    ]);
  });

  it('fails the search visibly when the host search fails', async () => {
    renderController(async () => {
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

  it('drains the host backlog for desktop conversations', async () => {
    const pending = vi
      .fn<HostThreadSearchVectors['pending']>()
      .mockResolvedValueOnce([
        { seq: 1, sourceHash: 'a'.repeat(64), text: 'host text one', threadId: 'host-thread' },
        { seq: 2, sourceHash: 'b'.repeat(64), text: 'host text two', threadId: 'host-thread' },
      ])
      .mockResolvedValue([]);
    const put = vi.fn<HostThreadSearchVectors['put']>(async () => ({
      failed: 0,
      stale: 0,
      stored: 2,
    }));
    // The host's half of the panel's embedding progress, read after each host pass.
    const coverage = vi
      .fn<HostThreadSearchVectors['coverage']>()
      .mockResolvedValueOnce({ embedded: 0, errored: 0, rows: 2 })
      .mockResolvedValue({ embedded: 2, errored: 0, rows: 2 });
    renderController(async () => ({ messages: [], titles: [] }), createEmbedder(), {
      coverage,
      pending,
      put,
    });

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
    // Only the current owner's rows contribute to progress.
    expect(coverage).toHaveBeenCalledWith(VECTOR_PROFILE);
    expect(useThreadSearchStore.getState().coverage).toEqual({
      embeddableMessages: 2,
      embeddedMessages: 2,
      erroredMessages: 0,
      indexedMessages: 2,
      totalMessages: 2,
    });
  });
});
