import { describe, expect, it } from 'vitest';
import { resolveCumulativeUsageDisplay } from '../assistant-cumulative-usage';
import type { ThreadCumulativeUsage } from '../assistant-memory-repository';

const PRICING: Record<string, { inputPerMTok: number; outputPerMTok: number }> = {
  'openai:gpt-5.2': { inputPerMTok: 1.25, outputPerMTok: 10 },
  'anthropic:claude-opus-4-8': { inputPerMTok: 15, outputPerMTok: 120 },
};

function resolvePricing(provider: string, model: string) {
  return PRICING[`${provider}:${model}`];
}

describe('resolveCumulativeUsageDisplay', () => {
  it('returns null when there is no durable usage', () => {
    expect(resolveCumulativeUsageDisplay(null, resolvePricing)).toBeNull();
  });

  it('sums tokens and prices each model with its own rate', () => {
    const usage: ThreadCumulativeUsage = {
      totalInputTokens: 1500,
      totalOutputTokens: 300,
      perModel: [
        {
          provider: 'openai',
          model: 'gpt-5.2',
          inputTokens: 1000,
          outputTokens: 200,
        },
        {
          provider: 'anthropic',
          model: 'claude-opus-4-8',
          inputTokens: 500,
          outputTokens: 100,
        },
      ],
    };

    const display = resolveCumulativeUsageDisplay(usage, resolvePricing);
    expect(display?.totalTokens).toBe(1800);
    expect(display?.cost.available).toBe(true);
    // openai: (1000*1.25 + 200*10)/1e6 = (1250+2000)/1e6 = 0.00325
    // anthropic: (500*15 + 100*120)/1e6 = (7500+12000)/1e6 = 0.0195
    // total = 0.02275
    if (display?.cost.available) {
      expect(display.cost.usdAmount).toBeCloseTo(0.022_75, 8);
      expect(display.cost.provenance).toBe('exact-pricing');
    }
  });

  it('reports unpriced_model (NOT a partial cost) when any model lacks pricing', () => {
    const usage: ThreadCumulativeUsage = {
      totalInputTokens: 1000,
      totalOutputTokens: 200,
      perModel: [
        { provider: 'openai', model: 'gpt-5.2', inputTokens: 500, outputTokens: 100 },
        // local model has no registry pricing
        { provider: 'local', model: 'gemma', inputTokens: 500, outputTokens: 100 },
      ],
    };

    const display = resolveCumulativeUsageDisplay(usage, resolvePricing);
    expect(display?.totalTokens).toBe(1200);
    expect(display?.cost).toEqual({ available: false, reason: 'unpriced_model' });
  });
});
