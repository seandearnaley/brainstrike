import { beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceSearchResults } from '../search-result-model';
import { useWorkspaceSearchStore } from '../workspace-search-store';

function makeResults(overrides?: Partial<WorkspaceSearchResults>): WorkspaceSearchResults {
  return {
    files: [
      {
        children: [],
        dbRootId: 'root-1',
        path: 'src/a.ts',
        rootDisplayName: 'root-1-display',
      },
      {
        children: [],
        dbRootId: 'root-1',
        path: 'src/b.ts',
        rootDisplayName: 'root-1-display',
      },
    ],
    mode: 'text',
    notices: {
      candidatesTruncated: false,
      scanLimited: false,
      skippedMissingLineMetadata: 0,
      truncated: false,
    },
    totalMatches: 2,
    ...overrides,
  };
}

describe('useWorkspaceSearchStore', () => {
  beforeEach(() => {
    useWorkspaceSearchStore.getState().reset();
  });

  it('starts with idle status and empty results', () => {
    const state = useWorkspaceSearchStore.getState();
    expect(state.status).toBe('idle');
    expect(state.results).toBeNull();
    expect(state.error).toBeNull();
    expect(state.query).toBe('');
    expect(state.mode).toBe('text');
    expect(state.collectionId).toBeNull();
    expect(state.expandedIds.size).toBe(0);
  });

  it('beginSearch sets status to searching and clears error', () => {
    useWorkspaceSearchStore.setState({ error: 'previous failure' });
    useWorkspaceSearchStore.getState().beginSearch();
    const state = useWorkspaceSearchStore.getState();
    expect(state.status).toBe('searching');
    expect(state.error).toBeNull();
  });

  it('resolveResults populates results, sets status results, and expands all file ids', () => {
    const results = makeResults();
    useWorkspaceSearchStore.getState().resolveResults(results);
    const state = useWorkspaceSearchStore.getState();
    expect(state.status).toBe('results');
    expect(state.results).toBe(results);
    expect(state.expandedIds).toEqual(new Set(['f:root-1:src/a.ts', 'f:root-1:src/b.ts']));
  });

  it('failSearch sets status error and surfaces the message', () => {
    useWorkspaceSearchStore.getState().failSearch('search backend unavailable');
    const state = useWorkspaceSearchStore.getState();
    expect(state.status).toBe('error');
    expect(state.error).toBe('search backend unavailable');
  });

  it('setMode clears results, resets status to idle, and updates mode', () => {
    useWorkspaceSearchStore.getState().resolveResults(makeResults());
    useWorkspaceSearchStore.getState().setMode('semantic');
    const state = useWorkspaceSearchStore.getState();
    expect(state.mode).toBe('semantic');
    expect(state.results).toBeNull();
    expect(state.status).toBe('idle');
  });

  it('setCollectionId clears results and resets status to idle', () => {
    useWorkspaceSearchStore.getState().resolveResults(makeResults());
    useWorkspaceSearchStore.getState().setCollectionId('embedding-set-1');
    const state = useWorkspaceSearchStore.getState();
    expect(state.collectionId).toBe('embedding-set-1');
    expect(state.results).toBeNull();
    expect(state.status).toBe('idle');
  });

  it('toggleCase clears results and resets status to idle', () => {
    useWorkspaceSearchStore.getState().resolveResults(makeResults());
    useWorkspaceSearchStore.getState().toggleCase();
    const state = useWorkspaceSearchStore.getState();
    expect(state.caseSensitive).toBe(true);
    expect(state.results).toBeNull();
    expect(state.status).toBe('idle');
  });

  it('toggleRegex clears results and resets status to idle', () => {
    useWorkspaceSearchStore.getState().resolveResults(makeResults());
    useWorkspaceSearchStore.getState().toggleRegex();
    const state = useWorkspaceSearchStore.getState();
    expect(state.isRegex).toBe(true);
    expect(state.results).toBeNull();
    expect(state.status).toBe('idle');
  });

  it('toggleWholeWord clears results and resets status to idle', () => {
    useWorkspaceSearchStore.getState().resolveResults(makeResults());
    useWorkspaceSearchStore.getState().toggleWholeWord();
    const state = useWorkspaceSearchStore.getState();
    expect(state.wholeWord).toBe(true);
    expect(state.results).toBeNull();
    expect(state.status).toBe('idle');
  });

  it('toggleExpanded flips membership of a node id', () => {
    useWorkspaceSearchStore.getState().toggleExpanded('f:root-1:src/a.ts');
    expect(useWorkspaceSearchStore.getState().expandedIds.has('f:root-1:src/a.ts')).toBe(true);
    useWorkspaceSearchStore.getState().toggleExpanded('f:root-1:src/a.ts');
    expect(useWorkspaceSearchStore.getState().expandedIds.has('f:root-1:src/a.ts')).toBe(false);
  });

  it('setQuery updates the query without touching results/status', () => {
    useWorkspaceSearchStore.getState().resolveResults(makeResults());
    useWorkspaceSearchStore.getState().setQuery('foo');
    const state = useWorkspaceSearchStore.getState();
    expect(state.query).toBe('foo');
    expect(state.status).toBe('results');
    expect(state.results).not.toBeNull();
  });

  it('reset restores initial state', () => {
    useWorkspaceSearchStore.getState().setQuery('foo');
    useWorkspaceSearchStore.getState().resolveResults(makeResults());
    useWorkspaceSearchStore.getState().reset();
    const state = useWorkspaceSearchStore.getState();
    expect(state.query).toBe('');
    expect(state.status).toBe('idle');
    expect(state.results).toBeNull();
    expect(state.expandedIds.size).toBe(0);
  });
});
