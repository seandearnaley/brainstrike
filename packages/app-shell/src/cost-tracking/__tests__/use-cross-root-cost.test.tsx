import { renderHook } from '@testing-library/react';
import { useEffect } from 'react';
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
    vi.restoreAllMocks();
  });

  it('is unavailable and disables the live query when the PGlite handle is absent', () => {
    usePGliteDatabaseMock.mockReturnValue(null);

    const { result } = renderHook(() => useCrossRootCost());

    expect(result.current.available).toBe(false);
    expect(usePGliteLiveQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false })
    );
  });

  it('is unavailable on WEB even with a non-null PGlite handle (no desktop assistant backend)', () => {
    // brainstrike is local-first: web ALSO has a PGlite handle. The durable
    // store is desktop-only, so the panel must gate on the assistant backend,
    // not the handle — otherwise web shows a durable-but-empty panel.
    usePGliteDatabaseMock.mockReturnValue({});
    setDesktopAgentHost(undefined);

    const { result } = renderHook(() => useCrossRootCost());

    expect(result.current.available).toBe(false);
    // Must NOT query the usage table web never writes to.
    expect(usePGliteLiveQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false })
    );
    expect(subscribeMock).not.toHaveBeenCalled();
  });

  it('subscribes on mount and unsubscribes on unmount on desktop (handle + assistant backend)', () => {
    usePGliteDatabaseMock.mockReturnValue({});
    // Wire the live-query mock to a real React subscription tied to the render's
    // effect lifecycle so the cleanup path is exercised by unmount (the live
    // query hook itself owns this in production; here we simulate its contract).
    usePGliteLiveQueryMock.mockImplementation((options: { enabled?: boolean }) => {
      useEffect(() => {
        if (!options.enabled) {
          return;
        }
        const unsubscribe = subscribeMock();
        return () => {
          void unsubscribe();
        };
      }, [options.enabled]);
      return { error: null, loading: false, refresh: vi.fn(), rows: [] };
    });

    const { result, unmount } = renderHook(() => useCrossRootCost());

    expect(result.current.available).toBe(true);
    expect(subscribeMock).toHaveBeenCalledTimes(1);
    expect(unsubscribeMock).not.toHaveBeenCalled();

    unmount();

    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
  });

  it('maps live-query rows through the strict repo parser (bigint string → number)', () => {
    usePGliteDatabaseMock.mockReturnValue({});
    usePGliteLiveQueryMock.mockReturnValue({
      error: null,
      loading: false,
      refresh: vi.fn(),
      rows: [
        {
          // PGlite returns SUM()::bigint as a string — must coerce to number.
          inputTokens: '1500',
          model: 'gpt-5.2',
          outputTokens: '300',
          provider: 'openai',
          rootDisplayName: 'project-alpha',
          rootId: 'root-a',
        },
      ],
    });

    const { result } = renderHook(() => useCrossRootCost());

    expect(result.current.error).toBeNull();
    expect(result.current.rows).toEqual([
      {
        estimatedCacheCreationTokens: 0,
        estimatedCacheReadTokens: 0,
        inputTokens: 1500,
        model: 'gpt-5.2',
        outputTokens: 300,
        provider: 'openai',
        rootDisplayName: 'project-alpha',
        rootId: 'root-a',
      },
    ]);
  });

  it('surfaces a malformed aggregate row as an error, never fabricated zeros', () => {
    usePGliteDatabaseMock.mockReturnValue({});
    usePGliteLiveQueryMock.mockReturnValue({
      error: null,
      loading: false,
      refresh: vi.fn(),
      rows: [
        {
          // A negative aggregate is impossible from a CHECK-constrained table,
          // but a corrupt/garbage value must read as "couldn't load", not $0.
          inputTokens: -5,
          model: 'gpt-5.2',
          outputTokens: 'not-a-number',
          provider: 'openai',
          rootDisplayName: 'project-alpha',
          rootId: 'root-a',
        },
      ],
    });

    const { result } = renderHook(() => useCrossRootCost());

    // The strict parser throws; the hook catches it into the error state and
    // returns NO fabricated rows.
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.rows).toEqual([]);
  });

  it("lists the agent host's per-root usage beside the usage rows", () => {
    usePGliteDatabaseMock.mockReturnValue({});
    usePGliteLiveQueryMock.mockImplementation((options: { query: string }) => ({
      error: null,
      loading: false,
      refresh: vi.fn(),
      rows: options.query.includes('FROM roots')
        ? []
        : [
            {
              billedCostUsd: '0.1',
              estimatedInputTokens: '0',
              estimatedOutputTokens: '0',
              inputTokens: '1000',
              model: 'gpt-5.2',
              outputTokens: '100',
              provider: 'openai',
              rootDisplayName: 'Workspace A',
              rootId: 'root-a',
            },
          ],
    }));
    const hostRootUsage = [
      {
        estimatedCacheCreationTokens: 0,
        estimatedCacheReadTokens: 0,
        estimatedInputTokens: 40,
        estimatedOutputTokens: 6,
        inputTokens: 40,
        model: 'anthropic/claude-sonnet-4.6',
        outputTokens: 6,
        provider: 'openrouter',
        rootDisplayName: 'Workspace A',
        rootId: 'root-a',
      },
    ];

    const { result } = renderHook(() => useCrossRootCost(undefined, hostRootUsage));

    expect(result.current.rows).toEqual([
      expect.objectContaining({ inputTokens: 1000, rootId: 'root-a' }),
      hostRootUsage[0],
    ]);
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

    const { result } = renderHook(() => useCrossRootCost(undefined, hostRootUsage));

    expect(
      result.current.rows.map(({ rootDisplayName, rootId }) => [rootId, rootDisplayName])
    ).toEqual([
      [null, null],
      ['root-b', 'Workspace B'],
      // A root the table leaves unnamed keeps the name its run committed.
      ['root-c', 'Committed name'],
    ]);
  });
});
