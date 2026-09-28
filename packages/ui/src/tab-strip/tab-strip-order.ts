export type TabEdge = 'left' | 'right';

export type TabDropResolution =
  | { readonly kind: 'none' }
  | { readonly kind: 'reorder'; readonly orderedIds: readonly string[] }
  | { readonly kind: 'stale'; readonly missingId: string };

const NONE: TabDropResolution = { kind: 'none' };

function hasSameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/**
 * Order after dropping `sourceId` on `edge` of `targetId`. `stale` means the
 * drag outlived one of its tabs (closed mid-drag): the caller logs it and
 * changes nothing rather than guessing an order.
 */
export function resolveTabDropOrder({
  edge,
  orderedIds,
  sourceId,
  targetId,
}: {
  readonly edge: TabEdge;
  readonly orderedIds: readonly string[];
  readonly sourceId: string;
  readonly targetId: string;
}): TabDropResolution {
  for (const id of [sourceId, targetId]) {
    if (!orderedIds.includes(id)) {
      return { kind: 'stale', missingId: id };
    }
  }
  if (sourceId === targetId) {
    return NONE;
  }
  const remaining = orderedIds.filter((id) => id !== sourceId);
  const targetIndex = remaining.indexOf(targetId);
  const insertIndex = edge === 'left' ? targetIndex : targetIndex + 1;
  const next = [...remaining.slice(0, insertIndex), sourceId, ...remaining.slice(insertIndex)];
  return hasSameOrder(orderedIds, next) ? NONE : { kind: 'reorder', orderedIds: next };
}

/** APG: after Delete, focus the next tab, else the previous one. */
export function resolveFocusAfterClose(
  orderedIds: readonly string[],
  closedId: string
): string | null {
  const index = orderedIds.indexOf(closedId);
  if (index === -1) {
    return null;
  }
  return orderedIds[index + 1] ?? orderedIds[index - 1] ?? null;
}

/** APG roving focus: arrows wrap, Home/End jump; any other key returns null. */
export function resolveRovingTargetIndex(
  key: string,
  currentIndex: number,
  count: number
): number | null {
  if (count === 0) {
    return null;
  }
  switch (key) {
    case 'ArrowLeft':
      return currentIndex <= 0 ? count - 1 : currentIndex - 1;
    case 'ArrowRight':
      return currentIndex === -1 || currentIndex >= count - 1 ? 0 : currentIndex + 1;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}
