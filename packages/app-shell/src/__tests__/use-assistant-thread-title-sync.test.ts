import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistantThreadRepository } from '../assistant-memory-repository';

const usePGliteLiveQueryMock = vi.fn();

vi.mock('@brainstrike/db', () => ({
  makeLiveQueryKey: (...parts: unknown[]) => parts.map(String).join(':'),
  usePGliteLiveQuery: (options: unknown) => usePGliteLiveQueryMock(options),
}));

import { useAssistantThreadTitleSync } from '../use-assistant-thread-title-sync';

const repository = {} as AssistantThreadRepository;

describe('useAssistantThreadTitleSync', () => {
  afterEach(() => {
    usePGliteLiveQueryMock.mockReset();
  });

  it('refreshes loaded threads when the live id/title projection changes', async () => {
    const refreshResourceThreads = vi.fn().mockResolvedValue(undefined);
    usePGliteLiveQueryMock.mockReturnValue({
      error: null,
      loading: false,
      rows: [{ id: 'thread-1', title: 'New Thread' }],
    });
    const { rerender } = renderHook(() =>
      useAssistantThreadTitleSync({
        enabled: true,
        loadReady: true,
        refreshResourceThreads,
        repository,
        resourceId: 'resource-1',
      })
    );

    await waitFor(() => {
      expect(refreshResourceThreads).toHaveBeenCalledTimes(1);
    });

    usePGliteLiveQueryMock.mockReturnValue({
      error: null,
      loading: false,
      rows: [{ id: 'thread-1', title: 'Paris Weather Chat' }],
    });
    rerender();

    await waitFor(() => {
      expect(refreshResourceThreads).toHaveBeenCalledTimes(2);
    });
    expect(refreshResourceThreads).toHaveBeenLastCalledWith(repository, 'resource-1');
  });

  it('does not refresh until the resource initial load is ready', () => {
    const refreshResourceThreads = vi.fn().mockResolvedValue(undefined);
    usePGliteLiveQueryMock.mockReturnValue({
      error: null,
      loading: false,
      rows: [{ id: 'thread-1', title: 'Paris Weather Chat' }],
    });

    renderHook(() =>
      useAssistantThreadTitleSync({
        enabled: true,
        loadReady: false,
        refreshResourceThreads,
        repository,
        resourceId: 'resource-1',
      })
    );

    expect(refreshResourceThreads).not.toHaveBeenCalled();
  });
});
