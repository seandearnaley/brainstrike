import type { ModelTokenPricing } from '@brainstrike/tokenization';
import { describe, expect, it } from 'vitest';
import type { ModelPricingResolver } from '../../assistant-cross-root-cost';
import {
  DAILY_SPEND_AGGREGATION_SQL,
  type DailySpendUsageRow,
  type HostUsageRecord,
  hostDailySpendRows,
  mapDailySpendUsageRow,
  resolveDailySpendSummary,
} from '../daily-spend';

const PRICING: Record<string, ModelTokenPricing> = {
  'anthropic::claude-sonnet-4-6': {
    cacheReadPerMTok: 0.3,
    cacheWritePerMTok: 3.75,
    inputPerMTok: 3,
    outputPerMTok: 15,
  },
  'openai::gpt-5.2': { inputPerMTok: 2, outputPerMTok: 10 },
};

const resolvePricing: ModelPricingResolver = (provider, model) => PRICING[`${provider}::${model}`];

function makeRow(overrides: Partial<DailySpendUsageRow> = {}): DailySpendUsageRow {
  return {
    model: 'gpt-5.2',
    provider: 'openai',
    unreportedInputTokens: 0,
    unreportedOutputTokens: 0,
    ...overrides,
  };
}

describe('DAILY_SPEND_AGGREGATION_SQL', () => {
  it('binds each parameter exactly once (PGlite live-query format() constraint)', () => {
    // PGlite's live extension rewrites queries through format() and breaks when
    // a bind parameter is repeated — same constraint as RUN_LEDGER_AGGREGATION_SQL.
    const occurrences = DAILY_SPEND_AGGREGATION_SQL.match(/\$\d+/g) ?? [];
    expect(occurrences).toEqual(['$1']);
  });

  it('scopes to the rolling last-24h window, not a calendar day', () => {
    expect(DAILY_SPEND_AGGREGATION_SQL).toContain("NOW() - INTERVAL '24 hours'");
  });
});

describe('resolveDailySpendSummary with Anthropic cache tokens', () => {
  it('prices unreported cache reads/writes at their cache rates, remainder at base input', () => {
    const summary = resolveDailySpendSummary(
      [
        makeRow({
          model: 'claude-sonnet-4-6',
          provider: 'anthropic',
          unreportedCacheCreationTokens: 200_000,
          unreportedCacheReadTokens: 600_000,
          unreportedInputTokens: 1_000_000,
          unreportedOutputTokens: 100_000,
        }),
      ],
      resolvePricing
    );
    // 0.2M*3 + 0.6M*0.3 + 0.2M*3.75 + 0.1M*15 = 3.03
    expect(summary.estimatedUsd).toBeCloseTo(3.03, 10);
    expect(summary.totalUsd).toBeCloseTo(3.03, 10);
    expect(summary.unpricedModels).toEqual([]);
  });

  it('keeps rows without cache tokens on the exact pre-cache math', () => {
    const summary = resolveDailySpendSummary(
      [makeRow({ unreportedInputTokens: 1_000_000, unreportedOutputTokens: 0 })],
      resolvePricing
    );
    expect(summary.estimatedUsd).toBeCloseTo(2, 10);
  });
});

describe('mapDailySpendUsageRow', () => {
  it('parses cache token aggregates', () => {
    const row = mapDailySpendUsageRow({
      billedCostUsd: null,
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      unreportedCacheCreationTokens: '60',
      unreportedCacheReadTokens: '40',
      unreportedInputTokens: '1200',
      unreportedOutputTokens: '300',
    });
    expect(row.unreportedCacheReadTokens).toBe(40);
    expect(row.unreportedCacheCreationTokens).toBe(60);
  });

  it('parses aggregate strings and keeps billedCostUsd absent when unreported', () => {
    const row = mapDailySpendUsageRow({
      billedCostUsd: null,
      model: 'gpt-5.2',
      provider: 'openai',
      unreportedInputTokens: '1200',
      unreportedOutputTokens: '300',
    });
    expect(row).toEqual({
      model: 'gpt-5.2',
      provider: 'openai',
      unreportedCacheCreationTokens: 0,
      unreportedCacheReadTokens: 0,
      unreportedInputTokens: 1200,
      unreportedOutputTokens: 300,
    });
  });

  it('THROWS on malformed aggregates instead of fabricating zeros', () => {
    expect(() =>
      mapDailySpendUsageRow({
        billedCostUsd: 'not-a-number',
        model: 'gpt-5.2',
        provider: 'openai',
        unreportedInputTokens: '0',
        unreportedOutputTokens: '0',
      })
    ).toThrow(/billedCostUsd/);
    expect(() =>
      mapDailySpendUsageRow({
        billedCostUsd: null,
        model: 42,
        provider: 'openai',
        unreportedInputTokens: '0',
        unreportedOutputTokens: '0',
      })
    ).toThrow(/model/);
  });
});

