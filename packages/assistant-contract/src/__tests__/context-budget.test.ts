import { describe, expect, it } from 'vitest';
import {
  CONTEXT_BUDGET_DEFAULT_MAX_OUTPUT_TOKENS,
  CONTEXT_BUDGET_SAFETY_MARGIN_MIN,
  CONTEXT_BUDGET_SAFETY_MARGIN_RATIO,
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
