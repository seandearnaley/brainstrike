import { beforeEach, describe, expect, it } from 'vitest';
import {
  resetContextUsageStore,
  useContextUsageStore,
} from '../assistant-ui-panel/context-usage-store.js';

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

  it('resetContextUsageStore clears breakdown records (session/factory reset)', () => {
    useContextUsageStore.getState().recordBreakdown('t1', { invalid: true });
    resetContextUsageStore();
    expect(useContextUsageStore.getState().breakdownByThread).toEqual({});
  });
});
