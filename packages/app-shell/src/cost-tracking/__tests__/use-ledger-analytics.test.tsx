import type { RunLedgerRow } from '@brainstrike/assistant-data';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { usePGliteDatabaseMock } = vi.hoisted(() => ({
  usePGliteDatabaseMock: vi.fn(),
}));

vi.mock('@brainstrike/db', () => ({
  usePGliteDatabase: usePGliteDatabaseMock,
}));
vi.mock('@brainstrike/db/react', () => ({
  usePGliteDatabase: usePGliteDatabaseMock,
}));

import { useLedgerAnalytics } from '../use-ledger-analytics';

type AgentHostBridge = { connect: (requestId: string) => Promise<void> } | undefined;

function setDesktopAgentHost(bridge: AgentHostBridge): void {
  (window as unknown as { agentHost?: AgentHostBridge }).agentHost = bridge;
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
    setDesktopAgentHost({ connect: async () => undefined });
  });

  afterEach(() => {
    setDesktopAgentHost(undefined);
    vi.restoreAllMocks();
  });

  it('is unavailable on WEB and never issues the analytics queries', () => {
    const query = makeQueryMock();
    usePGliteDatabaseMock.mockReturnValue({ query });
    setDesktopAgentHost(undefined);

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

  it("adds the agent host's committed runs to the trend and the model comparison", async () => {
    const query = makeQueryMock();
    usePGliteDatabaseMock.mockReturnValue({ query });
    // The host ledger's runs, as HostThreadLedger folds them: no billed cost, every token estimated.
    const hostRun = (overrides: Partial<RunLedgerRow>): RunLedgerRow => ({
      completedAt: new Date('2026-07-14T09:00:10.000Z'),
      durationMs: 10_000,
      editCount: 0,
      estimatedCacheCreationTokens: 0,
      estimatedCacheReadTokens: 0,
      estimatedInputTokens: 100,
      estimatedOutputTokens: 20,
      failedToolCallCount: 0,
      inputTokens: 100,
      model: 'gpt-5.2',
      outcomeDetail: null,
      outcomeSource: null,
      outcomeVerdict: null,
      outputTokens: 20,
      provider: 'openai',
      revertedEditCount: 0,
      runId: 'host-run-1',
      startedAt: new Date('2026-07-14T09:00:00.000Z'),
      status: 'completed',
      threadId: 'host-thread',
      toolCallCount: 0,
      ...overrides,
    });
    const hostRuns = [
      hostRun({}),
      hostRun({ completedAt: null, durationMs: null, runId: 'host-run-2', status: 'failed' }),
      hostRun({
        model: 'anthropic/claude-sonnet-4.6',
        provider: 'openrouter',
        runId: 'host-run-3',
        startedAt: new Date('2026-07-15T23:59:00.000Z'),
      }),
    ];

    const { result } = renderHook(() => useLedgerAnalytics(undefined, hostRuns));

    // Once the history aggregates load, the host runs join them.
    await waitFor(() => {
      expect(result.current.trend[0]?.billedCostUsd).toBe(0.42);
    });
    // Host runs bucket by the UTC day they started, beside the usage rows' buckets.
    expect(result.current.trend).toEqual([
      {
        billedCostUsd: 0.42,
        bucketStart: new Date('2026-07-14T00:00:00.000Z'),
        estimatedInputTokens: 200,
        estimatedOutputTokens: 40,
        inputTokens: 1200,
        outputTokens: 240,
        runCount: 5,
      },
      {
        bucketStart: new Date('2026-07-15T00:00:00.000Z'),
        estimatedInputTokens: 100,
        estimatedOutputTokens: 20,
        inputTokens: 100,
        outputTokens: 20,
        runCount: 1,
      },
    ]);
    expect(result.current.models).toEqual([
      {
        // History's 2 completed runs at 42 s and the host's 1 at 10 s average 31 333 ms.
        avgDurationMs: 31_333,
        cancelledRunCount: 0,
        completedRunCount: 3,
        estimatedInputTokens: 1700,
        estimatedOutputTokens: 340,
        failedRunCount: 2,
        inputTokens: 1700,
        labeledFailedCount: 1,
        labeledMixedCount: 0,
        labeledSucceededCount: 2,
        model: 'gpt-5.2',
        outputTokens: 340,
        provider: 'openai',
        runCount: 5,
      },
      {
        avgDurationMs: 10_000,
        cancelledRunCount: 0,
        completedRunCount: 1,
        estimatedInputTokens: 100,
        estimatedOutputTokens: 20,
        failedRunCount: 0,
        inputTokens: 100,
        labeledFailedCount: 0,
        labeledMixedCount: 0,
        labeledSucceededCount: 0,
        model: 'anthropic/claude-sonnet-4.6',
        outputTokens: 20,
        provider: 'openrouter',
        runCount: 1,
      },
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
