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
});
