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

/** Seed results tagged with the CURRENT generation so they actually apply. */
function seedResults(overrides?: Partial<WorkspaceSearchResults>): void {
  const generation = useWorkspaceSearchStore.getState().generation;
  useWorkspaceSearchStore.getState().resolveResults(makeResults(overrides), generation);
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
    const generation = useWorkspaceSearchStore.getState().generation;
    useWorkspaceSearchStore.getState().resolveResults(results, generation);
    const state = useWorkspaceSearchStore.getState();
    expect(state.status).toBe('results');
    expect(state.results).toBe(results);
    expect(state.expandedIds).toEqual(new Set(['f:root-1:src/a.ts', 'f:root-1:src/b.ts']));
  });

  it('resolveResults also expands text-mode chunk-group ids so matches render', () => {
    const results = makeResults({
      files: [
        {
          children: [
            {
              after: [],
              before: [],
              chunkEndLine: 12,
              chunkId: 'chunk-1',
              chunkStartLine: 8,
              kind: 'match',
              line: 9,
              lineText: 'a',
              provenance: 'index',
            },
            {
              after: [],
              before: [],
              chunkEndLine: 20,
              chunkId: 'chunk-2',
              chunkStartLine: 14,
              kind: 'match',
              line: 15,
              lineText: 'b',
              provenance: 'index',
            },
          ],
          dbRootId: 'root-1',
          path: 'src/a.ts',
          rootDisplayName: 'root-1-display',
        },
      ],
    });
    const generation = useWorkspaceSearchStore.getState().generation;
    useWorkspaceSearchStore.getState().resolveResults(results, generation);
    expect(useWorkspaceSearchStore.getState().expandedIds).toEqual(
      new Set(['f:root-1:src/a.ts', 'c:chunk-1', 'c:chunk-2'])
    );
  });

  it('failSearch sets status error and surfaces the message', () => {
    const generation = useWorkspaceSearchStore.getState().generation;
    useWorkspaceSearchStore.getState().failSearch('search backend unavailable', generation);
    const state = useWorkspaceSearchStore.getState();
    expect(state.status).toBe('error');
    expect(state.error).toBe('search backend unavailable');
  });

  it('beginSearch increments the generation and returns the new value', () => {
    const before = useWorkspaceSearchStore.getState().generation;
    const generation = useWorkspaceSearchStore.getState().beginSearch();
    expect(generation).toBe(before + 1);
    expect(useWorkspaceSearchStore.getState().generation).toBe(generation);
  });

  it('resolveResults is a no-op when the generation is stale (superseded run)', () => {
    const staleGeneration = useWorkspaceSearchStore.getState().beginSearch();
    // A newer run (or any invalidating change) advances the generation.
    useWorkspaceSearchStore.getState().setMode('semantic');
    useWorkspaceSearchStore.getState().resolveResults(makeResults(), staleGeneration);
    const state = useWorkspaceSearchStore.getState();
    expect(state.results).toBeNull();
    expect(state.status).toBe('idle');
  });

  it('failSearch is a no-op when the generation is stale (superseded run)', () => {
    const staleGeneration = useWorkspaceSearchStore.getState().beginSearch();
    const freshGeneration = useWorkspaceSearchStore.getState().beginSearch();
    useWorkspaceSearchStore.getState().resolveResults(makeResults(), freshGeneration);
    // Older run rejects after the newer run resolved — must not clobber results.
    useWorkspaceSearchStore.getState().failSearch('stale grep died', staleGeneration);
    const state = useWorkspaceSearchStore.getState();
    expect(state.status).toBe('results');
    expect(state.error).toBeNull();
    expect(state.results).not.toBeNull();
  });

  it('invalidating changes advance the generation', () => {
    const start = useWorkspaceSearchStore.getState().generation;
    useWorkspaceSearchStore.getState().setMode('semantic');
    useWorkspaceSearchStore.getState().setCollectionId('set-1');
    useWorkspaceSearchStore.getState().toggleCase();
    useWorkspaceSearchStore.getState().toggleRegex();
    useWorkspaceSearchStore.getState().toggleWholeWord();
    expect(useWorkspaceSearchStore.getState().generation).toBe(start + 5);
  });

  it('setMode clears results, resets status to idle, and updates mode', () => {
    seedResults();
    useWorkspaceSearchStore.getState().setMode('semantic');
    const state = useWorkspaceSearchStore.getState();
    expect(state.mode).toBe('semantic');
    expect(state.results).toBeNull();
    expect(state.status).toBe('idle');
  });

  it('setCollectionId clears results and resets status to idle', () => {
    seedResults();
    useWorkspaceSearchStore.getState().setCollectionId('embedding-set-1');
    const state = useWorkspaceSearchStore.getState();
    expect(state.collectionId).toBe('embedding-set-1');
    expect(state.results).toBeNull();
    expect(state.status).toBe('idle');
  });

  it('toggleCase clears results and resets status to idle', () => {
    seedResults();
    useWorkspaceSearchStore.getState().toggleCase();
    const state = useWorkspaceSearchStore.getState();
    expect(state.caseSensitive).toBe(true);
    expect(state.results).toBeNull();
    expect(state.status).toBe('idle');
  });

  it('toggleRegex clears results and resets status to idle', () => {
    seedResults();
    useWorkspaceSearchStore.getState().toggleRegex();
    const state = useWorkspaceSearchStore.getState();
    expect(state.isRegex).toBe(true);
    expect(state.results).toBeNull();
    expect(state.status).toBe('idle');
  });

  it('toggleWholeWord clears results and resets status to idle', () => {
    seedResults();
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

  it('clearResults nulls results, resets to idle, and bumps the generation', () => {
    seedResults();
    const before = useWorkspaceSearchStore.getState().generation;
    useWorkspaceSearchStore.getState().clearResults();
    const state = useWorkspaceSearchStore.getState();
    expect(state.results).toBeNull();
    expect(state.status).toBe('idle');
    expect(state.error).toBeNull();
    expect(state.generation).toBe(before + 1);
  });

  it('clearResults bumps the generation so a superseded run cannot resurrect results', () => {
    const generation = useWorkspaceSearchStore.getState().beginSearch();
    useWorkspaceSearchStore.getState().clearResults();
    // The in-flight run resolving with the pre-clear generation must be dropped.
    useWorkspaceSearchStore.getState().resolveResults(makeResults(), generation);
    const state = useWorkspaceSearchStore.getState();
    expect(state.results).toBeNull();
    expect(state.status).toBe('idle');
  });

  it('setQuery updates the query without touching results/status', () => {
    seedResults();
    useWorkspaceSearchStore.getState().setQuery('foo');
    const state = useWorkspaceSearchStore.getState();
    expect(state.query).toBe('foo');
    expect(state.status).toBe('results');
    expect(state.results).not.toBeNull();
  });

  it('reset restores initial state', () => {
    useWorkspaceSearchStore.getState().setQuery('foo');
    seedResults();
    useWorkspaceSearchStore.getState().reset();
    const state = useWorkspaceSearchStore.getState();
    expect(state.query).toBe('');
    expect(state.status).toBe('idle');
    expect(state.results).toBeNull();
    expect(state.expandedIds.size).toBe(0);
  });
});
