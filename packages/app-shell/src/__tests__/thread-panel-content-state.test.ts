import type {
  AssistantMemoryThread,
  ThreadFilters,
  ThreadListView,
} from '@brainstrike/assistant-data';
import { describe, expect, it } from 'vitest';
import {
  filterThreadsByThreadFilters,
  hasActiveThreadFilters,
  resolveThreadPanelContentState,
  type ThreadPanelLoadState,
} from '../thread-panel-content-state';

function thread(id: string): AssistantMemoryThread {
  return {
    createdAt: new Date('2026-07-01T00:00:00Z'),
    id,
    resourceId: 'workspace-a',
    title: id,
    updatedAt: new Date('2026-07-01T00:00:00Z'),
  };
}

const POPULATED_FLAT: ThreadListView = { kind: 'flat', threads: [thread('thread-a')] };
const EMPTY_FLAT: ThreadListView = { kind: 'flat', threads: [] };
const EMPTY_GROUPED: ThreadListView = { kind: 'grouped', sections: [], ungrouped: [] };
const EMPTY_FOLDERS: ThreadListView = { kind: 'folders', sections: [] };

function resolve(
  overrides: Partial<Parameters<typeof resolveThreadPanelContentState>[0]> = {}
): ReturnType<typeof resolveThreadPanelContentState> {
  return resolveThreadPanelContentState({
    folderGrouping: null,
    loadState: { status: 'ready' },
    threadFiltersActive: false,
    threads: [thread('thread-a')],
    view: POPULATED_FLAT,
    ...overrides,
  });
}

type ContentStateInput = Parameters<typeof resolveThreadPanelContentState>[0];
type IsRequired<Key extends keyof ContentStateInput> =
  Pick<ContentStateInput, Key> extends Record<Key, ContentStateInput[Key]> ? true : false;
type Assert<Condition extends true> = Condition;

type FolderGroupingMustBeRequired = Assert<IsRequired<'folderGrouping'>>;
type ThreadFiltersActiveMustBeRequired = Assert<IsRequired<'threadFiltersActive'>>;

const REQUIRED_INPUT_CONTRACT: readonly [
  FolderGroupingMustBeRequired,
  ThreadFiltersActiveMustBeRequired,
] = [true, true];

describe('resolveThreadPanelContentState', () => {
  it('requires callers to state folder-grouping and filter activity explicitly', () => {
    expect(REQUIRED_INPUT_CONTRACT).toEqual([true, true]);
  });

  it('shows the treegrid once threads exist', () => {
    expect(resolve()).toEqual({ kind: 'tree' });
  });

  it.each([
    {
      expected: {
        description: 'Reading Mastra memory from PGlite.',
        kind: 'card',
        testId: 'threads-loading-card',
        title: 'Loading threads...',
        variant: 'muted',
      },
      name: 'first load with nothing in the store yet',
      overrides: {
        loadState: { status: 'loading' } as ThreadPanelLoadState,
        threads: [],
        view: EMPTY_FLAT,
      },
    },
    {
      expected: {
        description: 'Create a new Mastra memory thread for this workspace.',
        kind: 'card',
        testId: 'threads-placeholder-card',
        title: 'No threads found',
        variant: 'muted',
      },
      name: 'no threads and no groups to show',
      overrides: { threads: [], view: EMPTY_FLAT },
    },
  ])('stands a card in for the treegrid: $name', ({ expected, overrides }) => {
    expect(resolve(overrides)).toEqual(expected);
  });

  it('reports the load error even when threads are already in the store', () => {
    // The case that made the toolbar lie: threads exist, so the count was
    // non-zero and the select-visible toggle was enabled, while the body
    // rendered this card and no rows at all.
    expect(
      resolve({
        loadState: { error: 'Mastra storage read failed.', status: 'error' },
        threads: [thread('thread-a'), thread('thread-b')],
      })
    ).toEqual({
      description: 'Mastra storage read failed.',
      kind: 'card',
      testId: 'threads-error-card',
      title: 'Failed to load threads',
      variant: 'error',
    });
  });

  it('keeps the treegrid for an empty grouped view so the group sections stay reachable', () => {
    // The empty-state card is flat-only: grouped views render their (possibly
    // empty) sections rather than claiming there are no threads.
    expect(resolve({ threads: [], view: EMPTY_GROUPED })).toEqual({ kind: 'tree' });
  });

  it('replaces the tree while the folder rows for folder grouping are still resolving', () => {
    // An unresolved folder map groups EVERY thread under "No folder"; showing
    // the tree meanwhile would state that as a fact.
    expect(
      resolve({
        folderGrouping: { error: null, loading: true },
        view: EMPTY_FOLDERS,
      })
    ).toEqual({
      description: 'Reading workspace folders from PGlite.',
      kind: 'card',
      testId: 'threads-folders-loading-card',
      title: 'Loading folders...',
      variant: 'muted',
    });
  });

  it('replaces the tree with an explicit unavailable card when the folder rows fail', () => {
    expect(
      resolve({
        folderGrouping: { error: new Error('roots query failed'), loading: false },
        view: EMPTY_FOLDERS,
      })
    ).toEqual({
      description: 'roots query failed',
      kind: 'card',
      testId: 'threads-folders-error-card',
      title: 'Folder grouping unavailable',
      variant: 'error',
    });
  });

  it('names the filters when they are what emptied the list, instead of "no threads"', () => {
    expect(resolve({ threadFiltersActive: true, threads: [], view: EMPTY_FLAT })).toEqual({
      description: 'No thread matches Show only. Clear the filters in view options.',
      kind: 'card',
      testId: 'threads-filtered-empty-card',
      title: 'No matching threads',
      variant: 'muted',
    });
    // Without filters the list really is empty, and the card still says so.
    expect(resolve({ threads: [], view: EMPTY_FLAT })).toMatchObject({
      testId: 'threads-placeholder-card',
    });
  });
});

