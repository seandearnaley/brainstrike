import type { ActionOutcome } from './types.js';

/**
 * The most closed tabs one strip remembers for Reopen Closed Tab (BST-1842).
 * Session-only and in memory: a strip owns its history for its own lifetime.
 */
export const CLOSED_TAB_HISTORY_LIMIT = 20;

/**
 * What Reopen Closed Tab reports when its strip's history is empty: a benign
 * no-op, so a success with an informational message, never an error.
 */
export const NO_CLOSED_TAB_OUTCOME: ActionOutcome = {
  message: 'No closed tab to reopen',
  ok: true,
};

export interface ClosedTab<T> {
  /** Position in the strip's reorderable order when the tab closed. */
  readonly index: number;
  readonly tab: T;
}

export interface ClosedTabHistory<T> {
  /** Forget every entry: the strip's tab set was replaced, not closed. */
  readonly clear: () => void;
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
    clear: () => {
      entries.length = 0;
    },
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

/** How one strip's attempt to reopen a closed tab ended. */
export type ReopenAttempt =
  | { readonly status: 'reopened' }
  /** The target is gone for good (a deleted thread, an unregistered app): drop the entry. */
  | { readonly error: string; readonly status: 'stale' }
  /** The target cannot be checked yet (threads still loading): keep the entry. */
  | { readonly error: string; readonly status: 'unavailable' };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reopen the most recently closed tab through `reopen`. An empty history is the
 * benign `NO_CLOSED_TAB_OUTCOME`. Only a confirmed-stale entry is dropped: an
 * `unavailable` result, a synchronous throw or a rejection puts the entry back,
 * so the next reopen retries it and an unexpected failure never loses a tab.
 */
export function reopenLastClosed<T>(
  history: ClosedTabHistory<T>,
  reopen: (closed: ClosedTab<T>) => ReopenAttempt | Promise<ReopenAttempt>
): Promise<ActionOutcome> {
  const closed = history.pop();
  if (!closed) {
    return Promise.resolve(NO_CLOSED_TAB_OUTCOME);
  }
  const putBack = (error: unknown): ActionOutcome => {
    history.record([closed]);
    return { error: errorMessage(error), ok: false };
  };
  let attempt: ReopenAttempt | Promise<ReopenAttempt>;
  try {
    attempt = reopen(closed);
  } catch (error: unknown) {
    return Promise.resolve(putBack(error));
  }
  return Promise.resolve(attempt).then((settled): ActionOutcome => {
    if (settled.status === 'reopened') {
      return { ok: true };
    }
    if (settled.status === 'unavailable') {
      history.record([closed]);
    }
    return { error: settled.error, ok: false };
  }, putBack);
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
