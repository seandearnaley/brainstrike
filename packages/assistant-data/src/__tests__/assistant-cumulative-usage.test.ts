// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { resolveCumulativeUsageDisplay } from '../assistant-cumulative-usage';
import type {
  ThreadCumulativeUsage,
  ThreadModelUsageSubtotal,
} from '../assistant-memory-repository';

/** Fixture helper: zero-cache 'chat' entry with only the interesting fields. */
function entry(
  overrides: Partial<ThreadModelUsageSubtotal> &
    Pick<
      ThreadModelUsageSubtotal,
      'estimatedCostUsd' | 'inputTokens' | 'model' | 'outputTokens' | 'provider'
    >
): ThreadModelUsageSubtotal {
  return {
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    runKind: 'chat',
    ...overrides,
  };
}

function usageOf(...perModel: ThreadModelUsageSubtotal[]): ThreadCumulativeUsage {
  return {
    perModel,
    totalInputTokens: perModel.reduce((total, row) => total + row.inputTokens, 0),
    totalOutputTokens: perModel.reduce((total, row) => total + row.outputTokens, 0),
  };
}

describe('resolveCumulativeUsageDisplay', () => {
  it('returns null when there is no durable usage', () => {
    expect(resolveCumulativeUsageDisplay(null)).toBeNull();
  });

  it('sums tokens and each model’s call-by-call cost', () => {
    const display = resolveCumulativeUsageDisplay(
      usageOf(
        entry({
          estimatedCostUsd: 0.003_25,
          inputTokens: 1000,
          model: 'gpt-5.2',
          outputTokens: 200,
          provider: 'openai',
        }),
        entry({
          estimatedCostUsd: 0.0195,
          inputTokens: 500,
          model: 'claude-opus-4-8',
          outputTokens: 100,
          provider: 'anthropic',
        })
      )
    );
    expect(display?.totalTokens).toBe(1800);
    expect(display?.inputTokens).toBe(1500);
    expect(display?.outputTokens).toBe(300);
    expect(display?.cost).toEqual({
      available: true,
      provenance: 'captured-usage-estimate',
      usdAmount: 0.022_75,
    });
  });

  it('breaks the thread total down by source, flagging OM rows as estimates', () => {
    const display = resolveCumulativeUsageDisplay(
      usageOf(
        entry({
          estimatedCostUsd: 0,
          inputTokens: 1000,
          model: 'gpt-5.2',
          outputTokens: 200,
          provider: 'openai',
        }),
        entry({
          estimatedCostUsd: 0,
          inputTokens: 300,
          model: 'gpt-5.2',
          outputTokens: 40,
          provider: 'openai',
          runKind: 'subagent',
        }),
        entry({
          estimatedCostUsd: 0,
          inputTokens: 24_000,
          model: 'google/gemini-2.5-flash',
          outputTokens: 900,
          provider: 'openrouter',
          runKind: 'om-observation',
        })
      )
    );
    expect(display?.bySource).toMatchObject([
      { estimated: false, inputTokens: 1000, kind: 'chat', outputTokens: 200 },
      { estimated: false, inputTokens: 300, kind: 'subagent', outputTokens: 40 },
      { estimated: true, inputTokens: 24_000, kind: 'om-observation', outputTokens: 900 },
    ]);
  });

  it('prices each source and its models, costliest model first, unpriced last', () => {
    const display = resolveCumulativeUsageDisplay(
      usageOf(
        entry({
          estimatedCostUsd: 0.2,
          inputTokens: 10,
          model: 'gpt-5.2',
          outputTokens: 1,
          provider: 'openai',
        }),
        entry({
          estimatedCostUsd: null,
          inputTokens: 10,
          model: 'vendor/x',
          outputTokens: 1,
          provider: 'openrouter',
        }),
        entry({
          estimatedCostUsd: 1,
          inputTokens: 10,
          model: 'claude-opus-4-8',
          outputTokens: 1,
          provider: 'anthropic',
        }),
        entry({
          estimatedCostUsd: 0.3,
          inputTokens: 10,
          model: 'gpt-5.2',
          outputTokens: 1,
          provider: 'openai',
        }),
        entry({
          billedCostUsd: 0.05,
          estimatedCostUsd: null,
          estimatedInputTokens: 0,
          estimatedOutputTokens: 0,
          inputTokens: 10,
          model: 'gpt-5.2',
          outputTokens: 1,
          provider: 'openai',
          runKind: 'subagent',
        })
      )
    );
    const [chat, subagent] = display?.bySource ?? [];
    // One unpriced model leaves its source's cost unknown, never a partial sum.
    expect(chat?.costUsd).toBeNull();
    expect(chat?.models.map(({ costUsd, model }) => [model, costUsd])).toEqual([
      ['claude-opus-4-8', 1],
      ['gpt-5.2', expect.closeTo(0.5, 10)],
      ['vendor/x', null],
    ]);
    // A provider-reported cost needs no list price.
    expect(subagent?.costUsd).toBeCloseTo(0.05, 10);
  });

  it('totals cache classes and the savings each model’s calls recorded', () => {
    const display = resolveCumulativeUsageDisplay(
      usageOf(
        entry({
          cacheCreationTokens: 60_000,
          cacheReadTokens: 400_000,
          cacheSavingsUsd: 5.175,
          estimatedCostUsd: 3.6,
          inputTokens: 500_000,
          model: 'claude-opus-4-8',
          outputTokens: 10_000,
          provider: 'anthropic',
        }),
        entry({
          cacheReadTokens: 1000,
          cacheSavingsUsd: 0.001,
          estimatedCostUsd: 0.01,
          inputTokens: 2000,
          model: 'gpt-5.2',
          outputTokens: 100,
          provider: 'openai',
        })
      )
    );
    expect(display?.cacheReadTokens).toBe(401_000);
    expect(display?.cacheCreationTokens).toBe(60_000);
    expect(display?.cacheSavings?.usdAmount).toBeCloseTo(5.176, 12);
  });

  it('omits caching savings and cost when a cache-bearing call is unpriced (never a guess)', () => {
    const display = resolveCumulativeUsageDisplay(
      usageOf(
        entry({
          cacheReadTokens: 1000,
          cacheSavingsUsd: null,
          estimatedCacheReadTokens: 1000,
          estimatedCostUsd: null,
          inputTokens: 2000,
          model: 'gpt-5.2',
          outputTokens: 100,
          provider: 'openai',
        })
      )
    );
    expect(display?.cacheReadTokens).toBe(1000);
    expect(display?.cacheSavings).toBeUndefined();
    expect(display?.cost).toEqual({ available: false, reason: 'unpriced_model' });
  });

  it('reports unpriced_model (NOT a partial cost) when any model lacks pricing', () => {
    const display = resolveCumulativeUsageDisplay(
      usageOf(
        entry({
          estimatedCostUsd: 0.001,
          inputTokens: 500,
          model: 'gpt-5.2',
          outputTokens: 100,
          provider: 'openai',
        }),
        entry({
          estimatedCostUsd: null,
          inputTokens: 500,
          model: 'some-vendor/unregistered-model',
          outputTokens: 100,
          provider: 'openrouter',
        })
      )
    );
    expect(display?.totalTokens).toBe(1200);
    expect(display?.cost).toEqual({ available: false, reason: 'unpriced_model' });
  });

  it('uses exact provider-reported cost without requiring static pricing', () => {
    const display = resolveCumulativeUsageDisplay(
      usageOf(
        entry({
          billedCostUsd: 0.0042,
          estimatedCostUsd: null,
          estimatedInputTokens: 0,
          estimatedOutputTokens: 0,
          inputTokens: 1000,
          model: 'dynamic-model',
          outputTokens: 200,
          provider: 'openrouter',
        })
      )
    );
    expect(display?.cost).toEqual({
      available: true,
      provenance: 'provider-reported',
      usdAmount: 0.0042,
    });
  });

  it('adds exact cost to the estimate of the unreported calls', () => {
    const display = resolveCumulativeUsageDisplay(
      usageOf(
        entry({
          billedCostUsd: 0.004,
          estimatedCostUsd: 0.003_25,
          estimatedInputTokens: 1000,
          estimatedOutputTokens: 200,
          inputTokens: 2000,
          model: 'gpt-5.2',
          outputTokens: 400,
          provider: 'openai',
        })
      )
    );
    expect(display?.cost).toEqual({
      available: true,
      provenance: 'captured-usage-estimate',
      usdAmount: 0.007_25,
    });
  });
});
