export interface AssistantThreadTabDragSource {
  readonly threadId: string;
  readonly type: 'assistant-thread-tab';
}

export interface AssistantThreadTabDropTarget {
  readonly edge: 'left' | 'right';
  readonly threadId: string;
  readonly type: 'assistant-thread-tab';
}

export type AssistantThreadTabDropIntent =
  | { readonly kind: 'none' }
  | { readonly kind: 'reorder'; readonly orderedThreadIds: readonly string[] };

const NONE: AssistantThreadTabDropIntent = { kind: 'none' };

function hasSameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((threadId, index) => threadId === right[index]);
}

export function resolveAssistantThreadTabDrop({
  openThreadIds,
  source,
  target,
}: {
  readonly openThreadIds: readonly string[];
  readonly source: AssistantThreadTabDragSource;
  readonly target: AssistantThreadTabDropTarget;
}): AssistantThreadTabDropIntent {
  if (source.threadId === target.threadId) {
    return NONE;
  }
  if (!openThreadIds.includes(source.threadId)) {
    throw new Error('Dragged assistant thread tab is not open.');
  }
  if (!openThreadIds.includes(target.threadId)) {
    throw new Error('Assistant thread tab drop target is not open.');
  }

  const remainingThreadIds = openThreadIds.filter((threadId) => threadId !== source.threadId);
  const targetIndex = remainingThreadIds.indexOf(target.threadId);
  const insertIndex = target.edge === 'left' ? targetIndex : targetIndex + 1;
  const orderedThreadIds = [
    ...remainingThreadIds.slice(0, insertIndex),
    source.threadId,
    ...remainingThreadIds.slice(insertIndex),
  ];
  if (hasSameOrder(openThreadIds, orderedThreadIds)) {
    return NONE;
  }
  return { kind: 'reorder', orderedThreadIds };
}
