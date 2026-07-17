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

import { RUN_LEDGER_AGGREGATION_SQL } from '../../assistant-memory-repository';
import { TASK_LEDGER_RUN_LIMIT, useRunLedger } from '../use-run-ledger';

type AssistantBridge = { getUrl?: () => Promise<string>; url?: string } | undefined;

function setDesktopAssistantBackend(bridge: AssistantBridge): void {
  (window as unknown as { assistant?: AssistantBridge }).assistant = bridge;
}

/** A raw aggregate row exactly as PGlite returns it (bigints as strings). */
function makeRawRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    billedCostUsd: null,
    completedAt: '2026-07-15T12:00:05.000Z',
    durationMs: '5000',
    editCount: '2',
    estimatedInputTokens: '0',
    estimatedOutputTokens: '0',
    failedToolCallCount: '1',
    inputTokens: '1500',
    model: 'gpt-5.2',
    outcomeDetail: null,
    outcomeSource: 'user',
    outcomeVerdict: 'succeeded',
    outputTokens: '300',
    provider: 'openai',
    revertedEditCount: '1',
    runId: 'run-1',
    startedAt: '2026-07-15T12:00:00.000Z',
    status: 'completed',
    threadId: 'thread-1',
    toolCallCount: '5',
    ...overrides,
  };
}

describe('useRunLedger', () => {
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

  it('is unavailable and disables the live query when the PGlite handle is absent', () => {
    usePGliteDatabaseMock.mockReturnValue(null);

    const { result } = renderHook(() => useRunLedger());

    expect(result.current.available).toBe(false);
    expect(usePGliteLiveQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false })
    );
  });

  it('is unavailable on WEB even with a PGlite handle (no desktop assistant backend)', () => {
    usePGliteDatabaseMock.mockReturnValue({});
    setDesktopAssistantBackend(undefined);

    const { result } = renderHook(() => useRunLedger());

    expect(result.current.available).toBe(false);
    expect(usePGliteLiveQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false })
    );
  });

  it('queries the shared ledger aggregation with the panel row limit', () => {
    usePGliteDatabaseMock.mockReturnValue({});

    renderHook(() => useRunLedger());

    expect(usePGliteLiveQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        params: ['brainstrike:workspace', TASK_LEDGER_RUN_LIMIT],
        query: RUN_LEDGER_AGGREGATION_SQL,
      })
    );
  });

  it('maps live-query rows through the strict repo parser (bigint string → number)', () => {
    usePGliteDatabaseMock.mockReturnValue({});
    usePGliteLiveQueryMock.mockReturnValue({
      error: null,
      loading: false,
      refresh: vi.fn(),
      rows: [makeRawRow({ billedCostUsd: '0.42' })],
    });

    const { result } = renderHook(() => useRunLedger());

    expect(result.current.error).toBeNull();
    expect(result.current.rows).toEqual([
      {
        billedCostUsd: 0.42,
        completedAt: new Date('2026-07-15T12:00:05.000Z'),
        durationMs: 5000,
        editCount: 2,
        estimatedInputTokens: 0,
        estimatedOutputTokens: 0,
        failedToolCallCount: 1,
        inputTokens: 1500,
        model: 'gpt-5.2',
        outcomeDetail: null,
        outcomeSource: 'user',
        outcomeVerdict: 'succeeded',
        outputTokens: 300,
        provider: 'openai',
        revertedEditCount: 1,
        runId: 'run-1',
        startedAt: new Date('2026-07-15T12:00:00.000Z'),
        status: 'completed',
        threadId: 'thread-1',
        toolCallCount: 5,
      },
    ]);
  });

  it('omits billedCostUsd (never fabricates $0) when no exact cost was captured', () => {
    usePGliteDatabaseMock.mockReturnValue({});
    usePGliteLiveQueryMock.mockReturnValue({
      error: null,
      loading: false,
      refresh: vi.fn(),
      rows: [makeRawRow()],
    });

    const { result } = renderHook(() => useRunLedger());

    expect(result.current.rows[0]).not.toHaveProperty('billedCostUsd');
  });

  it('surfaces a malformed aggregate row as an error, never fabricated zeros', () => {
    usePGliteDatabaseMock.mockReturnValue({});
    usePGliteLiveQueryMock.mockReturnValue({
      error: null,
      loading: false,
      refresh: vi.fn(),
      rows: [makeRawRow({ inputTokens: 'not-a-number' })],
    });

    const { result } = renderHook(() => useRunLedger());

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.rows).toEqual([]);
  });
});
