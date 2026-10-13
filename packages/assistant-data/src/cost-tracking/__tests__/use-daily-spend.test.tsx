import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { usePGliteDatabaseMock, usePGliteLiveQueryMock } = vi.hoisted(() => ({
  usePGliteDatabaseMock: vi.fn(),
  usePGliteLiveQueryMock: vi.fn(),
}));

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

import { useDailySpend } from '../use-daily-spend';

type AgentHostBridge = { connect: (requestId: string) => Promise<void> } | undefined;

function setDesktopAgentHost(bridge: AgentHostBridge): void {
  (window as unknown as { agentHost?: AgentHostBridge }).agentHost = bridge;
}

describe('useDailySpend', () => {
  it('prices only committed host calls without a PGlite database', () => {
    usePGliteDatabaseMock.mockReturnValue(null);
    const { result } = renderHook(() =>
      useDailySpend([
        {
          at: Date.now(),
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          inputTokens: 1_000_000,
          model: 'gpt-5.2',
          outputTokens: 0,
          provider: 'openai',
        },
      ])
    );
    expect(result.current.available).toBe(true);
    expect(result.current.spend?.totalUsd).toBeGreaterThan(0);
    expect(usePGliteLiveQueryMock).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    usePGliteDatabaseMock.mockReset();
    usePGliteLiveQueryMock.mockReset();
    setDesktopAgentHost({ connect: async () => undefined });
    usePGliteLiveQueryMock.mockReturnValue({
      error: null,
      loading: false,
      refresh: vi.fn(),
      rows: [],
    });
  });

  afterEach(() => {
    setDesktopAgentHost(undefined);
    vi.restoreAllMocks();
  });

  it('is unavailable on web and issues no database query', () => {
    setDesktopAgentHost(undefined);
    const { result } = renderHook(() => useDailySpend());
    expect(result.current.available).toBe(false);
    expect(result.current.spend).toBeNull();
    expect(usePGliteLiveQueryMock).not.toHaveBeenCalled();
  });

  it('ages committed calls out of the rolling window on refresh', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T06:00:00Z'));
    const usage = [
      {
        at: Date.now(),
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        inputTokens: 1_000_000,
        model: 'gpt-5.2',
        outputTokens: 0,
        provider: 'openai',
      },
    ];
    const { result, unmount } = renderHook(() => useDailySpend(usage));
    expect(result.current.spend?.totalUsd).toBeGreaterThan(0);
    vi.setSystemTime(new Date('2026-10-14T06:00:01Z'));
    await act(() => result.current.refresh());
    expect(result.current.spend?.totalUsd).toBe(0);
    unmount();
    vi.useRealTimers();
  });
});
