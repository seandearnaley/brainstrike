import { beforeEach, describe, expect, it } from 'vitest';
import { resetContextUsageStore, useContextUsageStore } from '../context-usage-store.js';

describe('context usage store', () => {
  beforeEach(() => {
    resetContextUsageStore();
  });

  it('records exact usage per thread', () => {
    useContextUsageStore.getState().recordUsage('t1', { inputTokens: 1200, outputTokens: 300 });
    expect(useContextUsageStore.getState().usageByThread['t1']).toEqual({
      inputTokens: 1200,
      outputTokens: 300,
    });
  });

  it('overwrites with the latest turn (meter shows last-turn totals, not a sum)', () => {
    const { recordUsage } = useContextUsageStore.getState();
    recordUsage('t1', { inputTokens: 1000, outputTokens: 100 });
    recordUsage('t1', { inputTokens: 1400, outputTokens: 200 });
    expect(useContextUsageStore.getState().usageByThread['t1']).toEqual({
      inputTokens: 1400,
      outputTokens: 200,
    });
  });

  it('ignores zero/zero usage reports (providers that omit usage must not flip provenance)', () => {
    useContextUsageStore.getState().recordUsage('t1', { inputTokens: 0, outputTokens: 0 });
    expect(useContextUsageStore.getState().usageByThread['t1']).toBeUndefined();
  });

  it('records partial-zero usage (some streaming providers report only output tokens)', () => {
    useContextUsageStore.getState().recordUsage('t1', { inputTokens: 0, outputTokens: 50 });
    expect(useContextUsageStore.getState().usageByThread['t1']).toEqual({
      inputTokens: 0,
      outputTokens: 50,
    });
  });

  it('ignores malformed negative usage (never corrupts the meter)', () => {
    useContextUsageStore.getState().recordUsage('t1', { inputTokens: -500, outputTokens: 300 });
    expect(useContextUsageStore.getState().usageByThread['t1']).toBeUndefined();
  });

  it('clears a single thread', () => {
    const { recordUsage, clearThread } = useContextUsageStore.getState();
    recordUsage('t1', { inputTokens: 10, outputTokens: 10 });
    recordUsage('t2', { inputTokens: 20, outputTokens: 20 });
    clearThread('t1');
    expect(useContextUsageStore.getState().usageByThread['t1']).toBeUndefined();
    expect(useContextUsageStore.getState().usageByThread['t2']).toBeDefined();
  });

  it('records the parsed run-start breakdown per thread (last run wins)', () => {
    const { recordBreakdown } = useContextUsageStore.getState();
    recordBreakdown('t1', {
      breakdown: { attachmentsCount: 0, provenance: 'heuristic', systemInstructionsTokens: 100 },
      invalid: false,
    });
    recordBreakdown('t1', {
      breakdown: {
        attachmentsCount: 1,
        provenance: 'heuristic',
        systemInstructionsTokens: 120,
        taskListTokens: 8,
      },
      invalid: false,
    });
    expect(useContextUsageStore.getState().breakdownByThread['t1']).toEqual({
      breakdown: {
        attachmentsCount: 1,
        provenance: 'heuristic',
        systemInstructionsTokens: 120,
        taskListTokens: 8,
      },
      invalid: false,
    });
  });

  it('records the explicit invalid marker so a malformed part stays visible', () => {
    useContextUsageStore.getState().recordBreakdown('t1', { invalid: true });
    expect(useContextUsageStore.getState().breakdownByThread['t1']).toEqual({ invalid: true });
  });

  it('clearThread clears the breakdown together with the usage', () => {
    const { recordBreakdown, recordUsage, clearThread } = useContextUsageStore.getState();
    recordUsage('t1', { inputTokens: 10, outputTokens: 10 });
    recordBreakdown('t1', {
      breakdown: { attachmentsCount: 0, provenance: 'heuristic', systemInstructionsTokens: 5 },
      invalid: false,
    });
    clearThread('t1');
    expect(useContextUsageStore.getState().usageByThread['t1']).toBeUndefined();
    expect(useContextUsageStore.getState().breakdownByThread['t1']).toBeUndefined();
  });

  it('clearBreakdown drops a stale breakdown without touching usage', () => {
    const { recordBreakdown, recordUsage, clearBreakdown } = useContextUsageStore.getState();
    recordUsage('t1', { inputTokens: 10, outputTokens: 10 });
    recordBreakdown('t1', {
      breakdown: { attachmentsCount: 0, provenance: 'heuristic', systemInstructionsTokens: 5 },
      invalid: false,
    });
    clearBreakdown('t1');
    expect(useContextUsageStore.getState().breakdownByThread['t1']).toBeUndefined();
    expect(useContextUsageStore.getState().usageByThread['t1']).toEqual({
      inputTokens: 10,
      outputTokens: 10,
    });
  });

  it('clearBreakdown only affects the named thread', () => {
    const { recordBreakdown, clearBreakdown } = useContextUsageStore.getState();
    recordBreakdown('t1', { invalid: true });
    recordBreakdown('t2', { invalid: true });
    clearBreakdown('t1');
    expect(useContextUsageStore.getState().breakdownByThread['t1']).toBeUndefined();
    expect(useContextUsageStore.getState().breakdownByThread['t2']).toEqual({ invalid: true });
  });

  it('claiming a settle window twice returns the SAME state, so nothing re-renders', () => {
    // A `{ ...state }` here would notify every meter subscriber — including the
    // streaming message list — on every duplicate run-finish.
    useContextUsageStore.getState().beginLiveRunUsageSettle('t1');
    const afterFirst = useContextUsageStore.getState();

    afterFirst.beginLiveRunUsageSettle('t1');

    expect(useContextUsageStore.getState()).toBe(afterFirst);
    expect(useContextUsageStore.getState().settlingRunUsageByThread).toEqual({ t1: true });
  });

  it('ONE release ends a window claimed twice, so a duplicate finish strands nothing', () => {
    // The invariant the idempotency above exists to serve, asserted end-to-end rather
    // than argued in prose: a concurrent second finish claims again, and the first
    // release to land clears the marker for good. A refcounted marker would strand it
    // here and hold the reader gate open on an idle thread.
    useContextUsageStore.getState().beginLiveRunUsageSettle('t1');
    useContextUsageStore.getState().beginLiveRunUsageSettle('t1');

    useContextUsageStore.getState().clearLiveRunUsage('t1');

    expect(useContextUsageStore.getState().settlingRunUsageByThread).toStrictEqual({});
  });

  it('releases a settle claim taken for a run that recorded no steps', () => {
    // No live sum behind the claim: the release reaches it only because the
    // early-return tests the settling key as well as the live one.
    useContextUsageStore.getState().beginLiveRunUsageSettle('t1');
    expect(useContextUsageStore.getState().liveRunUsageByThread['t1']).toBeUndefined();

    useContextUsageStore.getState().clearLiveRunUsage('t1');

    // `toStrictEqual`, not `toEqual`: the latter ignores an `undefined` value, so a
    // release that ASSIGNED `undefined` rather than omitting the key would pass while
    // the record grew one dead key per thread for the life of the session.
    expect(useContextUsageStore.getState().settlingRunUsageByThread).toStrictEqual({});
  });

  it('resetContextUsageStore clears breakdown records (session/factory reset)', () => {
    useContextUsageStore.getState().recordBreakdown('t1', { invalid: true });
    useContextUsageStore.getState().recordLiveStepUsage('t1', { inputTokens: 5, outputTokens: 5 });
    useContextUsageStore.getState().beginLiveRunUsageSettle('t1');

    resetContextUsageStore();

    expect(useContextUsageStore.getState().breakdownByThread).toEqual({});
    // Every new persistent map is wired into reset (AGENTS.md platform contract).
    expect(useContextUsageStore.getState().liveRunUsageByThread).toStrictEqual({});
    expect(useContextUsageStore.getState().settlingRunUsageByThread).toStrictEqual({});
  });
});
