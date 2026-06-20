import { describe, expect, it } from 'vitest';
import {
  type OmMeterState,
  parseObservationalMemoryRow,
  resolveOmMeterState,
} from '../assistant-om-segment';

/** A well-formed raw OM row as returned by the live query (camelCase columns). */
function rawRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    observationTokenCount: 5000,
    totalTokensObserved: 12_000,
    ...overrides,
  };
}

describe('parseObservationalMemoryRow', () => {
  it('parses a well-formed row', () => {
    const parsed = parseObservationalMemoryRow(rawRow());
    expect(parsed).toEqual({ observationTokenCount: 5000, totalTokensObserved: 12_000 });
  });

  it('THROWS on a non-object row (never fabricates 0)', () => {
    expect(() => parseObservationalMemoryRow(null)).toThrow();
    expect(() => parseObservationalMemoryRow('nope')).toThrow();
  });

  it('THROWS when observationTokenCount is missing or non-integer', () => {
    expect(() =>
      parseObservationalMemoryRow(rawRow({ observationTokenCount: undefined }))
    ).toThrow();
    expect(() => parseObservationalMemoryRow(rawRow({ observationTokenCount: 1.5 }))).toThrow();
    expect(() => parseObservationalMemoryRow(rawRow({ observationTokenCount: 'x' }))).toThrow();
  });

  it('THROWS when totalTokensObserved is missing or negative', () => {
    expect(() => parseObservationalMemoryRow(rawRow({ totalTokensObserved: undefined }))).toThrow();
    expect(() => parseObservationalMemoryRow(rawRow({ totalTokensObserved: -1 }))).toThrow();
  });

  it('accepts numeric strings from the wire (PGlite may serialize integers as strings)', () => {
    const parsed = parseObservationalMemoryRow(
      rawRow({ observationTokenCount: '5000', totalTokensObserved: '12000' })
    );
    expect(parsed).toEqual({ observationTokenCount: 5000, totalTokensObserved: 12_000 });
  });
});

describe('resolveOmMeterState', () => {
  const budget = 100_000;

  it('web (no durable capability) → chat-only, never zeros', () => {
    const state = resolveOmMeterState({
      hasDurableCapability: false,
      omEnabled: true,
      chatTokens: 3000,
      effectiveInputBudget: budget,
      row: rawRow(),
    });
    expect(state).toEqual<OmMeterState>({ kind: 'chat-only' });
  });

  it('OM disabled → inactive (explicit, never "0 saved")', () => {
    const state = resolveOmMeterState({
      hasDurableCapability: true,
      omEnabled: false,
      chatTokens: 3000,
      effectiveInputBudget: budget,
      row: rawRow(),
    });
    expect(state).toEqual<OmMeterState>({ kind: 'inactive' });
  });

  it('no OM row yet → empty state (not a throw, not zeros)', () => {
    const state = resolveOmMeterState({
      hasDurableCapability: true,
      omEnabled: true,
      chatTokens: 3000,
      effectiveInputBudget: budget,
      row: null,
    });
    expect(state).toEqual<OmMeterState>({ kind: 'empty' });
  });

  it('live-query error → error state (honest unavailable, never 0)', () => {
    const state = resolveOmMeterState({
      hasDurableCapability: true,
      omEnabled: true,
      chatTokens: 3000,
      effectiveInputBudget: budget,
      row: null,
      queryError: new Error('subscription failed'),
    });
    expect(state.kind).toBe('error');
    if (state.kind === 'error') {
      expect(state.reason).toMatch(/subscription failed/);
    }
  });

  it('malformed row → error state (never fabricated 0)', () => {
    const state = resolveOmMeterState({
      hasDurableCapability: true,
      omEnabled: true,
      chatTokens: 3000,
      effectiveInputBudget: budget,
      row: { observationTokenCount: 'broken' },
    });
    expect(state.kind).toBe('error');
  });

  it('computes the three segments + compaction saved tokens', () => {
    const state = resolveOmMeterState({
      hasDurableCapability: true,
      omEnabled: true,
      chatTokens: 3000,
      effectiveInputBudget: budget,
      row: rawRow({ observationTokenCount: 5000, totalTokensObserved: 12_000 }),
    });
    expect(state).toEqual<OmMeterState>({
      kind: 'segments',
      chatTokens: 3000,
      observationTokens: 5000,
      // free = 100000 - (3000 + 5000)
      freeTokens: 92_000,
      overBudget: false,
      // 12000 - 5000
      compactionSavedTokens: 7000,
    });
  });

  it('over budget → honest negative-free display, never hidden', () => {
    const state = resolveOmMeterState({
      hasDurableCapability: true,
      omEnabled: true,
      chatTokens: 80_000,
      effectiveInputBudget: budget,
      row: rawRow({ observationTokenCount: 40_000, totalTokensObserved: 50_000 }),
    });
    expect(state.kind).toBe('segments');
    if (state.kind === 'segments') {
      expect(state.overBudget).toBe(true);
      // free is the honest negative (80000 + 40000 = 120000 > 100000)
      expect(state.freeTokens).toBe(-20_000);
    }
  });

  it('compaction saved is 0 when nothing has been compacted yet (active row, equal totals)', () => {
    const state = resolveOmMeterState({
      hasDurableCapability: true,
      omEnabled: true,
      chatTokens: 1000,
      effectiveInputBudget: budget,
      row: rawRow({ observationTokenCount: 4000, totalTokensObserved: 4000 }),
    });
    expect(state.kind).toBe('segments');
    if (state.kind === 'segments') {
      // totalTokensObserved === observationTokenCount → 0 compacted (active OM,
      // distinct from the "inactive" state where the stat is suppressed entirely).
      expect(state.compactionSavedTokens).toBe(0);
    }
  });

  it('never reports negative compaction savings (clamps a transient totals dip to 0)', () => {
    const state = resolveOmMeterState({
      hasDurableCapability: true,
      omEnabled: true,
      chatTokens: 1000,
      effectiveInputBudget: budget,
      row: rawRow({ observationTokenCount: 6000, totalTokensObserved: 4000 }),
    });
    expect(state.kind).toBe('segments');
    if (state.kind === 'segments') {
      expect(state.compactionSavedTokens).toBe(0);
    }
  });
});
