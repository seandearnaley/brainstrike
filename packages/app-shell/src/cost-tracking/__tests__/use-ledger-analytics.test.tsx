import type { RunLedgerRow } from '@brainstrike/assistant-data';
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useLedgerAnalytics } from '../use-ledger-analytics';

function hostRun(overrides: Partial<RunLedgerRow> & { readonly runId: string }): RunLedgerRow {
  return {
    completedAt: new Date('2026-10-12T14:00:10.000Z'),
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
    startedAt: new Date('2026-10-12T14:00:00.000Z'),
    status: 'completed',
    threadId: 'host-thread',
    toolCallCount: 0,
    ...overrides,
  };
}

/** Makes the runtime's resolved zone `timeZone`, as the user's system setting would. */
function resolveZone(timeZone: string): void {
  const resolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (
    this: Intl.DateTimeFormat
  ) {
    return { ...resolvedOptions.call(this), timeZone };
  });
}

const runs = [
  // 10:00 and 22:00 on Oct 12 in New York; the second is Oct 13 in UTC.
  hostRun({ runId: 'morning', startedAt: new Date('2026-10-12T14:00:00.000Z') }),
  hostRun({ runId: 'evening', startedAt: new Date('2026-10-13T02:00:00.000Z') }),
];

describe('useLedgerAnalytics', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("buckets the host's runs by the user's resolved local day", () => {
    resolveZone('America/New_York');
    const { result } = renderHook(() => useLedgerAnalytics(runs));
    expect(result.current.trend.map(({ day, label, runCount }) => [day, label, runCount])).toEqual([
      ['2026-10-12', 'Oct 12', 2],
    ]);
  });

  it('follows another zone without a constant standing in for it', () => {
    resolveZone('Asia/Tokyo');
    const { result } = renderHook(() => useLedgerAnalytics(runs));
    // 23:00 Oct 12 and 11:00 Oct 13 in Tokyo.
    expect(result.current.trend.map(({ day, runCount }) => [day, runCount])).toEqual([
      ['2026-10-12', 1],
      ['2026-10-13', 1],
    ]);
  });

  it('compares models from the same runs', () => {
    const { result } = renderHook(() => useLedgerAnalytics(runs));
    expect(result.current.models).toMatchObject([
      { completedRunCount: 2, model: 'gpt-5.2', provider: 'openai', runCount: 2 },
    ]);
  });
});
