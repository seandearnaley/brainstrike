import { renderHook } from '@testing-library/react';
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

import { useDailySpend } from '../use-daily-spend';

type AssistantBridge = { getUrl?: () => Promise<string>; url?: string } | undefined;

function setDesktopAssistantBackend(bridge: AssistantBridge): void {
  (window as unknown as { assistant?: AssistantBridge }).assistant = bridge;
}

describe('useDailySpend', () => {
  beforeEach(() => {
    usePGliteDatabaseMock.mockReset();
    usePGliteLiveQueryMock.mockReset();
    setDesktopAssistantBackend({ url: 'http://localhost:1234' });
    usePGliteLiveQueryMock.mockReturnValue({
      error: null,
      loading: false,
      refresh: vi.fn(),
      rows: [],
    });
  });

  afterEach(() => {
    setDesktopAssistantBackend(undefined);
    vi.restoreAllMocks();
  });

  it('is unavailable (spend null) without the durable-usage capability and issues no query', () => {
    usePGliteDatabaseMock.mockReturnValue({});
    setDesktopAssistantBackend(undefined);

    const { result } = renderHook(() => useDailySpend());

    expect(result.current.available).toBe(false);
    expect(result.current.spend).toBeNull();
    expect(usePGliteLiveQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false })
    );
  });

  it('keeps spend null while the live query is loading (no premature $0 verdicts)', () => {
    usePGliteDatabaseMock.mockReturnValue({});
    usePGliteLiveQueryMock.mockReturnValue({
      error: null,
      loading: true,
      refresh: vi.fn(),
      rows: [],
    });

    const { result } = renderHook(() => useDailySpend());

    expect(result.current.available).toBe(true);
    expect(result.current.loading).toBe(true);
    expect(result.current.spend).toBeNull();
  });

  it('prices last-24h rows: exact billed cost plus registry-priced remainder, unpriced excluded', () => {
    usePGliteDatabaseMock.mockReturnValue({});
    usePGliteLiveQueryMock.mockReturnValue({
      error: null,
      loading: false,
      refresh: vi.fn(),
      rows: [
        {
          billedCostUsd: '1.5',
          model: 'gpt-5.2',
          provider: 'openai',
          unreportedInputTokens: '0',
          unreportedOutputTokens: '0',
        },
        {
          billedCostUsd: null,
          model: 'definitely-not-in-registry',
          provider: 'ollama',
          unreportedInputTokens: '1000000',
          unreportedOutputTokens: '1000000',
        },
      ],
    });

    const { result } = renderHook(() => useDailySpend());

    expect(result.current.error).toBeNull();
    expect(result.current.spend).not.toBeNull();
    expect(result.current.spend?.exactUsd).toBe(1.5);
    // ollama models have no registry list price → excluded + explicitly named.
    expect(result.current.spend?.totalUsd).toBe(1.5);
    expect(result.current.spend?.unpricedModels).toEqual(['ollama::definitely-not-in-registry']);
  });

  it('surfaces a malformed aggregate as an error with spend null, never fabricated $0', () => {
    usePGliteDatabaseMock.mockReturnValue({});
    usePGliteLiveQueryMock.mockReturnValue({
      error: null,
      loading: false,
      refresh: vi.fn(),
      rows: [
        {
          billedCostUsd: 'garbage',
          model: 'gpt-5.2',
          provider: 'openai',
          unreportedInputTokens: '0',
          unreportedOutputTokens: '0',
        },
      ],
    });

    const { result } = renderHook(() => useDailySpend());

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.spend).toBeNull();
  });
});
