import { describe, expect, it } from 'vitest';
import { useThreadSearchStore } from '../thread-search-store';

const RESULT = {
  matches: [],
  score: 1,
  threadId: 'thread-1',
  title: 'Title',
  titleMatched: true,
};

describe('thread-search-store', () => {
  it('resolves results only for the current generation', () => {
    const store = useThreadSearchStore.getState();
    const staleGeneration = store.beginSearch();
    const freshGeneration = useThreadSearchStore.getState().beginSearch();

    useThreadSearchStore.getState().resolveResults([RESULT], staleGeneration);
    expect(useThreadSearchStore.getState().results).toBeNull();
    expect(useThreadSearchStore.getState().status).toBe('searching');

    useThreadSearchStore.getState().resolveResults([RESULT], freshGeneration);
    expect(useThreadSearchStore.getState().results).toHaveLength(1);
    expect(useThreadSearchStore.getState().status).toBe('results');
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
    useThreadSearchStore.getState().resolveResults([RESULT], generation);
    expect(useThreadSearchStore.getState().results).toBeNull();
  });

  it('clearSearch also clears the query text', () => {
    useThreadSearchStore.getState().setQuery('hnsw');
    useThreadSearchStore.getState().beginSearch();
    useThreadSearchStore.getState().clearSearch();

    expect(useThreadSearchStore.getState().query).toBe('');
    expect(useThreadSearchStore.getState().status).toBe('idle');
  });

  it('a run started before a reset never resolves into a run started after it', () => {
    const beforeReset = useThreadSearchStore.getState().beginSearch();
    useThreadSearchStore.setState(useThreadSearchStore.getInitialState(), true);
    const afterReset = useThreadSearchStore.getState().beginSearch();

    expect(afterReset).not.toBe(beforeReset);
    useThreadSearchStore.getState().resolveResults([RESULT], beforeReset);
    expect(useThreadSearchStore.getState().results).toBeNull();
  });
});
