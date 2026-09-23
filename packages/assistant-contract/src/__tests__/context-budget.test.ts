import { describe, expect, it } from 'vitest';
import {
  CONTEXT_BUDGET_DEFAULT_MAX_OUTPUT_TOKENS,
  CONTEXT_BUDGET_SAFETY_MARGIN_MIN,
  CONTEXT_BUDGET_SAFETY_MARGIN_RATIO,
  deriveAgentLoopInputTokenLimit,
  deriveEffectiveInputBudget,
} from '../context-budget.js';

describe('deriveEffectiveInputBudget', () => {
  it('subtracts maxOutputTokens and the safety margin from the window', () => {
    // 200k window, 64k output, margin = max(1024, 5% of 200k = 10k) = 10k
    expect(deriveEffectiveInputBudget(200_000, 64_000)).toBe(126_000);
  });

  it('defaults maxOutputTokens to 4096 when not provided', () => {
    // 32_768 window: margin = max(1024, ceil(1638.4) = 1639)
    expect(deriveEffectiveInputBudget(32_768)).toBe(32_768 - 4096 - 1639);
  });

  it('enforces the 1024-token minimum margin on small windows', () => {
    // 8k window: 5% = 410 < 1024 → margin 1024
    expect(deriveEffectiveInputBudget(8192, 1024)).toBe(8192 - 1024 - 1024);
  });

  it('throws when the window cannot fit output + margin (no silent floor)', () => {
    expect(() => deriveEffectiveInputBudget(4096, 4096)).toThrow(/cannot fit/);
  });

  it('throws on non-finite or non-positive maxOutputTokens (no NaN budgets)', () => {
    expect(() => deriveEffectiveInputBudget(32_768, Number.NaN)).toThrow(/maxOutputTokens/);
    expect(() => deriveEffectiveInputBudget(32_768, Number.POSITIVE_INFINITY)).toThrow(
      /maxOutputTokens/
    );
    expect(() => deriveEffectiveInputBudget(32_768, -1)).toThrow(/maxOutputTokens/);
  });

  it('throws on non-positive windows', () => {
    expect(() => deriveEffectiveInputBudget(0)).toThrow(/positive/);
  });

  it('exposes the constants used by the derivation', () => {
    expect(CONTEXT_BUDGET_DEFAULT_MAX_OUTPUT_TOKENS).toBe(4096);
    expect(CONTEXT_BUDGET_SAFETY_MARGIN_MIN).toBe(1024);
    expect(CONTEXT_BUDGET_SAFETY_MARGIN_RATIO).toBe(0.05);
  });
});

describe('deriveAgentLoopInputTokenLimit', () => {
  const model = { contextWindow: 400_000, maxOutputTokens: 128_000 };

  it('reserves a direct provider model its catalog maximum output', () => {
    expect(deriveAgentLoopInputTokenLimit(model, 'anthropic', undefined)).toBe(
      deriveEffectiveInputBudget(400_000, 128_000)
    );
  });

  it('ignores a configured output limit for a direct provider (reserves the maximum)', () => {
    expect(deriveAgentLoopInputTokenLimit(model, 'openai', 8192)).toBe(
      deriveEffectiveInputBudget(400_000, 128_000)
    );
  });

  it('reserves the configured output limit for OpenRouter', () => {
    expect(deriveAgentLoopInputTokenLimit(model, 'openrouter', 8192)).toBe(371_808);
  });

  it('reserves the OpenRouter coding default when no output limit is configured', () => {
    // min(128,000, 32,000) = 32,000; margin 20,000.
    expect(deriveAgentLoopInputTokenLimit(model, 'openrouter', undefined)).toBe(348_000);
  });

  it('throws rather than clamping when the window cannot fit the reservation', () => {
    expect(() =>
      deriveAgentLoopInputTokenLimit(
        { contextWindow: 524_288, maxOutputTokens: 512_000 },
        'anthropic',
        undefined
      )
    ).toThrow(/cannot fit/);
  });
});
