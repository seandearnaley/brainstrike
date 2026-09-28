import {
  type ActionOutcome,
  type AnyContextAction,
  type ContextTargetKind,
  defineContextAction,
  type TargetOf,
} from './types.js';

export type TabMoveDirection = 'left' | 'right';

/**
 * Swap `id` with its neighbour in `direction`. Null when `id` is absent or
 * already at that edge, so callers can tell "no move" from a move.
 */
export function moveTabId(
  orderedIds: readonly string[],
  id: string,
  direction: TabMoveDirection
): readonly string[] | null {
  const index = orderedIds.indexOf(id);
  if (index === -1) {
    return null;
  }
  const destination = index + (direction === 'left' ? -1 : 1);
  const neighbour = orderedIds[destination];
  if (neighbour === undefined) {
    return null;
  }
  const next = [...orderedIds];
  next[index] = neighbour;
  next[destination] = id;
  return next;
}

export type TabCycleDirection = 'next' | 'previous';

/**
 * The tab beside `activeId` by position, wrapping at both ends (BST-1836 D7:
 * positional, as Chrome, not most-recently-used). Null when there is no other
 * tab to go to or `activeId` is not in the order.
 */
export function adjacentTabId(
  orderedIds: readonly string[],
  activeId: string | null,
  direction: TabCycleDirection
): string | null {
  const index = activeId === null ? -1 : orderedIds.indexOf(activeId);
  if (index === -1 || orderedIds.length < 2) {
    return null;
  }
  const step = direction === 'next' ? 1 : -1;
  return orderedIds[(index + step + orderedIds.length) % orderedIds.length] ?? null;
}

/** One strip's Reopen Closed Tab: the same reopen ⌘⇧T and the palette run. */
export interface ReopenClosedTabOperations {
  readonly hasClosedTabs: () => boolean;
  /** Namespaces the action id (`${idPrefix}.reopen-closed`); unique per strip. */
  readonly idPrefix: string;
  readonly reopen: () => Promise<ActionOutcome>;
  /** The `tab-strip` target this strip's background claims. */
  readonly stripId: string;
}

/**
 * "Reopen Closed Tab" on a strip's empty background (BST-1836 §6.4, BST-1842).
 * Enabled only while the strip's closed-tab history has an entry, so it never
 * offers a reopen that can only report there is nothing to reopen.
 */
export function createReopenClosedTabAction({
  hasClosedTabs,
  idPrefix,
  reopen,
  stripId,
}: ReopenClosedTabOperations): AnyContextAction {
  return defineContextAction<'tab-strip'>({
    appliesTo: ['tab-strip'],
    group: 'primary',
    id: `${idPrefix}.reopen-closed`,
    isEnabled: () => hasClosedTabs(),
    isVisible: (target) => target.stripId === stripId,
    label: 'Reopen Closed Tab',
    run: () => reopen(),
  });
}

/**
 * Store-backed operations behind one strip's standard tab menu (BST-1836
 * §6.4). Each operation is optional: an absent one omits its action. Each must
 * be atomic in the owning store — this factory only resolves ids, gates
 * enablement on the live order, and re-validates at execution.
 */
export interface TabStripActionOperations<K extends ContextTargetKind> {
  readonly close?: ((id: string) => unknown) | undefined;
  /** Receives the invoking tab so a strip can scope Close All to that tab's group. */
  readonly closeAll?: ((id: string) => unknown) | undefined;
  readonly closeOthers?: ((id: string) => unknown) | undefined;
  readonly closeToRight?: ((id: string) => unknown) | undefined;
  readonly getId: (target: TargetOf<K>) => string;
  readonly getLabel: (target: TargetOf<K>) => string;
  /** Live order of the target's group, read at menu-open AND at execution. */
  readonly getOrderedIds: (target: TargetOf<K>) => readonly string[];
  /** Namespaces action ids (`${idPrefix}.close`); unique per strip. */
  readonly idPrefix: string;
  readonly kind: K;
  /** Noun for failure copy: "This thread tab is no longer open". */
  readonly noun: string;
  readonly reorder?: ((orderedIds: readonly string[]) => unknown) | undefined;
}

const OK: ActionOutcome = { ok: true };

function toFailure(error: unknown): ActionOutcome {
  return { error: error instanceof Error ? error.message : String(error), ok: false };
}

