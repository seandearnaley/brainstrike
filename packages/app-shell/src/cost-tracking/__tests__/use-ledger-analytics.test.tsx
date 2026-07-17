import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { usePGliteDatabaseMock } = vi.hoisted(() => ({
  usePGliteDatabaseMock: vi.fn(),
}));

vi.mock('@brainstrike/db', () => ({
  usePGliteDatabase: usePGliteDatabaseMock,
}));

import { useLedgerAnalytics } from '../use-ledger-analytics';

type AssistantBridge = { getUrl?: () => Promise<string>; url?: string } | undefined;

function setDesktopAssistantBackend(bridge: AssistantBridge): void {
  (window as unknown as { assistant?: AssistantBridge }).assistant = bridge;
}

const TREND_RAW_ROW: Record<string, unknown> = {
  billedCostUsd: '0.42',
  bucketStart: '2026-07-14T00:00:00.000Z',
  estimatedInputTokens: '0',
  estimatedOutputTokens: '0',
  inputTokens: '1000',
  outputTokens: '200',
  runCount: '3',
};

const MODEL_RAW_ROW: Record<string, unknown> = {
  avgDurationMs: '42000.4',
  billedCostUsd: null,
  cancelledRunCount: '0',
  completedRunCount: '2',
  estimatedInputTokens: '1500',
  estimatedOutputTokens: '300',
  failedRunCount: '1',
  inputTokens: '1500',
  labeledFailedCount: '1',
  labeledMixedCount: '0',
  labeledSucceededCount: '2',
  model: 'gpt-5.2',
  outputTokens: '300',
  provider: 'openai',
  runCount: '3',
};

/** Fake DbHandle routing the two analytics queries by their SQL shape. */
function makeQueryMock() {
  return vi.fn((sql: string) => {
    if (sql.includes('date_bin')) {
      return Promise.resolve({ rows: [TREND_RAW_ROW] });
    }
    return Promise.resolve({ rows: [MODEL_RAW_ROW] });
  });
}

describe('useLedgerAnalytics', () => {
  beforeEach(() => {
    usePGliteDatabaseMock.mockReset();
    setDesktopAssistantBackend({ url: 'http://localhost:1234' });
  });

  afterEach(() => {
    setDesktopAssistantBackend(undefined);
    vi.restoreAllMocks();
  });

  it('is unavailable on WEB and never issues the analytics queries', () => {
    const query = makeQueryMock();
    usePGliteDatabaseMock.mockReturnValue({ query });
    setDesktopAssistantBackend(undefined);

    const { result } = renderHook(() => useLedgerAnalytics());

    expect(result.current.available).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it('loads the daily cost trend and model comparison through the strict parsers', async () => {
    const query = makeQueryMock();
    usePGliteDatabaseMock.mockReturnValue({ query });

    const { result } = renderHook(() => useLedgerAnalytics());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.trend).toHaveLength(1);
    });

    expect(result.current.error).toBeNull();
    expect(result.current.trend[0]).toEqual({
      billedCostUsd: 0.42,
      bucketStart: new Date('2026-07-14T00:00:00.000Z'),
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      inputTokens: 1000,
      outputTokens: 200,
      runCount: 3,
    });
    expect(result.current.models[0]).toEqual({
      avgDurationMs: 42_000,
      cancelledRunCount: 0,
      completedRunCount: 2,
      estimatedInputTokens: 1500,
      estimatedOutputTokens: 300,
      failedRunCount: 1,
      inputTokens: 1500,
      labeledFailedCount: 1,
      labeledMixedCount: 0,
      labeledSucceededCount: 2,
      model: 'gpt-5.2',
      outputTokens: 300,
      provider: 'openai',
      runCount: 3,
    });
    // Trend uses the fixed 'day' bucket in v1.
    expect(query).toHaveBeenCalledWith(expect.stringContaining("INTERVAL '1 day'"), [
      'brainstrike:workspace',
    ]);
  });

  it('surfaces a query failure as a visible error state, never empty-but-fine', async () => {
    const query = vi.fn(() => Promise.reject(new Error('relation missing')));
    usePGliteDatabaseMock.mockReturnValue({ query });

    const { result } = renderHook(() => useLedgerAnalytics());

    await waitFor(() => {
      expect(result.current.error).toBeInstanceOf(Error);
    });
    expect(result.current.error?.message).toContain('relation missing');
    expect(result.current.loading).toBe(false);
    expect(result.current.trend).toEqual([]);
    expect(result.current.models).toEqual([]);
  });

  it('refresh() re-runs both queries after a failure', async () => {
    let fail = true;
    const query = vi.fn((sql: string) => {
      if (fail) {
        return Promise.reject(new Error('transient failure'));
      }
      if (sql.includes('date_bin')) {
        return Promise.resolve({ rows: [TREND_RAW_ROW] });
      }
      return Promise.resolve({ rows: [MODEL_RAW_ROW] });
    });
    usePGliteDatabaseMock.mockReturnValue({ query });

    const { result } = renderHook(() => useLedgerAnalytics());

    await waitFor(() => {
      expect(result.current.error).toBeInstanceOf(Error);
    });

    fail = false;
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.trend).toHaveLength(1);
    expect(result.current.models).toHaveLength(1);
  });
});
