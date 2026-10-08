import type { AssistantThreadRepository } from '@brainstrike/assistant-data';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const usePGliteLiveQueryMock = vi.fn();

vi.mock('@brainstrike/db', () => ({
  makeLiveQueryKey: (...parts: unknown[]) => parts.map(String).join(':'),
  usePGliteLiveQuery: (options: unknown) => usePGliteLiveQueryMock(options),
}));
vi.mock('@brainstrike/db/react', () => ({
  makeLiveQueryKey: (...parts: unknown[]) => parts.map(String).join(':'),
  usePGliteLiveQuery: (options: unknown) => usePGliteLiveQueryMock(options),
}));

import {
  type AssistantThreadHostCapability,
  AssistantThreadHostContext,
} from '../assistant-thread-host-context';
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

  it('does not refresh when the resource initial load has not enabled the subscription', () => {
    const refreshResourceThreads = vi.fn().mockResolvedValue(undefined);
    usePGliteLiveQueryMock.mockReturnValue({
      error: null,
      loading: false,
      rows: [{ id: 'thread-1', title: 'Paris Weather Chat' }],
    });

    renderHook(() =>
      useAssistantThreadTitleSync({
        enabled: false,
        refreshResourceThreads,
        repository,
        resourceId: 'resource-1',
      })
    );

    expect(refreshResourceThreads).not.toHaveBeenCalled();
  });

  it('does not refresh for a new rows object with the same id/title projection', async () => {
    const refreshResourceThreads = vi.fn().mockResolvedValue(undefined);
    usePGliteLiveQueryMock.mockReturnValue({
      error: null,
      loading: false,
      rows: [{ id: 'thread-1', title: 'Paris Weather Chat' }],
    });
    const { rerender } = renderHook(() =>
      useAssistantThreadTitleSync({
        enabled: true,
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
      expect(refreshResourceThreads).toHaveBeenCalledTimes(1);
    });
  });

  it('returns a run-completion refresh for recency and subscription-error recovery', async () => {
    const refreshResourceThreads = vi.fn().mockResolvedValue(undefined);
    usePGliteLiveQueryMock.mockReturnValue({
      error: new Error('subscription failed'),
      loading: false,
      rows: [],
    });
    const { result } = renderHook(() =>
      useAssistantThreadTitleSync({
        enabled: true,
        refreshResourceThreads,
        repository,
        resourceId: 'resource-1',
      })
    );

    act(() => {
      result.current();
    });

    await waitFor(() => {
      expect(refreshResourceThreads).toHaveBeenCalledWith(repository, 'resource-1');
    });
  });

  it('surfaces a rejected run-completion refresh without rejecting the caller', async () => {
    const refreshResourceThreads = vi.fn().mockRejectedValue(new Error('refresh failed'));
    usePGliteLiveQueryMock.mockReturnValue({
      error: null,
      loading: true,
      rows: [],
    });
    const { result } = renderHook(() =>
      useAssistantThreadTitleSync({
        enabled: true,
        refreshResourceThreads,
        repository,
        resourceId: 'resource-1',
      })
    );

    act(() => {
      expect(result.current()).toBeUndefined();
    });

    await waitFor(() => {
      expect(refreshResourceThreads).toHaveBeenCalledWith(repository, 'resource-1');
    });
  });

  it('refreshes through the host so a title update never drops host threads from the store', async () => {
    const historyThread = { id: 'legacy-thread' };
    const hostThread = { id: 'host-thread' };
    const history = {
      listThreads: vi.fn(async () => [historyThread]),
    } as unknown as AssistantThreadRepository;
    const host = {
      listThreads: vi.fn(async () => [hostThread]),
    } as unknown as AssistantThreadHostCapability;
    const refreshResourceThreads = vi.fn().mockResolvedValue(undefined);
    usePGliteLiveQueryMock.mockReturnValue({
      error: null,
      loading: false,
      rows: [{ id: 'legacy-thread', title: 'Renamed by Mastra' }],
    });
    const wrapper = ({ children }: { readonly children: ReactNode }) =>
      createElement(AssistantThreadHostContext.Provider, { value: host }, children);
    renderHook(
      () =>
        useAssistantThreadTitleSync({
          enabled: true,
          refreshResourceThreads,
          repository: history,
          resourceId: 'resource-1',
        }),
      { wrapper }
    );

    await waitFor(() => {
      expect(refreshResourceThreads).toHaveBeenCalledTimes(1);
    });
    const listed: AssistantThreadRepository = refreshResourceThreads.mock.calls[0]?.[0];
    expect(await listed.listThreads('resource-1')).toEqual([hostThread, historyThread]);
  });

  it('makes the run-completion refresh a no-op without a repository', () => {
    const refreshResourceThreads = vi.fn().mockResolvedValue(undefined);
    usePGliteLiveQueryMock.mockReturnValue({
      error: null,
      loading: false,
      rows: [],
    });
    const { result } = renderHook(() =>
      useAssistantThreadTitleSync({
        enabled: false,
        refreshResourceThreads,
        repository: null,
        resourceId: 'resource-1',
      })
    );

    act(() => {
      result.current();
    });

    expect(refreshResourceThreads).not.toHaveBeenCalled();
  });
});
