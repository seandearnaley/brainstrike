import { beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceSearchHit, WorkspaceSearchSummary } from '../search-result-model';
import { useWorkspaceSearchStore } from '../workspace-search-store';

const store = () => useWorkspaceSearchStore.getState();

const hit = (path: string, line: number, rootId = 'root-a'): WorkspaceSearchHit => ({
  line,
  lineText: `line ${line} of ${path}`,
  path,
  rootId,
});

const SUMMARY: WorkspaceSearchSummary = {
  candidatesTruncated: false,
  matchLimitReached: true,
  scanLimited: false,
  timedOut: false,
  unreadableRootIds: [],
};

describe('workspace search store', () => {
  beforeEach(() => {
    store().reset();
  });

  it('groups streamed matches by file, in the order they were found', () => {
    const generation = store().beginSearch();
    store().appendMatches([hit('b.ts', 4), hit('a.ts', 1)], generation);
    store().appendMatches([hit('b.ts', 9), hit('a.ts', 1, 'root-b')], generation);

    expect(store().files).toEqual([
      {
        matches: [
          { line: 4, lineText: 'line 4 of b.ts' },
          { line: 9, lineText: 'line 9 of b.ts' },
        ],
        path: 'b.ts',
        rootId: 'root-a',
      },
      { matches: [{ line: 1, lineText: 'line 1 of a.ts' }], path: 'a.ts', rootId: 'root-a' },
      { matches: [{ line: 1, lineText: 'line 1 of a.ts' }], path: 'a.ts', rootId: 'root-b' },
    ]);
    expect(store().totalMatches).toBe(4);
    expect(store().status).toBe('searching');
  });

  it('keeps the finished search caps, and none while it runs', () => {
    const generation = store().beginSearch();
    expect(store().summary).toBeNull();
    store().completeSearch(SUMMARY, generation);
    expect(store().status).toBe('results');
    expect(store().summary).toEqual(SUMMARY);
  });

  it('drops the matches and answer of a search a newer one replaced', () => {
    const first = store().beginSearch();
    store().appendMatches([hit('old.ts', 1)], first);
    const second = store().beginSearch();
    store().appendMatches([hit('old.ts', 2)], first);
    store().completeSearch(SUMMARY, first);
    store().failSearch('late failure', first);

    expect(store().files).toEqual([]);
    expect(store().status).toBe('searching');
    store().appendMatches([hit('new.ts', 1)], second);
    expect(store().files.map((file) => file.path)).toEqual(['new.ts']);
  });

  it('a match option change ends the running search and clears its results', () => {
    const generation = store().beginSearch();
    store().appendMatches([hit('a.ts', 1)], generation);
    store().toggleCase();

    expect(store()).toMatchObject({ caseSensitive: true, files: [], status: 'idle' });
    store().appendMatches([hit('a.ts', 2)], generation);
    expect(store().files).toEqual([]);
  });

  it('a failed search shows its message', () => {
    const generation = store().beginSearch();
    store().failSearch('No folder is open.', generation);
    expect(store()).toMatchObject({ error: 'No folder is open.', status: 'error' });
  });

  it('collapsing a file is remembered until the next search', () => {
    const generation = store().beginSearch();
    store().appendMatches([hit('a.ts', 1)], generation);
    store().toggleCollapsed('f:root-a:a.ts');
    expect(store().collapsedIds.has('f:root-a:a.ts')).toBe(true);
    store().beginSearch();
    expect(store().collapsedIds.size).toBe(0);
  });

  it('reset never reuses a generation, so a search from before it stays dropped', () => {
    const before = store().beginSearch();
    store().reset();
    const after = store().beginSearch();
    expect(after).toBeGreaterThan(before);
    store().appendMatches([hit('a.ts', 1)], before);
    expect(store().files).toEqual([]);
  });
});
