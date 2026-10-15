import { beforeEach, describe, expect, it } from 'vitest';
import { resetThreadSearchStore, useThreadSearchStore } from '../thread-search-store';

const RESULT = {
  matches: [],
  score: 1,
  threadId: 'thread-1',
  title: 'Title',
  titleMatched: true,
};

describe('thread-search-store', () => {
  beforeEach(() => {
    resetThreadSearchStore();
  });

  it('resolves results only for the current generation', () => {
    const store = useThreadSearchStore.getState();
    const staleGeneration = store.beginSearch();
    const freshGeneration = useThreadSearchStore.getState().beginSearch();

    useThreadSearchStore.getState().resolveResults([RESULT], { kind: 'used' }, staleGeneration);
    expect(useThreadSearchStore.getState().results).toBeNull();
    expect(useThreadSearchStore.getState().status).toBe('searching');

    useThreadSearchStore.getState().resolveResults([RESULT], { kind: 'used' }, freshGeneration);
    expect(useThreadSearchStore.getState().results).toHaveLength(1);
    expect(useThreadSearchStore.getState().status).toBe('results');
    expect(useThreadSearchStore.getState().semantic).toEqual({ kind: 'used' });
  });

  it('drops a stale failure after a newer run began', () => {
    const staleGeneration = useThreadSearchStore.getState().beginSearch();
    useThreadSearchStore.getState().beginSearch();

    useThreadSearchStore.getState().failSearch('boom', staleGeneration);
    expect(useThreadSearchStore.getState().status).toBe('searching');
    expect(useThreadSearchStore.getState().error).toBeNull();
  });

  it('clearResults keeps the query but invalidates in-flight runs', () => {
    useThreadSearchStore.getState().setQuery('h');
    const generation = useThreadSearchStore.getState().beginSearch();
    useThreadSearchStore.getState().clearResults();

    expect(useThreadSearchStore.getState().query).toBe('h');
    expect(useThreadSearchStore.getState().status).toBe('idle');

    // The pre-clear run can no longer resurrect results.
    useThreadSearchStore.getState().resolveResults([RESULT], { kind: 'used' }, generation);
    expect(useThreadSearchStore.getState().results).toBeNull();
  });

  it('clearSearch also clears the query text', () => {
    useThreadSearchStore.getState().setQuery('hnsw');
    useThreadSearchStore.getState().beginSearch();
    useThreadSearchStore.getState().clearSearch();

    expect(useThreadSearchStore.getState().query).toBe('');
    expect(useThreadSearchStore.getState().status).toBe('idle');
  });

  it('reset keeps the generation monotonic', () => {
    const beforeReset = useThreadSearchStore.getState().beginSearch();
    resetThreadSearchStore();
    expect(useThreadSearchStore.getState().generation).toBeGreaterThan(beforeReset);
  });

  it('coverage is recorded independently of run generations', () => {
    const coverage = {
      embeddableMessages: 5,
      embeddedMessages: 2,
      erroredMessages: 0,
      indexedMessages: 6,
      totalMessages: 6,
    };
    useThreadSearchStore.getState().recordCoverage(coverage);
    expect(useThreadSearchStore.getState().coverage).toEqual(coverage);
  });
});
