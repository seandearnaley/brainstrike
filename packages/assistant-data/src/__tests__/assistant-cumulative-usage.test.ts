// @vitest-environment node
import type { ModelTokenPricing } from '@brainstrike/tokenization';
import { describe, expect, it } from 'vitest';
import { resolveCumulativeUsageDisplay } from '../assistant-cumulative-usage';
import type {
  ThreadCumulativeUsage,
  ThreadModelUsageSubtotal,
} from '../assistant-memory-repository';

const PRICING: Record<string, ModelTokenPricing> = {
  'anthropic:claude-opus-4-8': {
    cacheReadPerMTok: 1.5,
    cacheWritePerMTok: 18.75,
    inputPerMTok: 15,
    outputPerMTok: 120,
  },
  'openai:gpt-5.2': { inputPerMTok: 1.25, outputPerMTok: 10 },
  'openrouter:google/gemini-2.5-flash': { inputPerMTok: 0.3, outputPerMTok: 2.5 },
};

function resolvePricing(provider: string, model: string): ModelTokenPricing | undefined {
  return PRICING[`${provider}:${model}`];
}

/** Fixture helper: zero-cache 'chat' entry with only the interesting fields. */
function entry(
  overrides: Partial<ThreadModelUsageSubtotal> &
    Pick<ThreadModelUsageSubtotal, 'inputTokens' | 'model' | 'outputTokens' | 'provider'>
): ThreadModelUsageSubtotal {
  return {
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    runKind: 'chat',
    ...overrides,
  };
}

