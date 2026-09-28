/**
 * The most closed tabs one strip remembers for Reopen Closed Tab (BST-1842).
 * Session-only and in memory: a strip owns its history for its own lifetime.
 */
export const CLOSED_TAB_HISTORY_LIMIT = 20;

/** What Reopen Closed Tab reports when its strip's history is empty. */
export const NO_CLOSED_TAB_ERROR = 'No closed tab to reopen';

export interface ClosedTab<T> {
  /** Position in the strip's reorderable order when the tab closed. */
  readonly index: number;
  readonly tab: T;
}

export interface ClosedTabHistory<T> {
  /** The tab most recently closed, or `undefined` when the history is empty. */
  readonly pop: () => ClosedTab<T> | undefined;
  /**
   * Record the tabs ONE close removed (any order). A bulk close pops lowest
   * index first, so reopening its tabs one by one rebuilds the old order.
   */
  readonly record: (closed: readonly ClosedTab<T>[]) => void;
  readonly size: () => number;
}

export function createClosedTabHistory<T>(
  limit: number = CLOSED_TAB_HISTORY_LIMIT
): ClosedTabHistory<T> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`Closed-tab history limit must be a positive integer, got ${limit}`);
  }
  // The end of the array is the next pop.
  const entries: ClosedTab<T>[] = [];
  return {
    pop: () => entries.pop(),
    record: (closed) => {
      entries.push(...[...closed].sort((a, b) => b.index - a.index));
      if (entries.length > limit) {
        entries.splice(0, entries.length - limit);
      }
    },
    size: () => entries.length,
  };
}

/** A tab as a strip orders it: its id plus what reopening it needs. */
export interface OpenTab<T> {
  readonly id: string;
  readonly tab: T;
}

/**
 * Record the tabs one close removed: every tab in `before` whose id is missing
 * from `afterIds`, at its `before` index. Diffing the store's own order records
 * exactly what closed, whichever path closed it and whatever the store kept.
 */
export function recordRemovedTabs<T>(
  history: ClosedTabHistory<T>,
  before: readonly OpenTab<T>[],
  afterIds: readonly string[]
): void {
  const remaining = new Set(afterIds);
  history.record(
    before.flatMap(({ id, tab }, index) => (remaining.has(id) ? [] : [{ index, tab }]))
  );
}

/**
 * Move a reopened tab (already appended to `orderedIds`) back to `index`. When
 * fewer tabs remain than its old index, it stays at the end.
 */
export function placeTabAtIndex(
  orderedIds: readonly string[],
  id: string,
  index: number
): readonly string[] {
  if (!orderedIds.includes(id)) {
    throw new Error(`Cannot place tab "${id}": it is not open`);
  }
  const others = orderedIds.filter((candidate) => candidate !== id);
  // `slice` past the end yields everything, so a stale index lands the tab last.
  return [...others.slice(0, index), id, ...others.slice(index)];
}
