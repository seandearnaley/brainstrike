import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunLedgerRow } from '../../assistant-memory-repository';
import { TASK_LEDGER_RUN_LIMIT, useRunLedger } from '../use-run-ledger';

type AgentHostBridge = { connect: (requestId: string) => Promise<void> } | undefined;

function setDesktopAgentHost(bridge: AgentHostBridge): void {
  (window as unknown as { agentHost?: AgentHostBridge }).agentHost = bridge;
}

function makeRow(overrides: Partial<RunLedgerRow> = {}): RunLedgerRow {
  return {
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    completedAt: new Date('2026-07-15T12:00:05.000Z'),
    durationMs: 5000,
    estimatedCacheCreationTokens: 0,
    estimatedCacheReadTokens: 0,
    estimatedCostUsd: 0,
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
    runId: 'run-1',
    startedAt: new Date('2026-07-15T12:00:00.000Z'),
    status: 'completed',
    threadId: 'thread-1',
    toolCallCount: 5,
    ...overrides,
  };
}

describe('useRunLedger', () => {
  it('reads only committed host runs', () => {
    const row = makeRow();
    const { result } = renderHook(() => useRunLedger([row]));
    expect(result.current.available).toBe(true);
    expect(result.current.rows).toEqual([row]);
  });

  beforeEach(() => {
    setDesktopAgentHost({ connect: async () => undefined });
  });

  afterEach(() => {
    setDesktopAgentHost(undefined);
    vi.restoreAllMocks();
  });

  it('is unavailable on web', () => {
    setDesktopAgentHost(undefined);
    const { result } = renderHook(() => useRunLedger());
    expect(result.current.available).toBe(false);
    expect(result.current.rows).toEqual([]);
  });

  it('orders and limits committed host runs without mutating the snapshot', () => {
    const rows = Array.from({ length: TASK_LEDGER_RUN_LIMIT + 5 }, (_, index) =>
      makeRow({ runId: String(index), startedAt: new Date(index * 1000) })
    );
    const { result } = renderHook(() => useRunLedger(rows));
    expect(result.current.rows).toHaveLength(TASK_LEDGER_RUN_LIMIT);
    expect(result.current.rows[0]?.runId).toBe('54');
    expect(rows[0]?.runId).toBe('0');
  });
});
