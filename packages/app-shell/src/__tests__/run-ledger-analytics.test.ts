import type { RunLedgerRow } from '@brainstrike/assistant-data';
import { describe, expect, it } from 'vitest';
import { hostRunsModelComparison, hostRunsTotals, hostRunsTrend } from '../run-ledger-analytics';

function hostRun(overrides: Partial<RunLedgerRow> & { readonly runId: string }): RunLedgerRow {
  return {
    completedAt: new Date('2026-10-12T14:00:10.000Z'),
    durationMs: 10_000,
    editCount: 0,
    estimatedCacheCreationTokens: 0,
    estimatedCacheReadTokens: 0,
    estimatedCostUsd: 0.0006,
    estimatedInputTokens: 100,
    estimatedOutputTokens: 20,
    failedToolCallCount: 0,
    inputTokens: 100,
    model: 'anthropic/claude-sonnet-4.6',
    outcomeDetail: null,
    outcomeSource: null,
    outcomeVerdict: null,
    outputTokens: 20,
    provider: 'openrouter',
    revertedEditCount: 0,
    startedAt: new Date('2026-10-12T14:00:00.000Z'),
    status: 'completed',
    threadId: 'host-thread',
    toolCallCount: 0,
    ...overrides,
  };
}

const days = (trend: ReturnType<typeof hostRunsTrend>) =>
  trend.map(({ day, label, runCount }) => ({ day, label, runCount }));

describe('the Task Ledger daily trend', () => {
  it('counts each run on the local day it started in the given zone', () => {
    const runs = [
      // 10:00 and 22:00 on Oct 12 in New York; the second is already Oct 13 in UTC.
      hostRun({ runId: 'morning', startedAt: new Date('2026-10-12T14:00:00.000Z') }),
      hostRun({ runId: 'evening', startedAt: new Date('2026-10-13T02:00:00.000Z') }),
    ];
    expect(days(hostRunsTrend(runs, 'America/New_York'))).toEqual([
      { day: '2026-10-12', label: 'Oct 12', runCount: 2 },
    ]);
    // A UTC day bucket splits them, and its Oct 12 bucket is the evening of Oct 11 in New York.
    expect(days(hostRunsTrend(runs, 'UTC'))).toEqual([
      { day: '2026-10-12', label: 'Oct 12', runCount: 1 },
      { day: '2026-10-13', label: 'Oct 13', runCount: 1 },
    ]);
    // Auckland (UTC+13 in October) has both on its Oct 13.
    expect(days(hostRunsTrend(runs, 'Pacific/Auckland'))).toEqual([
      { day: '2026-10-13', label: 'Oct 13', runCount: 2 },
    ]);
  });

  it('keeps a half-hour zone on its own local midnight', () => {
    // 18:45 UTC is 00:15 the next day in Kolkata (UTC+5:30), 23:45 in UTC itself.
    const runs = [hostRun({ runId: 'late', startedAt: new Date('2026-10-12T18:45:00.000Z') })];
    expect(days(hostRunsTrend(runs, 'Asia/Kolkata'))).toEqual([
      { day: '2026-10-13', label: 'Oct 13', runCount: 1 },
    ]);
    expect(days(hostRunsTrend(runs, 'UTC'))).toEqual([
      { day: '2026-10-12', label: 'Oct 12', runCount: 1 },
    ]);
  });

  it('sums tokens and cost per day, oldest first', () => {
    const trend = hostRunsTrend(
      [
        hostRun({ runId: 'later', startedAt: new Date('2026-10-14T12:00:00.000Z') }),
        hostRun({
          inputTokens: 300,
          runId: 'first',
          startedAt: new Date('2026-10-12T12:00:00.000Z'),
        }),
        hostRun({ runId: 'second', startedAt: new Date('2026-10-12T13:00:00.000Z') }),
      ],
      'UTC'
    );
    expect(trend).toEqual([
      {
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: expect.closeTo(0.0012, 10),
        day: '2026-10-12',
        inputTokens: 400,
        label: 'Oct 12',
        outputTokens: 40,
        runCount: 2,
        unpricedRunCount: 0,
      },
      {
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: expect.closeTo(0.0006, 10),
        day: '2026-10-14',
        inputTokens: 100,
        label: 'Oct 14',
        outputTokens: 20,
        runCount: 1,
        unpricedRunCount: 0,
      },
    ]);
  });
});

describe('the Task Ledger model comparison', () => {
  it('folds host runs per provider and model, costliest first, with their completed-run mean', () => {
    const models = hostRunsModelComparison([
      hostRun({ outcomeVerdict: 'failed', runId: 'reverted' }),
      hostRun({ durationMs: 30_000, outcomeVerdict: 'succeeded', runId: 'kept' }),
      hostRun({ completedAt: null, durationMs: null, runId: 'broke', status: 'failed' }),
      hostRun({ model: 'gpt-5.2', provider: 'openai', runId: 'other' }),
    ]);
    expect(models.map(({ model, provider }) => [provider, model])).toEqual([
      ['openrouter', 'anthropic/claude-sonnet-4.6'],
      ['openai', 'gpt-5.2'],
    ]);
    expect(models[0]).toEqual({
      avgDurationMs: 20_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cancelledRunCount: 0,
      completedRunCount: 2,
      costUsd: expect.closeTo(0.0018, 10),
      failedRunCount: 1,
      inputTokens: 300,
      labeledFailedCount: 1,
      labeledMixedCount: 0,
      labeledSucceededCount: 1,
      model: 'anthropic/claude-sonnet-4.6',
      outputTokens: 60,
      provider: 'openrouter',
      runCount: 3,
      unpricedRunCount: 0,
    });
  });
});

describe('the Task Ledger totals', () => {
  it('sums cost and cache tokens, and counts the runs it could not price', () => {
    const totals = hostRunsTotals([
      hostRun({ estimatedCacheReadTokens: 80, runId: 'cached' }),
      hostRun({ billedCostUsd: 0.01, runId: 'billed' }),
      hostRun({ estimatedCostUsd: null, model: 'vendor/uncatalogued', runId: 'unpriced' }),
    ]);
    expect(totals).toEqual({
      cacheReadTokens: 80,
      cacheWriteTokens: 0,
      costUsd: expect.closeTo(0.0112, 10),
      inputTokens: 300,
      outputTokens: 60,
      runCount: 3,
      unpricedRunCount: 1,
    });
  });
});