describe('resolveDailySpendSummary', () => {
  it('splits exact provider-reported cost from the registry-priced remainder', () => {
    const summary = resolveDailySpendSummary(
      [
        makeRow({ billedCostUsd: 1.25 }),
        makeRow({ unreportedInputTokens: 1_000_000, unreportedOutputTokens: 100_000 }),
      ],
      resolvePricing
    );
    expect(summary.exactUsd).toBe(1.25);
    expect(summary.estimatedUsd).toBeCloseTo(3, 10);
    expect(summary.totalUsd).toBeCloseTo(4.25, 10);
    expect(summary.unpricedModels).toEqual([]);
  });

  it('EXCLUDES unpriced-model tokens from the total and reports the model explicitly', () => {
    const summary = resolveDailySpendSummary(
      [
        makeRow({ billedCostUsd: 0.5 }),
        makeRow({
          model: 'mystery-local',
          provider: 'ollama',
          unreportedInputTokens: 9_000_000,
          unreportedOutputTokens: 9_000_000,
        }),
      ],
      resolvePricing
    );
    // Never fabricate: the unpriced model contributes $0 to the total AND is
    // named so the UI can render an explicit "+N unpriced" marker.
    expect(summary.exactUsd).toBe(0.5);
    expect(summary.estimatedUsd).toBe(0);
    expect(summary.totalUsd).toBe(0.5);
    expect(summary.unpricedModels).toEqual(['ollama::mystery-local']);
  });

  it('sums a mixed group: exact portion plus priced unreported remainder on one model', () => {
    const summary = resolveDailySpendSummary(
      [
        makeRow({
          billedCostUsd: 2,
          unreportedInputTokens: 500_000,
          unreportedOutputTokens: 0,
        }),
      ],
      resolvePricing
    );
    expect(summary.exactUsd).toBe(2);
    expect(summary.estimatedUsd).toBeCloseTo(1, 10);
    expect(summary.totalUsd).toBeCloseTo(3, 10);
  });

  it('returns an all-zero summary for an empty window', () => {
    expect(resolveDailySpendSummary([], resolvePricing)).toEqual({
      estimatedUsd: 0,
      exactUsd: 0,
      totalUsd: 0,
      unpricedModels: [],
    });
  });
});

describe('hostDailySpendRows', () => {
  const now = Date.parse('2026-10-08T12:00:00Z');
  const record = (overrides: Partial<HostUsageRecord>): HostUsageRecord => ({
    at: now - 60_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    inputTokens: 0,
    model: 'claude-sonnet-4-6',
    outputTokens: 0,
    provider: 'anthropic',
    ...overrides,
  });

  it('groups the host calls inside the last 24h per model, all unreported', () => {
    const rows = hostDailySpendRows(
      [
        record({ cacheReadTokens: 10, inputTokens: 100, outputTokens: 5 }),
        record({ inputTokens: 50, outputTokens: 7 }),
        record({ inputTokens: 900, model: 'gpt-5.2', outputTokens: 9, provider: 'openai' }),
        // Outside the rolling window: a call from 25 hours ago no longer counts.
        record({ at: now - 25 * 60 * 60 * 1000, inputTokens: 1_000_000 }),
      ],
      now
    );
    expect(rows).toEqual([
      {
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
        unreportedCacheCreationTokens: 0,
        unreportedCacheReadTokens: 10,
        unreportedInputTokens: 150,
        unreportedOutputTokens: 12,
      },
      {
        model: 'gpt-5.2',
        provider: 'openai',
        unreportedCacheCreationTokens: 0,
        unreportedCacheReadTokens: 0,
        unreportedInputTokens: 900,
        unreportedOutputTokens: 9,
      },
    ]);
    expect(resolveDailySpendSummary(rows, resolvePricing).estimatedUsd).toBeGreaterThan(0);
  });
});
