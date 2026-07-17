import { describe, expect, it } from 'vitest';
import {
  type OmMeterState,
  parseObservationalMemoryRow,
  resolveOmMeterState,
} from '../assistant-om-segment';

/** A well-formed raw OM row as returned by the live query (camelCase columns). */
function rawRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bufferedObservationChunks: [{ tokenCount: 750 }, { tokenCount: 250 }],
    config: { observation: { messageTokens: 30_000 } },
    observationTokenCount: 5000,
    pendingMessageTokens: 14_000,
    totalTokensObserved: 12_000,
    ...overrides,
  };
}

describe('parseObservationalMemoryRow', () => {
  it('parses a well-formed row', () => {
    const parsed = parseObservationalMemoryRow(rawRow());
    expect(parsed).toEqual({
      bufferedObservationTokens: 1000,
      messageTokenThreshold: 30_000,
      observationTokenCount: 5000,
      pendingMessageTokens: 14_000,
      totalTokensObserved: 12_000,
    });
  });

  it('THROWS on a non-object row (never fabricates 0)', () => {
    expect(() => parseObservationalMemoryRow(null)).toThrow();
    expect(() => parseObservationalMemoryRow('nope')).toThrow();
  });

  it('THROWS when observationTokenCount is missing, non-integer, or negative', () => {
    expect(() =>
      parseObservationalMemoryRow(rawRow({ observationTokenCount: undefined }))
    ).toThrow();
    expect(() => parseObservationalMemoryRow(rawRow({ observationTokenCount: 1.5 }))).toThrow();
    expect(() => parseObservationalMemoryRow(rawRow({ observationTokenCount: 'x' }))).toThrow();
    // @mastra/memory's OM table has no DB-level (col >= 0) CHECK, so the parser is
    // the only guard against a negative token count silently reaching the meter.
    expect(() => parseObservationalMemoryRow(rawRow({ observationTokenCount: -1 }))).toThrow();
  });

  it('THROWS when totalTokensObserved is missing or negative', () => {
    expect(() => parseObservationalMemoryRow(rawRow({ totalTokensObserved: undefined }))).toThrow();
    expect(() => parseObservationalMemoryRow(rawRow({ totalTokensObserved: -1 }))).toThrow();
  });

  it('accepts numeric strings from the wire (PGlite may serialize integers as strings)', () => {
    const parsed = parseObservationalMemoryRow(
      rawRow({ observationTokenCount: '5000', totalTokensObserved: '12000' })
    );
    expect(parsed).toEqual({
      bufferedObservationTokens: 1000,
      messageTokenThreshold: 30_000,
      observationTokenCount: 5000,
      pendingMessageTokens: 14_000,
      totalTokensObserved: 12_000,
    });
  });

  it('THROWS when buffered chunks or pending activation progress are malformed', () => {
    expect(() =>
      parseObservationalMemoryRow(rawRow({ bufferedObservationChunks: [{ tokenCount: -1 }] }))
    ).toThrow();
    expect(() => parseObservationalMemoryRow(rawRow({ pendingMessageTokens: -1 }))).toThrow();
    expect(() =>
      parseObservationalMemoryRow(rawRow({ config: { observation: { messageTokens: 0 } } }))
    ).toThrow();
  });
});

describe('resolveOmMeterState', () => {
  function input(
    overrides: Partial<Parameters<typeof resolveOmMeterState>[0]> = {}
  ): Parameters<typeof resolveOmMeterState>[0] {
    return {
      hasDurableCapability: true,
      loading: false,
      omEnabled: true,
      row: rawRow(),
      ...overrides,
    };
  }

  it('web (no durable capability) → chat-only, never zeros', () => {
    expect(resolveOmMeterState(input({ hasDurableCapability: false }))).toEqual<OmMeterState>({
      kind: 'chat-only',
    });
  });

  it('OM disabled → inactive (explicit, never "0 saved")', () => {
    expect(resolveOmMeterState(input({ omEnabled: false }))).toEqual<OmMeterState>({
      kind: 'inactive',
    });
  });

  it('loading + no row yet → loading (NOT the empty flash)', () => {
    expect(resolveOmMeterState(input({ loading: true, row: null }))).toEqual<OmMeterState>({
      kind: 'loading',
    });
  });

  it('not loading + no OM row → empty state (not a throw, not zeros)', () => {
    expect(resolveOmMeterState(input({ loading: false, row: null }))).toEqual<OmMeterState>({
      kind: 'empty',
    });
  });

  it('live-query error → error state (honest unavailable, never 0)', () => {
    const state = resolveOmMeterState(
      input({ queryError: new Error('subscription failed'), row: null })
    );
    expect(state.kind).toBe('error');
    if (state.kind === 'error') {
      expect(state.reason).toMatch(/subscription failed/);
    }
  });

  it('malformed row → error state (never fabricated 0)', () => {
    const state = resolveOmMeterState(input({ row: { observationTokenCount: 'broken' } }));
    expect(state.kind).toBe('error');
  });

  it('active row → informational stats (observed tokens + compaction saved)', () => {
    const state = resolveOmMeterState(
      input({ row: rawRow({ observationTokenCount: 5000, totalTokensObserved: 12_000 }) })
    );
    expect(state).toEqual<OmMeterState>({
      bufferedObservationTokens: 1000,
      // 12000 - 5000
      compactionSavedTokens: 7000,
      kind: 'stats',
      messageTokenThreshold: 30_000,
      observationTokens: 5000,
      pendingMessageTokens: 14_000,
    });
  });

  it('observation is NOT a budget segment: the result carries NO free/overBudget/budget fields', () => {
    const state = resolveOmMeterState(
      input({ row: rawRow({ observationTokenCount: 40_000, totalTokensObserved: 50_000 }) })
    );
    expect(state.kind).toBe('stats');
    // The discriminated state must not leak any budget arithmetic — proving the
    // observation can never be summed into the input budget or trip over-budget.
    expect(state).not.toHaveProperty('freeTokens');
    expect(state).not.toHaveProperty('overBudget');
    expect(state).not.toHaveProperty('chatTokens');
  });

  it('the resolver input has no budget/chat fields (structurally cannot double-count)', () => {
    // A large observation that, under the old tri-segment model, would have
    // tripped a false over-budget now just reports the observed count — the
    // resolver has no budget to compare against.
    const state = resolveOmMeterState(
      input({ row: rawRow({ observationTokenCount: 999_999, totalTokensObserved: 999_999 }) })
    );
    expect(state).toEqual<OmMeterState>({
      bufferedObservationTokens: 1000,
      compactionSavedTokens: 0,
      kind: 'stats',
      messageTokenThreshold: 30_000,
      observationTokens: 999_999,
      pendingMessageTokens: 14_000,
    });
  });

  it('compaction saved is 0 when nothing has been compacted yet (active row, equal totals)', () => {
    const state = resolveOmMeterState(
      input({ row: rawRow({ observationTokenCount: 4000, totalTokensObserved: 4000 }) })
    );
    expect(state.kind).toBe('stats');
    if (state.kind === 'stats') {
      expect(state.compactionSavedTokens).toBe(0);
    }
  });

  it('never reports negative compaction savings (clamps a transient totals dip to 0)', () => {
    const state = resolveOmMeterState(
      input({ row: rawRow({ observationTokenCount: 6000, totalTokensObserved: 4000 }) })
    );
    expect(state.kind).toBe('stats');
    if (state.kind === 'stats') {
      expect(state.compactionSavedTokens).toBe(0);
    }
  });
});
