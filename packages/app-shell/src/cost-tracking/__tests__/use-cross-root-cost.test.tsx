import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { unsubscribeMock, subscribeMock, usePGliteDatabaseMock, usePGliteLiveQueryMock } =
  vi.hoisted(() => {
    const unsubscribe = vi.fn(async () => undefined);
    const subscribe = vi.fn(() => unsubscribe);
    return {
      subscribeMock: subscribe,
      unsubscribeMock: unsubscribe,
      usePGliteDatabaseMock: vi.fn(),
      // The live-query hook drives the real subscription lifecycle (its own
      // package tests prove subscribe-on-mount / unsubscribe-on-unmount). Here we
      // simulate that: when enabled, calling the hook registers a subscription,
      // and React cleanup must invoke the returned unsubscribe on unmount.
      usePGliteLiveQueryMock: vi.fn(),
    };
  });

vi.mock('@brainstrike/db', () => ({
  makeLiveQueryKey: (...args: unknown[]) => JSON.stringify(args),
  usePGliteDatabase: usePGliteDatabaseMock,
  usePGliteLiveQuery: usePGliteLiveQueryMock,
}));
vi.mock('@brainstrike/db/react', () => ({
  makeLiveQueryKey: (...args: unknown[]) => JSON.stringify(args),
  usePGliteDatabase: usePGliteDatabaseMock,
  usePGliteLiveQuery: usePGliteLiveQueryMock,
}));

import { useCrossRootCost } from '../use-cross-root-cost';

type AgentHostBridge = { connect: (requestId: string) => Promise<void> } | undefined;

function setDesktopAgentHost(bridge: AgentHostBridge): void {
  (window as unknown as { agentHost?: AgentHostBridge }).agentHost = bridge;
}

describe('useCrossRootCost', () => {
  it('does not subscribe to the retired PGlite usage table', () => {
    usePGliteDatabaseMock.mockReturnValue({});
    renderHook(() => useCrossRootCost());
    expect(
      usePGliteLiveQueryMock.mock.calls.every(
        ([options]) => !String(options.query).includes('brainstrike_assistant_run_usage')
      )
    ).toBe(true);
  });

  beforeEach(() => {
    subscribeMock.mockClear();
    unsubscribeMock.mockClear();
    usePGliteDatabaseMock.mockReset();
    usePGliteLiveQueryMock.mockReset();
    // Default: durable assistant backend present (desktop) unless a test clears it.
    setDesktopAgentHost({ connect: async () => undefined });
    // Default live-query behavior: a real subscribe/unsubscribe pair tied to
    // React's effect lifecycle, plus empty rows.
    usePGliteLiveQueryMock.mockImplementation((options: { enabled?: boolean }) => {
      if (options.enabled) {
        subscribeMock();
      }
      return { error: null, loading: false, refresh: vi.fn(), rows: [] };
    });
  });

  afterEach(() => {
    setDesktopAgentHost(undefined);
    Reflect.deleteProperty(window, 'threadGroups');
    vi.restoreAllMocks();
  });

  it('is unavailable on web and subscribes to no database query', () => {
    setDesktopAgentHost(undefined);
    const { result } = renderHook(() => useCrossRootCost());
    expect(result.current.available).toBe(false);
    expect(result.current.rows).toEqual([]);
    expect(subscribeMock).not.toHaveBeenCalled();
  });

  it('names a host row by its root, as the usage aggregation joins the roots table', () => {
    usePGliteDatabaseMock.mockReturnValue({});
    usePGliteLiveQueryMock.mockImplementation((options: { query: string }) => ({
      error: null,
      loading: false,
      refresh: vi.fn(),
      rows: options.query.includes('FROM roots')
        ? [
            { displayName: 'Workspace B', id: 'root-b' },
            { displayName: null, id: 'root-c' },
          ]
        : [],
    }));
    const hostRow = {
      estimatedCacheCreationTokens: 0,
      estimatedCacheReadTokens: 0,
      estimatedInputTokens: 40,
      estimatedOutputTokens: 6,
      inputTokens: 40,
      model: 'anthropic/claude-sonnet-4.6',
      outputTokens: 6,
      provider: 'openrouter',
    };
    const hostRootUsage = [
      { ...hostRow, rootDisplayName: null, rootId: null },
      { ...hostRow, rootDisplayName: null, rootId: 'root-b' },
      { ...hostRow, rootDisplayName: 'Committed name', rootId: 'root-c' },
    ];

    const { result } = renderHook(() => useCrossRootCost(hostRootUsage));

    expect(
      result.current.rows.map(({ rootDisplayName, rootId }) => [rootId, rootDisplayName])
    ).toEqual([
      [null, null],
      ['root-b', 'Workspace B'],
      // A root the table leaves unnamed keeps the name its run committed.
      ['root-c', 'Committed name'],
    ]);
  });
  it('reads native folder names without a PGlite provider and surfaces catalog failure', async () => {
    const readRoots = vi
      .fn()
      .mockResolvedValue([{ displayName: 'Current folder', id: 'root-b', path: '/fixture' }]);
    Object.defineProperty(window, 'threadGroups', { configurable: true, value: { readRoots } });
    usePGliteDatabaseMock.mockImplementation(({ enabled }: { enabled?: boolean } = {}) => {
      if (enabled !== false) {
        throw new Error('Native costs attempted PGlite');
      }
      return null;
    });
    const usage = [
      {
        estimatedCacheCreationTokens: 0,
        estimatedCacheReadTokens: 0,
        estimatedInputTokens: 40,
        estimatedOutputTokens: 6,
        inputTokens: 40,
        model: 'model',
        outputTokens: 6,
        provider: 'provider',
        rootDisplayName: 'Committed folder',
        rootId: 'root-b',
      },
    ];
    const { result, unmount } = renderHook(() => useCrossRootCost(usage));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.rows[0]?.rootDisplayName).toBe('Current folder');
    expect(subscribeMock).not.toHaveBeenCalled();
    unmount();
    const failure = new Error('Catalog unavailable');
    readRoots.mockRejectedValue(failure);
    const failed = renderHook(() => useCrossRootCost(usage));
    await waitFor(() => expect(failed.result.current.error).toBe(failure));
  });
});
