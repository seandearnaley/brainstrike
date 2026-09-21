import { describe, expect, it } from 'vitest';
import { resolveToolGuardBudgetMs, TOOL_GUARD_MARGIN_MS } from '../tools/resolve-tool-guard-budget';

const budget = { defaultMs: 120_000, maxMs: 600_000 };

describe('resolveToolGuardBudgetMs', () => {
  it('a tool with no declared budget keeps the global guard default, with no margin', () => {
    expect(resolveToolGuardBudgetMs({ budget: undefined, defaultGuardMs: 60_000, input: {} })).toBe(
      60_000
    );
  });

  it('an omitted timeoutMs grants the declared default plus the margin', () => {
    expect(
      resolveToolGuardBudgetMs({ budget, defaultGuardMs: 60_000, input: { command: 'x' } })
    ).toBe(120_000 + TOOL_GUARD_MARGIN_MS);
  });

  it('a requested timeoutMs is honoured', () => {
    expect(
      resolveToolGuardBudgetMs({ budget, defaultGuardMs: 60_000, input: { timeoutMs: 300_000 } })
    ).toBe(300_000 + TOOL_GUARD_MARGIN_MS);
  });

  it('a request above maxMs is bounded by maxMs (the schema rejects it; the guard must not outlive it)', () => {
    expect(
      resolveToolGuardBudgetMs({ budget, defaultGuardMs: 60_000, input: { timeoutMs: 9_999_999 } })
    ).toBe(600_000 + TOOL_GUARD_MARGIN_MS);
  });

  // The guard runs BEFORE the tool parses its input. A malformed timeoutMs is
  // the tool's error to report (ToolInputError, in milliseconds); the guard
  // only needs a finite budget for that short rejection.
  it.each(['300000', 0, -5, 1.5, Number.NaN, null])(
    'malformed timeoutMs (%s) falls to the declared default',
    (bad) => {
      expect(
        resolveToolGuardBudgetMs({ budget, defaultGuardMs: 60_000, input: { timeoutMs: bad } })
      ).toBe(120_000 + TOOL_GUARD_MARGIN_MS);
    }
  );

  it('a non-object input falls to the declared default', () => {
    expect(resolveToolGuardBudgetMs({ budget, defaultGuardMs: 60_000, input: undefined })).toBe(
      120_000 + TOOL_GUARD_MARGIN_MS
    );
  });

  it('a declared budget is NOT capped by a smaller global default', () => {
    expect(resolveToolGuardBudgetMs({ budget, defaultGuardMs: 1000, input: {} })).toBe(
      120_000 + TOOL_GUARD_MARGIN_MS
    );
  });
});
