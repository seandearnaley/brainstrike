import { describe, expect, it } from 'vitest';
import { resolveToolGuardBudget, TOOL_GUARD_MARGIN_MS } from '../tools/resolve-tool-guard-budget';

const budget = { defaultMs: 120_000, maxMs: 600_000 };

describe('resolveToolGuardBudget', () => {
  it('a tool with no declared budget keeps the global guard default, with no margin', () => {
    expect(
      resolveToolGuardBudget({ budget: undefined, defaultGuardMs: 60_000, input: {} }).guardMs
    ).toBe(60_000);
  });

  it('an omitted timeoutMs grants the declared default plus the margin', () => {
    expect(
      resolveToolGuardBudget({ budget, defaultGuardMs: 60_000, input: { command: 'x' } }).guardMs
    ).toBe(120_000 + TOOL_GUARD_MARGIN_MS);
  });

  it('a requested timeoutMs is honoured', () => {
    expect(
      resolveToolGuardBudget({ budget, defaultGuardMs: 60_000, input: { timeoutMs: 300_000 } })
        .guardMs
    ).toBe(300_000 + TOOL_GUARD_MARGIN_MS);
  });

  it('a request above maxMs is bounded by maxMs (the schema rejects it; the guard must not outlive it)', () => {
    expect(
      resolveToolGuardBudget({ budget, defaultGuardMs: 60_000, input: { timeoutMs: 9_999_999 } })
        .guardMs
    ).toBe(600_000 + TOOL_GUARD_MARGIN_MS);
  });

  // The guard runs BEFORE the tool parses its input. A malformed timeoutMs is
  // the tool's error to report (ToolInputError, in milliseconds); the guard
  // only needs a finite budget for that short rejection.
  it.each(['300000', 0, -5, 1.5, Number.NaN, null])(
    'malformed timeoutMs (%s) falls to the declared default',
    (bad) => {
      expect(
        resolveToolGuardBudget({ budget, defaultGuardMs: 60_000, input: { timeoutMs: bad } })
          .guardMs
      ).toBe(120_000 + TOOL_GUARD_MARGIN_MS);
    }
  );

  it('a non-object input falls to the declared default', () => {
    expect(
      resolveToolGuardBudget({ budget, defaultGuardMs: 60_000, input: undefined }).guardMs
    ).toBe(120_000 + TOOL_GUARD_MARGIN_MS);
  });

  it('grantedMs is the model-facing budget: the margin belongs to the guard alone', () => {
    expect(resolveToolGuardBudget({ budget, defaultGuardMs: 60_000, input: {} })).toEqual({
      grantedMs: 120_000,
      guardMs: 120_000 + TOOL_GUARD_MARGIN_MS,
    });
    expect(
      resolveToolGuardBudget({ budget, defaultGuardMs: 60_000, input: { timeoutMs: 9_999_999 } })
    ).toEqual({ grantedMs: 600_000, guardMs: 600_000 + TOOL_GUARD_MARGIN_MS });
    // An undeclared tool has no deadline of its own to lose the race to, so
    // it gets no margin and the two numbers are the same.
    expect(
      resolveToolGuardBudget({ budget: undefined, defaultGuardMs: 60_000, input: {} })
    ).toEqual({ grantedMs: 60_000, guardMs: 60_000 });
  });

  it('a declared budget is NOT capped by a smaller global default', () => {
    expect(resolveToolGuardBudget({ budget, defaultGuardMs: 1000, input: {} }).guardMs).toBe(
      120_000 + TOOL_GUARD_MARGIN_MS
    );
  });
});
