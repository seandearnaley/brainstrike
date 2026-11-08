import { describe, expect, it } from 'vitest';
import { type HostUsageRecord, resolveHostDailySpend } from '../daily-spend';

describe('resolveHostDailySpend', () => {
  const now = Date.parse('2026-10-08T12:00:00Z');
  const record = (overrides: Partial<HostUsageRecord>): HostUsageRecord => ({
    at: now - 60_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    inputTokens: 0,
    model: 'claude-sonnet-4-6',
    outputTokens: 0,
    provider: 'anthropic',
    ...overrides,
  });

  it('sums the host calls inside the last 24h', () => {
    expect(
      resolveHostDailySpend(
        [
          record({ costUsd: 0.25, inputTokens: 100 }),
          record({ costUsd: 0.5, model: 'gpt-5.2', provider: 'openai' }),
          // Outside the rolling window: a call from 25 hours ago no longer counts.
          record({ at: now - 25 * 60 * 60 * 1000, costUsd: 9 }),
        ],
        now
      )
    ).toEqual({ estimatedUsd: 0.75, exactUsd: 0, totalUsd: 0.75, unpricedModels: [] });
  });

  it('counts what the provider billed as exact, even for a model with no list price', () => {
    expect(
      resolveHostDailySpend(
        [
          record({ costUsd: 0.25 }),
          record({ billedCostUsd: 0.5, costUsd: null, model: 'mystery', provider: 'openrouter' }),
        ],
        now
      )
    ).toEqual({ estimatedUsd: 0.25, exactUsd: 0.5, totalUsd: 0.75, unpricedModels: [] });
  });

  it('excludes an unpriced model from the total and names it once', () => {
    expect(
      resolveHostDailySpend(
        [
          record({ costUsd: 0.25 }),
          record({ costUsd: null, model: 'mystery', provider: 'openrouter' }),
          record({ costUsd: null, model: 'mystery', provider: 'openrouter' }),
        ],
        now
      )
    ).toEqual({
      estimatedUsd: 0.25,
      exactUsd: 0,
      totalUsd: 0.25,
      unpricedModels: ['openrouter::mystery'],
    });
  });

  it('is an honest zero with no calls', () => {
    expect(resolveHostDailySpend([], now)).toEqual({
      estimatedUsd: 0,
      exactUsd: 0,
      totalUsd: 0,
      unpricedModels: [],
    });
  });
});
