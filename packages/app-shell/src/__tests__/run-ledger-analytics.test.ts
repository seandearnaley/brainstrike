// @vitest-environment node
import type { RunLedgerRow } from '@brainstrike/assistant-data';
import { describe, expect, it } from 'vitest';
import { hostRunsModelComparison, hostRunsTrend } from '../run-ledger-analytics';

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

  it('sums tokens per day, oldest first, and claims no billed cost', () => {
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
        day: '2026-10-12',
        estimatedInputTokens: 200,
        estimatedOutputTokens: 40,
        inputTokens: 400,
        label: 'Oct 12',
        outputTokens: 40,
        runCount: 2,
      },
      {
        day: '2026-10-14',
        estimatedInputTokens: 100,
        estimatedOutputTokens: 20,
        inputTokens: 100,
        label: 'Oct 14',
        outputTokens: 20,
        runCount: 1,
      },
    ]);
  });
});

describe('the Task Ledger model comparison', () => {
  it('folds host runs per provider and model, with their labels and completed-run mean', () => {
    const models = hostRunsModelComparison([
      hostRun({ outcomeVerdict: 'failed', runId: 'reverted' }),
      hostRun({ durationMs: 30_000, outcomeVerdict: 'succeeded', runId: 'kept' }),
      hostRun({ completedAt: null, durationMs: null, runId: 'broke', status: 'failed' }),
      hostRun({ model: 'gpt-5.2', provider: 'openai', runId: 'other' }),
    ]);
    expect(models.map(({ model, provider }) => [provider, model])).toEqual([
      ['openai', 'gpt-5.2'],
      ['openrouter', 'anthropic/claude-sonnet-4.6'],
    ]);
    expect(models[1]).toEqual({
      avgDurationMs: 20_000,
      cancelledRunCount: 0,
      completedRunCount: 2,
      estimatedInputTokens: 300,
      estimatedOutputTokens: 60,
      failedRunCount: 1,
      inputTokens: 300,
      labeledFailedCount: 1,
      labeledMixedCount: 0,
      labeledSucceededCount: 1,
      model: 'anthropic/claude-sonnet-4.6',
      outputTokens: 60,
      provider: 'openrouter',
      runCount: 3,
    });
  });
});
