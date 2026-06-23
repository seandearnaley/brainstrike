import { renderHook } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { unsubscribeMock, subscribeMock, useBrainstrikeDbClientMock, useBrainstrikeLiveQueryMock } =
  vi.hoisted(() => {
    const unsubscribe = vi.fn(async () => undefined);
    const subscribe = vi.fn(() => unsubscribe);
    return {
      unsubscribeMock: unsubscribe,
      subscribeMock: subscribe,
      useBrainstrikeDbClientMock: vi.fn(),
      // The live-query hook drives the real subscription lifecycle (its own
      // package tests prove subscribe-on-mount / unsubscribe-on-unmount). Here we
      // simulate that: when enabled, calling the hook registers a subscription,
      // and React cleanup must invoke the returned unsubscribe on unmount.
      useBrainstrikeLiveQueryMock: vi.fn(),
    };
  });

vi.mock('@brainstrike/db', () => ({
  makeLiveQueryKey: (...args: unknown[]) => JSON.stringify(args),
  useBrainstrikeDbClient: useBrainstrikeDbClientMock,
  useBrainstrikeLiveQuery: useBrainstrikeLiveQueryMock,
}));

import { useCrossRootCost } from '../use-cross-root-cost';

type AssistantBridge = { getUrl?: () => Promise<string>; url?: string } | undefined;

function setDesktopAssistantBackend(bridge: AssistantBridge): void {
  (window as unknown as { assistant?: AssistantBridge }).assistant = bridge;
}

describe('useCrossRootCost', () => {
  beforeEach(() => {
    subscribeMock.mockClear();
    unsubscribeMock.mockClear();
    useBrainstrikeDbClientMock.mockReset();
    useBrainstrikeLiveQueryMock.mockReset();
    // Default: durable assistant backend present (desktop) unless a test clears it.
    setDesktopAssistantBackend({ url: 'http://localhost:1234' });
    // Default live-query behavior: a real subscribe/unsubscribe pair tied to
    // React's effect lifecycle, plus empty rows.
    useBrainstrikeLiveQueryMock.mockImplementation((options: { enabled?: boolean }) => {
      if (options.enabled) {
        subscribeMock();
      }
      return { rows: [], loading: false, error: null, refresh: vi.fn() };
    });
  });

  afterEach(() => {
    setDesktopAssistantBackend(undefined);
    vi.restoreAllMocks();
  });

  it('is unavailable and disables the live query when the PGlite handle is absent', () => {
    useBrainstrikeDbClientMock.mockReturnValue(null);

    const { result } = renderHook(() => useCrossRootCost());

    expect(result.current.available).toBe(false);
    expect(useBrainstrikeLiveQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false })
    );
  });

  it('is unavailable on WEB even with a non-null PGlite handle (no desktop assistant backend)', () => {
    // brainstrike is local-first: web ALSO has a PGlite handle. The durable
    // store is desktop-only, so the panel must gate on the assistant backend,
    // not the handle — otherwise web shows a durable-but-empty panel.
    useBrainstrikeDbClientMock.mockReturnValue({});
    setDesktopAssistantBackend(undefined);

    const { result } = renderHook(() => useCrossRootCost());

    expect(result.current.available).toBe(false);
    // Must NOT query the usage table web never writes to.
    expect(useBrainstrikeLiveQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false })
    );
    expect(subscribeMock).not.toHaveBeenCalled();
  });

  it('subscribes on mount and unsubscribes on unmount on desktop (handle + assistant backend)', () => {
    useBrainstrikeDbClientMock.mockReturnValue({});
    // Wire the live-query mock to a real React subscription tied to the render's
    // effect lifecycle so the cleanup path is exercised by unmount (the live
    // query hook itself owns this in production; here we simulate its contract).
    useBrainstrikeLiveQueryMock.mockImplementation((options: { enabled?: boolean }) => {
      useEffect(() => {
        if (!options.enabled) {
          return;
        }
        const unsubscribe = subscribeMock();
        return () => {
          void unsubscribe();
        };
      }, [options.enabled]);
      return { rows: [], loading: false, error: null, refresh: vi.fn() };
    });

    const { result, unmount } = renderHook(() => useCrossRootCost());

    expect(result.current.available).toBe(true);
    expect(subscribeMock).toHaveBeenCalledTimes(1);
    expect(unsubscribeMock).not.toHaveBeenCalled();

    unmount();

    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
  });

  it('maps live-query rows through the strict repo parser (bigint string → number)', () => {
    useBrainstrikeDbClientMock.mockReturnValue({});
    useBrainstrikeLiveQueryMock.mockReturnValue({
      rows: [
        {
          rootId: 'root-a',
          rootDisplayName: 'project-alpha',
          provider: 'openai',
          model: 'gpt-5.2',
          // PGlite returns SUM()::bigint as a string — must coerce to number.
          inputTokens: '1500',
          outputTokens: '300',
        },
      ],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    const { result } = renderHook(() => useCrossRootCost());

    expect(result.current.error).toBeNull();
    expect(result.current.rows).toEqual([
      {
        rootId: 'root-a',
        rootDisplayName: 'project-alpha',
        provider: 'openai',
        model: 'gpt-5.2',
        inputTokens: 1500,
        outputTokens: 300,
      },
    ]);
  });

  it('surfaces a malformed aggregate row as an error, never fabricated zeros', () => {
    useBrainstrikeDbClientMock.mockReturnValue({});
    useBrainstrikeLiveQueryMock.mockReturnValue({
      rows: [
        {
          rootId: 'root-a',
          rootDisplayName: 'project-alpha',
          provider: 'openai',
          model: 'gpt-5.2',
          // A negative aggregate is impossible from a CHECK-constrained table,
          // but a corrupt/garbage value must read as "couldn't load", not $0.
          inputTokens: -5,
          outputTokens: 'not-a-number',
        },
      ],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    const { result } = renderHook(() => useCrossRootCost());

    // The strict parser throws; the hook catches it into the error state and
    // returns NO fabricated rows.
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.rows).toEqual([]);
  });
});
