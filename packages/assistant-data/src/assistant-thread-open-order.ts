/** The order of a resource's open thread tabs. */
export function openThreadIds(
  currentOpenThreadIds: readonly string[] | undefined,
  threadId: string
): string[] {
  if (!currentOpenThreadIds) {
    return [threadId];
  }
  if (currentOpenThreadIds.includes(threadId)) {
    return [...currentOpenThreadIds];
  }
  return [...currentOpenThreadIds, threadId];
}

export function reconcileOpenThreadIds(
  currentOpenThreadIds: readonly string[] | undefined,
  loadedThreadIds: ReadonlySet<string>,
  selectedThreadId: string | undefined
): string[] {
  const openIds = (currentOpenThreadIds ?? []).filter((threadId) => loadedThreadIds.has(threadId));
  if (selectedThreadId && !openIds.includes(selectedThreadId)) {
    openIds.push(selectedThreadId);
  }
  return openIds;
}

export function assertExactOpenThreadOrder(
  currentOpenThreadIds: readonly string[],
  orderedThreadIds: readonly string[]
): void {
  const orderedIdSet = new Set(orderedThreadIds);
  const containsEveryOpenThread = currentOpenThreadIds.every((threadId) =>
    orderedIdSet.has(threadId)
  );
  if (
    orderedThreadIds.length !== currentOpenThreadIds.length ||
    orderedIdSet.size !== currentOpenThreadIds.length ||
    !containsEveryOpenThread
  ) {
    throw new Error('Assistant thread tab order must contain every open thread exactly once.');
  }
}

export function hasSameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((threadId, index) => threadId === right[index]);
}
