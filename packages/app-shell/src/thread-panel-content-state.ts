import type {
  AssistantMemoryThread,
  ThreadFilters,
  ThreadListView,
} from '@brainstrike/assistant-data';

/**
 * True when at least one Show only filter is narrowing the list.
 *
 * Lives beside the body arbitration because that is what reads it: a filtered
 * list that came back empty gets a card naming the FILTERS, never the "no
 * threads" card whose remedy would not bring any of them back.
 */
export function hasActiveThreadFilters(filters: ThreadFilters): boolean {
  return filters.hasPr || filters.needsYou || filters.running || filters.unseen;
}

/**
 * Applies the Show only filters, as a UNION of the ticked ones.
 *
 * OR, not AND: Running / Needs you / Unseen are near-disjoint states of
 * "something I might want to look at", so a user ticking two of them is
 * widening, not narrowing. An AND would answer with almost nothing every time
 * (a thread is rarely running *and* unseen).
 *
 * With no filter ticked this returns the INPUT ARRAY ITSELF, so the panel's
 * downstream memos see an unchanged identity rather than a fresh copy each
 * render. An empty result is a real answer, not a failure: the caller pairs it
 * with {@link hasActiveThreadFilters} to show the filters card.
 *
 * Each id set comes from the panel's own list-wide projection. A FAILED
 * projection reports an EMPTY set and its own error, so a filter over it simply
 * matches nothing — it never silently widens back to the full list.
 */
export function filterThreadsByThreadFilters({
  filters,
  hasPrThreadIds,
  needsYouThreadIds,
  runningThreadIds,
  threads,
  unseenThreadIds,
}: {
  readonly filters: ThreadFilters;
  readonly hasPrThreadIds: ReadonlySet<string>;
  readonly needsYouThreadIds: ReadonlySet<string>;
  readonly runningThreadIds: ReadonlySet<string>;
  readonly threads: readonly AssistantMemoryThread[];
  readonly unseenThreadIds: ReadonlySet<string>;
}): readonly AssistantMemoryThread[] {
  if (!hasActiveThreadFilters(filters)) {
    return threads;
  }
  return threads.filter(
    (thread) =>
      (filters.hasPr && hasPrThreadIds.has(thread.id)) ||
      (filters.running && runningThreadIds.has(thread.id)) ||
      (filters.needsYou && needsYouThreadIds.has(thread.id)) ||
      (filters.unseen && unseenThreadIds.has(thread.id))
  );
}

export type ThreadPanelLoadState =
  | { readonly status: 'idle' | 'loading' | 'ready' }
  | { readonly error: string; readonly status: 'error' };

export type ThreadPanelContentState =
  | {
      readonly description: string;
      readonly kind: 'card';
      readonly testId: string;
      readonly title: string;
      readonly variant: 'error' | 'muted';
    }
  | { readonly kind: 'tree' };

/**
 * Decides what the panel body shows: the treegrid, or a state card in its place.
 *
 * Both the body and the toolbar read this. The toolbar's visible count and
 * select-visible toggle describe the treegrid, so they must withdraw whenever a
 * card stands in for it — otherwise the toolbar reports a count for rows that
 * are not on screen and offers to select threads the user cannot see.
 */
/**
 * Resolution state of the `roots` rows folder grouping is built from, or `null`
 * outside folder grouping.
 *
 * Neither half is decoration. An unresolved or failed folder map is EMPTY, and
 * an empty map groups every thread under "No folder" — the same silent degrade
 * the panel already refuses for its run-state indicators. So both replace the
 * treegrid rather than letting it state that as a fact.
 */
export interface ThreadPanelFolderGroupingState {
  readonly error: Error | null;
  readonly loading: boolean;
}

export function resolveThreadPanelContentState({
  databaseError,
  databaseStartupLoading,
  folderGrouping,
  loadState,
  repositoryReady,
  threadFiltersActive,
  threads,
  view,
}: {
  readonly databaseError: Error | null;
  readonly databaseStartupLoading: boolean;
  readonly folderGrouping: ThreadPanelFolderGroupingState | null;
  readonly loadState: ThreadPanelLoadState | null;
  readonly repositoryReady: boolean;
  /** True when `threads` has already been narrowed by the Show only filters. */
  readonly threadFiltersActive: boolean;
  readonly threads: readonly AssistantMemoryThread[];
  readonly view: ThreadListView;
}): ThreadPanelContentState {
  if (!repositoryReady) {
    if (databaseStartupLoading) {
      return {
        description: 'Reading Mastra memory from PGlite.',
        kind: 'card',
        testId: 'threads-loading-card',
        title: 'Loading threads...',
        variant: 'muted',
      };
    }
    if (databaseError) {
      return {
        description: databaseError.message,
        kind: 'card',
        testId: 'threads-error-card',
        title: 'Assistant memory database failed',
        variant: 'error',
      };
    }
    return {
      description: 'The assistant is unavailable until PGlite memory initializes.',
      kind: 'card',
      testId: 'threads-error-card',
      title: 'Assistant memory database unavailable',
      variant: 'error',
    };
  }
  if (loadState?.status === 'error') {
    return {
      description: loadState.error,
      kind: 'card',
      testId: 'threads-error-card',
      title: 'Failed to load threads',
      variant: 'error',
    };
  }
  if (loadState?.status === 'loading' && threads.length === 0) {
    return {
      description: 'Reading Mastra memory from PGlite.',
      kind: 'card',
      testId: 'threads-loading-card',
      title: 'Loading threads...',
      variant: 'muted',
    };
  }
  if (folderGrouping?.error) {
    return {
      description: folderGrouping.error.message,
      kind: 'card',
      testId: 'threads-folders-error-card',
      title: 'Folder grouping unavailable',
      variant: 'error',
    };
  }
  if (folderGrouping?.loading) {
    return {
      description: 'Reading workspace folders from PGlite.',
      kind: 'card',
      testId: 'threads-folders-loading-card',
      title: 'Loading folders...',
      variant: 'muted',
    };
  }
  if (threads.length === 0 && threadFiltersActive) {
    // Never the "No threads found" card here: threads exist, the filters are
    // simply hiding all of them, and that card's remedy (create a thread) would
    // not bring any of them back.
    return {
      description: 'No thread matches Show only. Clear the filters in view options.',
      kind: 'card',
      testId: 'threads-filtered-empty-card',
      title: 'No matching threads',
      variant: 'muted',
    };
  }
  if (threads.length === 0 && view.kind === 'flat') {
    return {
      description: 'Create a new Mastra memory thread for this workspace.',
      kind: 'card',
      testId: 'threads-placeholder-card',
      title: 'No threads found',
      variant: 'muted',
    };
  }
  return { kind: 'tree' };
}
