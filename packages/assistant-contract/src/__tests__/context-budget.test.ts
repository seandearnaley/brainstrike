import { Result, Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  CONTEXT_BUDGET_DEFAULT_MAX_OUTPUT_TOKENS,
  CONTEXT_BUDGET_SAFETY_MARGIN_MIN,
  CONTEXT_BUDGET_SAFETY_MARGIN_RATIO,
  CONTEXT_COMPACTION_DEFAULT_TOKEN_CAP,
  ContextCompactionTokenCapSchema,
  deriveAgentLoopInputTokenLimit,
  deriveContextCompactionThreshold,
  deriveEffectiveInputBudget,
  deriveMaxOutputTokensWithinBudget,
  resolveContextCompactionTokenCap,
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
    expect(() => deriveEffectiveInputBudget(4096, 4096)).toThrow(/cannot fit/u);
  });

  it('throws on non-finite or non-positive maxOutputTokens (no NaN budgets)', () => {
    expect(() => deriveEffectiveInputBudget(32_768, Number.NaN)).toThrow(/maxOutputTokens/u);
    expect(() => deriveEffectiveInputBudget(32_768, Number.POSITIVE_INFINITY)).toThrow(
      /maxOutputTokens/u
    );
    expect(() => deriveEffectiveInputBudget(32_768, -1)).toThrow(/maxOutputTokens/u);
  });

  it('throws on non-positive windows', () => {
    expect(() => deriveEffectiveInputBudget(0)).toThrow(/positive/u);
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

  // BST-1804 review: a default here would be a SECOND derivation of the
  // OpenRouter output window — the request path sizes it for the run's
  // reasoning state (kimi-k3: 131,072), a default could not. The caller must
  // pass the output limit the request actually sends.
  it('has no OpenRouter default: throws when the request output limit is not supplied', () => {
    expect(() => deriveAgentLoopInputTokenLimit(model, 'openrouter', undefined)).toThrow(
      /output limit the request sends/u
    );
  });

  it('rejects a malformed OpenRouter request output limit loudly (never a plausible budget)', () => {
    for (const invalid of [0, -1, 1.5, Number.NaN, null as unknown as number]) {
      expect(() => deriveAgentLoopInputTokenLimit(model, 'openrouter', invalid)).toThrow(
        /output limit the request sends/u
      );
    }
  });

  it('throws rather than clamping when the window cannot fit the reservation', () => {
    expect(() =>
      deriveAgentLoopInputTokenLimit(
        { contextWindow: 524_288, maxOutputTokens: 512_000 },
        'anthropic',
        undefined
      )
    ).toThrow(/cannot fit/u);
  });
});

describe('deriveMaxOutputTokensWithinBudget (BST-1810)', () => {
  it.each([
    // MiniMax M3: 524,288 − margin 26,215 − 1.
    [524_288, 498_072],
    // Kimi K3: 1,048,576 − margin 52,429 − 1.
    [1_048_576, 996_146],
    // A small window keeps the 1,024 floor margin.
    [8192, 7167],
  ])('is the largest output a %i-token window can budget', (contextWindow, maximum) => {
    expect(deriveMaxOutputTokensWithinBudget(contextWindow)).toBe(maximum);
    expect(deriveEffectiveInputBudget(contextWindow, maximum)).toBe(1);
    expect(() => deriveEffectiveInputBudget(contextWindow, maximum + 1)).toThrow(/cannot fit/u);
  });

  it('throws for a window that cannot fit any output', () => {
    expect(() => deriveMaxOutputTokensWithinBudget(1025)).toThrow(/cannot fit any output/u);
    expect(() => deriveMaxOutputTokensWithinBudget(0)).toThrow(/positive number/u);
  });
});

describe('deriveContextCompactionThreshold (BST-2526)', () => {
  it('triggers at 90% of a budget below the cap and reclaims toward 70% of it', () => {
    // A 200K window's budget: 185,904.
    const threshold = deriveContextCompactionThreshold(
      deriveEffectiveInputBudget(200_000),
      CONTEXT_COMPACTION_DEFAULT_TOKEN_CAP
    );
    expect(threshold.trigger).toBeCloseTo(167_313.6, 6);
    expect(threshold.target).toBeCloseTo(130_132.8, 6);
  });

  it('triggers at the cap on a budget whose 90% passes it, and reclaims toward 7/9 of the cap', () => {
    // A 1M window's budget: 945,904.
    const threshold = deriveContextCompactionThreshold(
      deriveEffectiveInputBudget(1_000_000),
      CONTEXT_COMPACTION_DEFAULT_TOKEN_CAP
    );
    expect(CONTEXT_COMPACTION_DEFAULT_TOKEN_CAP).toBe(200_000);
    expect(threshold.trigger).toBe(200_000);
    expect(threshold.target).toBeCloseTo(155_555.56, 2);
  });

  it('is bounded by the budget alone when the run carries no cap', () => {
    const threshold = deriveContextCompactionThreshold(945_904, undefined);
    expect(threshold.trigger).toBeCloseTo(851_313.6, 6);
    expect(threshold.target).toBeCloseTo(662_132.8, 6);
  });

  it('refuses a budget or cap that is not a positive number (never a nonsense threshold)', () => {
    for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => deriveContextCompactionThreshold(invalid, 200_000)).toThrow(/inputTokenLimit/u);
      expect(() => deriveContextCompactionThreshold(185_904, invalid)).toThrow(/tokenCap/u);
    }
  });
});

describe('the compaction cap setting (BST-2539)', () => {
  const refuses = (cap: unknown) =>
    Result.isFailure(Schema.decodeUnknownResult(ContextCompactionTokenCapSchema)(cap));
  const accepts = (cap: unknown) => Schema.decodeUnknownSync(ContextCompactionTokenCapSchema)(cap);

  it('refuses a cap below 64,000 tokens and accepts 64,000', () => {
    expect(refuses(63_999)).toBe(true);
    expect(accepts(64_000)).toBe(64_000);
  });

  it('has no upper bound and refuses a fraction', () => {
    expect(accepts(5_000_000)).toBe(5_000_000);
    expect(refuses(100_000.5)).toBe(true);
  });

  it('is 200,000 tokens until a person sets it', () => {
    expect(resolveContextCompactionTokenCap(undefined)).toBe(200_000);
    expect(resolveContextCompactionTokenCap(100_000)).toBe(100_000);
  });
});