describe('resolveCumulativeUsageDisplay', () => {
  it('returns null when there is no durable usage', () => {
    expect(resolveCumulativeUsageDisplay(null, resolvePricing)).toBeNull();
  });

  it('sums tokens and prices each model with its own rate', () => {
    const usage: ThreadCumulativeUsage = {
      perModel: [
        entry({ inputTokens: 1000, model: 'gpt-5.2', outputTokens: 200, provider: 'openai' }),
        entry({
          inputTokens: 500,
          model: 'claude-opus-4-8',
          outputTokens: 100,
          provider: 'anthropic',
        }),
      ],
      totalInputTokens: 1500,
      totalOutputTokens: 300,
    };

    const display = resolveCumulativeUsageDisplay(usage, resolvePricing);
    expect(display?.totalTokens).toBe(1800);
    expect(display?.inputTokens).toBe(1500);
    expect(display?.outputTokens).toBe(300);
    expect(display?.cost.available).toBe(true);
    // openai: (1000*1.25 + 200*10)/1e6 = (1250+2000)/1e6 = 0.00325
    // anthropic: (500*15 + 100*120)/1e6 = (7500+12000)/1e6 = 0.0195
    // total = 0.02275
    if (display?.cost.available) {
      expect(display.cost.usdAmount).toBeCloseTo(0.022_75, 8);
      expect(display.cost.provenance).toBe('captured-usage-estimate');
    }
  });

  it('breaks the thread total down by source, flagging OM rows as estimates', () => {
    const usage: ThreadCumulativeUsage = {
      perModel: [
        entry({ inputTokens: 1000, model: 'gpt-5.2', outputTokens: 200, provider: 'openai' }),
        entry({
          inputTokens: 300,
          model: 'gpt-5.2',
          outputTokens: 40,
          provider: 'openai',
          runKind: 'subagent',
        }),
        entry({
          inputTokens: 24_000,
          model: 'google/gemini-2.5-flash',
          outputTokens: 900,
          provider: 'openrouter',
          runKind: 'om-observation',
        }),
      ],
      totalInputTokens: 25_300,
      totalOutputTokens: 1140,
    };

    const display = resolveCumulativeUsageDisplay(usage, resolvePricing);
    expect(display?.bySource).toEqual([
      { estimated: false, inputTokens: 1000, kind: 'chat', outputTokens: 200 },
      { estimated: false, inputTokens: 300, kind: 'subagent', outputTokens: 40 },
      { estimated: true, inputTokens: 24_000, kind: 'om-observation', outputTokens: 900 },
    ]);
  });

  it('totals cache classes and computes the net caching savings from registry rates', () => {
    const usage: ThreadCumulativeUsage = {
      perModel: [
        entry({
          cacheCreationTokens: 60_000,
          cacheReadTokens: 400_000,
          inputTokens: 500_000,
          model: 'claude-opus-4-8',
          outputTokens: 10_000,
          provider: 'anthropic',
        }),
      ],
      totalInputTokens: 500_000,
      totalOutputTokens: 10_000,
    };

    const display = resolveCumulativeUsageDisplay(usage, resolvePricing);
    expect(display?.cacheReadTokens).toBe(400_000);
    expect(display?.cacheCreationTokens).toBe(60_000);
    // read savings: 400k * (15 - 1.5)/1e6 = 5.4; write premium: 60k * (18.75 - 15)/1e6 = 0.225
    expect(display?.cacheSavings?.usdAmount).toBeCloseTo(5.175, 8);
  });

  it('omits caching savings when a cache-bearing model lacks cache rates (never a guess)', () => {
    const usage: ThreadCumulativeUsage = {
      perModel: [
        entry({
          cacheReadTokens: 1000,
          estimatedCacheReadTokens: 1000,
          inputTokens: 2000,
          model: 'gpt-5.2',
          outputTokens: 100,
          provider: 'openai',
        }),
      ],
      totalInputTokens: 2000,
      totalOutputTokens: 100,
    };

    const display = resolveCumulativeUsageDisplay(usage, resolvePricing);
    expect(display?.cacheReadTokens).toBe(1000);
    expect(display?.cacheSavings).toBeUndefined();
    expect(display?.cost).toEqual({ available: false, reason: 'unpriced_model' });
  });

  it('reports unpriced_model (NOT a partial cost) when any model lacks pricing', () => {
    const usage: ThreadCumulativeUsage = {
      perModel: [
        entry({ inputTokens: 500, model: 'gpt-5.2', outputTokens: 100, provider: 'openai' }),
        // local model has no registry pricing
        entry({ inputTokens: 500, model: 'gemma', outputTokens: 100, provider: 'local' }),
      ],
      totalInputTokens: 1000,
      totalOutputTokens: 200,
    };

    const display = resolveCumulativeUsageDisplay(usage, resolvePricing);
    expect(display?.totalTokens).toBe(1200);
    expect(display?.cost).toEqual({ available: false, reason: 'unpriced_model' });
  });

  it('uses exact provider-reported cost without requiring static pricing', () => {
    const usage: ThreadCumulativeUsage = {
      perModel: [
        entry({
          billedCostUsd: 0.0042,
          estimatedInputTokens: 0,
          estimatedOutputTokens: 0,
          inputTokens: 1000,
          model: 'dynamic-model',
          outputTokens: 200,
          provider: 'openrouter',
        }),
      ],
      totalInputTokens: 1000,
      totalOutputTokens: 200,
    };

    const display = resolveCumulativeUsageDisplay(usage, () => undefined);
    expect(display?.cost).toEqual({
      available: true,
      provenance: 'provider-reported',
      usdAmount: 0.0042,
    });
  });

  it('adds exact cost to the static estimate for legacy unreported runs', () => {
    const usage: ThreadCumulativeUsage = {
      perModel: [
        entry({
          billedCostUsd: 0.004,
          estimatedInputTokens: 1000,
          estimatedOutputTokens: 200,
          inputTokens: 2000,
          model: 'gpt-5.2',
          outputTokens: 400,
          provider: 'openai',
        }),
      ],
      totalInputTokens: 2000,
      totalOutputTokens: 400,
    };

    const display = resolveCumulativeUsageDisplay(usage, resolvePricing);
    expect(display?.cost).toEqual({
      available: true,
      provenance: 'captured-usage-estimate',
      usdAmount: 0.007_25,
    });
  });
});