/**
 * Runs a store operation. Its return value is ignored except as a promise to
 * await (e.g. an IPC bridge call), so operations may return anything — a
 * store's `closeTab` returning the next id included. A rejection, or a
 * synchronous throw, becomes a failed outcome, so the menu reports it instead
 * of claiming success.
 */
function settle(operation: () => unknown, success: ActionOutcome): Promise<ActionOutcome> {
  // Run synchronously so a store mutation has happened when run() returns
  // (focus restoration reads the live DOM right after); await only the result.
  let result: unknown;
  try {
    result = operation();
  } catch (error: unknown) {
    return Promise.resolve(toFailure(error));
  }
  return Promise.resolve(result).then(() => success, toFailure);
}

function fail(error: string): Promise<ActionOutcome> {
  return Promise.resolve({ error, ok: false });
}

export function createTabStripActions<K extends ContextTargetKind>(
  operations: TabStripActionOperations<K>
): readonly AnyContextAction[] {
  const { getId, getLabel, getOrderedIds, idPrefix, kind, noun } = operations;
  const locate = (target: TargetOf<K>): { index: number; orderedIds: readonly string[] } => {
    const orderedIds = getOrderedIds(target);
    return { index: orderedIds.indexOf(getId(target)), orderedIds };
  };
  const stale = (): Promise<ActionOutcome> => fail(`This ${noun} is no longer open`);
  const actions: AnyContextAction[] = [];

  const { close, closeAll, closeOthers, closeToRight, reorder } = operations;
  if (close) {
    actions.push(
      defineContextAction<K>({
        appliesTo: [kind],
        group: 'primary',
        id: `${idPrefix}.close`,
        isEnabled: (target) => locate(target).index >= 0,
        label: 'Close',
        run: (target) => {
          if (locate(target).index < 0) {
            return stale();
          }
          return settle(() => close(getId(target)), OK);
        },
      })
    );
  }
  if (closeOthers) {
    actions.push(
      defineContextAction<K>({
        appliesTo: [kind],
        group: 'primary',
        id: `${idPrefix}.close-others`,
        isEnabled: (target) => {
          const { index, orderedIds } = locate(target);
          return index >= 0 && orderedIds.length > 1;
        },
        label: 'Close Others',
        run: (target) => {
          const { index, orderedIds } = locate(target);
          if (index < 0) {
            return stale();
          }
          if (orderedIds.length <= 1) {
            return fail(`No other ${noun}s are open`);
          }
          return settle(() => closeOthers(getId(target)), OK);
        },
      })
    );
  }
  if (closeToRight) {
    actions.push(
      defineContextAction<K>({
        appliesTo: [kind],
        group: 'primary',
        id: `${idPrefix}.close-right`,
        isEnabled: (target) => {
          const { index, orderedIds } = locate(target);
          return index >= 0 && index < orderedIds.length - 1;
        },
        label: 'Close to the Right',
        run: (target) => {
          const { index, orderedIds } = locate(target);
          if (index < 0) {
            return stale();
          }
          if (index === orderedIds.length - 1) {
            return fail(`No ${noun}s are open to the right`);
          }
          return settle(() => closeToRight(getId(target)), OK);
        },
      })
    );
  }
  if (closeAll) {
    actions.push(
      defineContextAction<K>({
        appliesTo: [kind],
        group: 'primary',
        id: `${idPrefix}.close-all`,
        isEnabled: (target) => locate(target).index >= 0,
        label: 'Close All',
        run: (target) => {
          if (locate(target).index < 0) {
            return stale();
          }
          return settle(() => closeAll(getId(target)), OK);
        },
      })
    );
  }
  if (reorder) {
    for (const direction of ['left', 'right'] as const) {
      actions.push(
        defineContextAction<K>({
          appliesTo: [kind],
          group: 'tree',
          id: `${idPrefix}.move-${direction}`,
          isEnabled: (target) =>
            moveTabId(getOrderedIds(target), getId(target), direction) !== null,
          label: direction === 'left' ? 'Move Left' : 'Move Right',
          run: (target) => {
            const { index, orderedIds } = locate(target);
            if (index < 0) {
              return stale();
            }
            const next = moveTabId(orderedIds, getId(target), direction);
            if (!next) {
              return fail(`${getLabel(target)} cannot move ${direction}`);
            }
            return settle(() => reorder(next), {
              message: `Moved ${getLabel(target)} ${direction}`,
              ok: true,
            });
          },
        })
      );
    }
  }
  return actions;
}
