import { act } from '@brainstrike/test-utils/react-act';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ThreadSearchExtraArms } from '../thread-search-service';
import { resetThreadSearchStore, useThreadSearchStore } from '../thread-search-store';
import {
  THREAD_SEARCH_DEBOUNCE_MS,
  useThreadSearchController,
} from '../use-thread-search-controller';

const FTS_MATCH = {
  headline: '<mark>hnsw</mark>',
  messageCreatedAt: new Date('2026-07-19T00:00:00Z'),
  messageId: 'msg-1',
  rank: 0.5,
  role: 'assistant',
  threadId: 'thread-1',
};

function hostArms(): ThreadSearchExtraArms {
  return { messages: [FTS_MATCH], titles: [] };
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
    searchHost: (query: string) => Promise<ThreadSearchExtraArms> = vi.fn(async () => hostArms())
  ) {
    return renderHook(() =>
      useThreadSearchController({
        resourceId: 'workspace-memory',
        searchHost,
      })
    );
  }

  it('debounces the query before searching the host', async () => {
    const searchHost = vi.fn(async () => hostArms());
    renderController(searchHost);

    act(() => {
      useThreadSearchStore.getState().setQuery('hnsw');
    });
    expect(searchHost).not.toHaveBeenCalled();

    await flushAsync();

    expect(searchHost).toHaveBeenCalledTimes(1);
    expect(searchHost).toHaveBeenCalledWith('hnsw');
    const state = useThreadSearchStore.getState();
    expect(state.status).toBe('results');
    expect(state.results?.[0]?.threadId).toBe('thread-1');
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

    expect(searchHost).toHaveBeenCalledWith('hnsw');
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
});
