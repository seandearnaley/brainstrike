import { renderHook } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { unsubscribeMock, subscribeMock, usePGliteDatabaseMock, usePGliteLiveQueryMock } =
  vi.hoisted(() => {
    const unsubscribe = vi.fn(async () => undefined);
    const subscribe = vi.fn(() => unsubscribe);
    return {
      unsubscribeMock: unsubscribe,
      subscribeMock: subscribe,
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

import { useCrossRootCost } from '../use-cross-root-cost';

describe('useCrossRootCost', () => {
  beforeEach(() => {
    subscribeMock.mockClear();
    unsubscribeMock.mockClear();
    usePGliteDatabaseMock.mockReset();
    usePGliteLiveQueryMock.mockReset();
    // Default live-query behavior: a real subscribe/unsubscribe pair tied to
    // React's effect lifecycle, plus empty rows.
    usePGliteLiveQueryMock.mockImplementation((options: { enabled?: boolean }) => {
      if (options.enabled) {
        subscribeMock();
      }
      return { rows: [], loading: false, error: null, refresh: vi.fn() };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is unavailable and disables the live query when the db handle is absent (web)', () => {
    usePGliteDatabaseMock.mockReturnValue(null);

    const { result } = renderHook(() => useCrossRootCost());

    expect(result.current.available).toBe(false);
    expect(usePGliteLiveQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false })
    );
  });

  it('subscribes on mount and unsubscribes on unmount when the db handle is present (desktop)', () => {
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
      return { rows: [], loading: false, error: null, refresh: vi.fn() };
    });

    const { result, unmount } = renderHook(() => useCrossRootCost());

    expect(result.current.available).toBe(true);
    expect(subscribeMock).toHaveBeenCalledTimes(1);
    expect(unsubscribeMock).not.toHaveBeenCalled();

    unmount();

    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
  });

  it('maps live-query rows into typed cross-root usage rows', () => {
    usePGliteDatabaseMock.mockReturnValue({});
    usePGliteLiveQueryMock.mockReturnValue({
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
});
