import type { AssistantMemoryThread, ThreadListView } from '@brainstrike/assistant-data';
import { describe, expect, it } from 'vitest';
import {
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
    databaseError: null,
    databaseStartupLoading: false,
    loadState: { status: 'ready' },
    repositoryReady: true,
    threads: [thread('thread-a')],
    view: POPULATED_FLAT,
    ...overrides,
  });
}

describe('resolveThreadPanelContentState', () => {
  it('shows the treegrid once the repository is ready and threads exist', () => {
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
      name: 'database startup still running',
      overrides: { databaseStartupLoading: true, repositoryReady: false },
    },
    {
      expected: {
        description: 'PGlite refused to open.',
        kind: 'card',
        testId: 'threads-error-card',
        title: 'Assistant memory database failed',
        variant: 'error',
      },
      name: 'database provider failed',
      overrides: { databaseError: new Error('PGlite refused to open.'), repositoryReady: false },
    },
    {
      expected: {
        description: 'The assistant is unavailable until PGlite memory initializes.',
        kind: 'card',
        testId: 'threads-error-card',
        title: 'Assistant memory database unavailable',
        variant: 'error',
      },
      name: 'repository missing after startup settled',
      overrides: { repositoryReady: false },
    },
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

  it('prefers the startup-loading card over the unavailable card while both could apply', () => {
    expect(
      resolve({
        databaseError: new Error('ignored while startup is still running'),
        databaseStartupLoading: true,
        repositoryReady: false,
      })
    ).toMatchObject({ testId: 'threads-loading-card' });
  });
});
