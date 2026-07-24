import { describe, expect, it } from 'vitest';
import {
  accumulateSteppedUsage,
  readCacheTokenCount,
  readOpenRouterBilledCost,
  type UsageMeteringState,
} from '../mastra/runtime-assembly/usage-metering';

describe('readCacheTokenCount', () => {
  it('returns positive finite counts', () => {
    expect(readCacheTokenCount(42)).toBe(42);
  });

  it('drops zero, negative, non-finite, and absent values', () => {
    expect(readCacheTokenCount(0)).toBeUndefined();
    expect(readCacheTokenCount(-1)).toBeUndefined();
    expect(readCacheTokenCount(Number.NaN)).toBeUndefined();
    expect(readCacheTokenCount(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(readCacheTokenCount(undefined)).toBeUndefined();
  });
});

describe('readOpenRouterBilledCost', () => {
  it('returns undefined when no provider metadata is present', () => {
    expect(readOpenRouterBilledCost({})).toBeUndefined();
  });

  it('returns undefined when the openrouter namespace or usage/cost is absent', () => {
    expect(readOpenRouterBilledCost({ providerMetadata: {} })).toBeUndefined();
    expect(readOpenRouterBilledCost({ providerMetadata: { openrouter: {} } })).toBeUndefined();
    expect(
      readOpenRouterBilledCost({ providerMetadata: { openrouter: { usage: {} } } })
    ).toBeUndefined();
  });

  it('reads the billed cost from top-level provider metadata', () => {
    expect(
      readOpenRouterBilledCost({ providerMetadata: { openrouter: { usage: { cost: 0.0125 } } } })
    ).toBe(0.0125);
  });

  it('prefers the payload metadata location over the top-level field', () => {
    expect(
      readOpenRouterBilledCost({
        payload: {
          metadata: { providerMetadata: { openrouter: { usage: { cost: 0.5 } } } },
        },
        providerMetadata: { openrouter: { usage: { cost: 9 } } },
      })
    ).toBe(0.5);
  });

  it('THROWS on present-but-malformed metadata instead of silently dropping the cost', () => {
    expect(() => readOpenRouterBilledCost({ providerMetadata: 'nope' })).toThrow(
      'OpenRouter provider metadata must be an object.'
    );
    expect(() => readOpenRouterBilledCost({ providerMetadata: { openrouter: 7 } })).toThrow(
      'OpenRouter provider metadata must be an object.'
    );
    expect(() =>
      readOpenRouterBilledCost({ providerMetadata: { openrouter: { usage: 'x' } } })
    ).toThrow('OpenRouter usage metadata must be an object.');
    for (const cost of ['1', -0.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        readOpenRouterBilledCost({ providerMetadata: { openrouter: { usage: { cost } } } })
      ).toThrow('OpenRouter billed cost must be a finite, non-negative number.');
    }
  });

  it('accepts a zero cost (free-tier steps are billable at zero)', () => {
    expect(
      readOpenRouterBilledCost({ providerMetadata: { openrouter: { usage: { cost: 0 } } } })
    ).toBe(0);
  });
});

describe('accumulateSteppedUsage', () => {
  const freshState = (): UsageMeteringState => ({
    steppedCompletionTokens: 0,
    steppedPromptTokens: 0,
  });

  it('sums prompt and completion tokens across steps and mirrors the prompt sum', () => {
    const state = freshState();
    accumulateSteppedUsage(state, { completionTokens: 5, promptTokens: 100 });
    accumulateSteppedUsage(state, { completionTokens: 7, promptTokens: 200 });
    expect(state.steppedPromptTokens).toBe(300);
    expect(state.steppedCompletionTokens).toBe(12);
    expect(state.providerReportedPromptTokens).toBe(300);
    expect(state.latestStepPromptTokens).toBe(200);
    expect(state.latestStepCompletionTokens).toBe(7);
  });

  it('falls back to inputTokens/outputTokens field names', () => {
    const state = freshState();
    accumulateSteppedUsage(state, { inputTokens: 10, outputTokens: 3 });
    expect(state.steppedPromptTokens).toBe(10);
    expect(state.steppedCompletionTokens).toBe(3);
  });

  it('ignores absent or non-finite prompt usage without touching the reported total', () => {
    const state = freshState();
    accumulateSteppedUsage(state, undefined);
    accumulateSteppedUsage(state, { completionTokens: Number.NaN, promptTokens: Number.NaN });
    expect(state.steppedPromptTokens).toBe(0);
    expect(state.steppedCompletionTokens).toBe(0);
    expect(state.providerReportedPromptTokens).toBeUndefined();
    expect(state.latestStepPromptTokens).toBeUndefined();
    expect(state.latestStepCompletionTokens).toBeUndefined();
  });
});