describe('hasActiveThreadFilters', () => {
  it('is false only when every Show only box is clear', () => {
    expect(hasActiveThreadFilters({ needsYou: false, running: false, unseen: false })).toBe(false);
    expect(hasActiveThreadFilters({ needsYou: true, running: false, unseen: false })).toBe(true);
    expect(hasActiveThreadFilters({ needsYou: false, running: true, unseen: false })).toBe(true);
    expect(hasActiveThreadFilters({ needsYou: false, running: false, unseen: true })).toBe(true);
  });
});

describe('filterThreadsByThreadFilters', () => {
  const THREADS = [thread('running'), thread('needs-you'), thread('unseen'), thread('idle')];
  const IDS = {
    needsYouThreadIds: new Set(['needs-you']),
    runningThreadIds: new Set(['running']),
    unseenThreadIds: new Set(['unseen']),
  };

  function filterIds(filters: ThreadFilters): readonly string[] {
    return filterThreadsByThreadFilters({ filters, threads: THREADS, ...IDS }).map(
      (item) => item.id
    );
  }

  // Pass-through by IDENTITY, not by value: the panel memoizes downstream work
  // on this array, so an unfiltered list must not become a new array on every
  // render.
  it('returns the same array when no filter is active', () => {
    expect(
      filterThreadsByThreadFilters({
        filters: { needsYou: false, running: false, unseen: false },
        threads: THREADS,
        ...IDS,
      })
    ).toBe(THREADS);
  });

  it('narrows to the threads one active filter names', () => {
    expect(filterIds({ needsYou: false, running: true, unseen: false })).toEqual(['running']);
    expect(filterIds({ needsYou: true, running: false, unseen: false })).toEqual(['needs-you']);
    expect(filterIds({ needsYou: false, running: false, unseen: true })).toEqual(['unseen']);
  });

  // OR, not AND: two ticked boxes ask for "anything I might want to look at".
  // An AND would answer with almost nothing — a thread is rarely running AND
  // unseen at the same time.
  it('unions two active filters instead of intersecting them', () => {
    expect(filterIds({ needsYou: false, running: true, unseen: true })).toEqual([
      'running',
      'unseen',
    ]);
    expect(filterIds({ needsYou: true, running: true, unseen: true })).toEqual([
      'running',
      'needs-you',
      'unseen',
    ]);
  });

  it('can narrow to nothing rather than falling back to the whole list', () => {
    expect(
      filterThreadsByThreadFilters({
        filters: { needsYou: false, running: true, unseen: false },
        needsYouThreadIds: new Set<string>(),
        runningThreadIds: new Set<string>(),
        threads: THREADS,
        unseenThreadIds: new Set<string>(),
      })
    ).toEqual([]);
  });
});
