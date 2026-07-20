import { describe, expect, it } from 'vitest';
import { computeCost, formatUsdCost } from '../token-counting-heuristics';

describe('computeCost with Anthropic cache tokens', () => {
  it('prices cache reads and writes at their own rates, remainder at the base input rate', () => {
    // inputTokens is the TOTAL the model saw (incl. cache classes):
    // uncached = 1M - 600k - 200k = 200k @ $3; read 600k @ $0.30; write 200k @ $3.75.
    const result = computeCost(
      {
        cacheCreationInputTokens: 200_000,
        cacheReadInputTokens: 600_000,
        inputTokens: 1_000_000,
        outputTokens: 100_000,
      },
      { cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75, inputPerMTok: 3, outputPerMTok: 15 }
    );
    expect(result).toEqual({
      available: true,
      provenance: 'exact-pricing',
      // 0.2M*3 + 0.6M*0.3 + 0.2M*3.75 + 0.1M*15 = 0.6 + 0.18 + 0.75 + 1.5
      usdAmount: 3.03,
    });
  });

  it('throws when cache tokens are reported but the pricing has no cache rates', () => {
    expect(() =>
      computeCost(
        { cacheReadInputTokens: 10, inputTokens: 100, outputTokens: 5 },
        { inputPerMTok: 3, outputPerMTok: 15 }
      )
    ).toThrow(/cache/i);
  });

  it('throws when cache token classes exceed the total input tokens', () => {
    expect(() =>
      computeCost(
        {
          cacheCreationInputTokens: 80,
          cacheReadInputTokens: 40,
          inputTokens: 100,
          outputTokens: 5,
        },
        { cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75, inputPerMTok: 3, outputPerMTok: 15 }
      )
    ).toThrow(/exceed/i);
  });

  it('keeps pre-cache behavior identical when no cache tokens are present', () => {
    const result = computeCost(
      { inputTokens: 1_000_000, outputTokens: 0 },
      { cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75, inputPerMTok: 3, outputPerMTok: 15 }
    );
    expect(result).toEqual({ available: true, provenance: 'exact-pricing', usdAmount: 3 });
  });
});

describe('computeCost', () => {
  it('computes exact USD cost from usage and pricing', () => {
    const result = computeCost(
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      { inputPerMTok: 3, outputPerMTok: 15 }
    );
    expect(result).toEqual({
      available: true,
      provenance: 'exact-pricing',
      usdAmount: 18,
    });
  });

  it('computes fractional cost for sub-million token counts', () => {
    const result = computeCost(
      { inputTokens: 1000, outputTokens: 500 },
      { inputPerMTok: 1.25, outputPerMTok: 10 }
    );
    // (1000 * 1.25 + 500 * 10) / 1_000_000 = (1250 + 5000) / 1e6 = 0.00625
    expect(result).toEqual({
      available: true,
      provenance: 'exact-pricing',
      usdAmount: 0.006_25,
    });
  });

  it('returns unpriced_model (NOT $0) when pricing is undefined', () => {
    const result = computeCost({ inputTokens: 1000, outputTokens: 1000 }, undefined);
    expect(result).toEqual({ available: false, reason: 'unpriced_model' });
    // Never silently report a free price for an unknown model.
    expect(result).not.toHaveProperty('usdAmount');
  });

  it('returns usage_unavailable (NOT $0) when usage is null', () => {
    const result = computeCost(null, { inputPerMTok: 3, outputPerMTok: 15 });
    expect(result).toEqual({ available: false, reason: 'usage_unavailable' });
    expect(result).not.toHaveProperty('usdAmount');
  });

  it('usage_unavailable takes precedence when both usage and pricing are missing', () => {
    const result = computeCost(null, undefined);
    expect(result).toEqual({ available: false, reason: 'usage_unavailable' });
  });

  it('returns an exact zero cost only when both pricing rates are genuinely zero', () => {
    const result = computeCost(
      { inputTokens: 1000, outputTokens: 1000 },
      { inputPerMTok: 0, outputPerMTok: 0 }
    );
    expect(result).toEqual({ available: true, provenance: 'exact-pricing', usdAmount: 0 });
  });

  it('throws on malformed (negative) token usage rather than coercing', () => {
    expect(() =>
      computeCost({ inputTokens: -1, outputTokens: 0 }, { inputPerMTok: 3, outputPerMTok: 15 })
    ).toThrow();
  });

  it('throws on non-finite token usage rather than coercing', () => {
    expect(() =>
      computeCost(
        { inputTokens: Number.NaN, outputTokens: 0 },
        { inputPerMTok: 3, outputPerMTok: 15 }
      )
    ).toThrow();
  });

  it('throws on malformed (negative) pricing rather than coercing', () => {
    expect(() =>
      computeCost({ inputTokens: 1, outputTokens: 1 }, { inputPerMTok: -1, outputPerMTok: 15 })
    ).toThrow();
  });
});

describe('formatUsdCost', () => {
  it('formats whole-dollar amounts as USD currency', () => {
    expect(formatUsdCost(18)).toBe('$18.00');
  });

  it('formats sub-cent amounts with enough precision to avoid showing $0.00', () => {
    // 0.00625 must not round to $0.00 — that would lie about a real cost.
    const formatted = formatUsdCost(0.006_25);
    expect(formatted).toContain('$');
    expect(formatted).not.toBe('$0.00');
  });

  it('formats a genuine zero as $0.00', () => {
    expect(formatUsdCost(0)).toBe('$0.00');
  });

  it('throws on non-finite input rather than emitting NaN', () => {
    expect(() => formatUsdCost(Number.NaN)).toThrow();
  });
});
