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

/**
 * Store-backed operations behind one strip's standard tab menu (BST-1836
 * §6.4). Each operation is optional: an absent one omits its action. Each must
 * be atomic in the owning store — this factory only resolves ids, gates
 * enablement on the live order, and re-validates at execution.
 */
export interface TabStripActionOperations<K extends ContextTargetKind> {
  readonly close?: ((id: string) => void) | undefined;
  readonly closeAll?: (() => void) | undefined;
  readonly closeOthers?: ((id: string) => void) | undefined;
  readonly closeToRight?: ((id: string) => void) | undefined;
  readonly getId: (target: TargetOf<K>) => string;
  readonly getLabel: (target: TargetOf<K>) => string;
  /** Live order of the target's group, read at menu-open AND at execution. */
  readonly getOrderedIds: (target: TargetOf<K>) => readonly string[];
  /** Namespaces action ids (`${idPrefix}.close`); unique per strip. */
  readonly idPrefix: string;
  readonly kind: K;
  /** Noun for failure copy: "This thread tab is no longer open". */
  readonly noun: string;
  readonly reorder?: ((orderedIds: readonly string[]) => void) | undefined;
}

const OK: ActionOutcome = { ok: true };

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
          close(getId(target));
          return Promise.resolve(OK);
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
          closeOthers(getId(target));
          return Promise.resolve(OK);
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
          closeToRight(getId(target));
          return Promise.resolve(OK);
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
          closeAll();
          return Promise.resolve(OK);
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
            reorder(next);
            return Promise.resolve({ message: `Moved ${getLabel(target)} ${direction}`, ok: true });
          },
        })
      );
    }
  }
  return actions;
}
