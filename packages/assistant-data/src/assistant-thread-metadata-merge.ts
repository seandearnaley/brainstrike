import type { AssistantMemoryThread, AssistantThreadMetadata } from './assistant-memory-repository';

/** Mirrors the repository's checkout-transition merge in loaded store state. */
export function mergeAssistantThreadMetadata(
  existing: AssistantThreadMetadata | undefined,
  patch: AssistantThreadMetadata
): AssistantThreadMetadata {
  if (!patch.checkoutMode) {
    return { ...(existing ?? {}), ...patch };
  }
  const { checkoutBranch: _checkoutBranch, ...withoutBranch } = existing ?? {};
  if (patch.checkoutMode === 'worktree') {
    return { ...withoutBranch, ...patch };
  }
  const {
    checkoutLocalRootId: _checkoutLocalRootId,
    checkoutWorktreeId: _checkoutWorktreeId,
    checkoutWorktreePath: _checkoutWorktreePath,
    ...withoutCheckout
  } = withoutBranch;
  return { ...withoutCheckout, ...patch };
}

/**
 * A refresh's metadata for a thread whose metadata changed here while the
 * refresh read it: the keys changed here keep their local value, and every
 * other key takes the refreshed one, so an out-of-band change is not lost.
 */
export function overlayLocalMetadataChanges(
  before: AssistantThreadMetadata | undefined,
  local: AssistantThreadMetadata,
  refreshed: AssistantThreadMetadata | undefined
): AssistantThreadMetadata {
  const was: Record<string, unknown> = { ...(before ?? {}) };
  const now: Record<string, unknown> = { ...local };
  const next: Record<string, unknown> = { ...(refreshed ?? {}) };
  for (const key of new Set([...Object.keys(was), ...Object.keys(now)])) {
    if (JSON.stringify(was[key]) === JSON.stringify(now[key])) {
      continue;
    }
    if (now[key] === undefined) {
      delete next[key];
    } else {
      next[key] = now[key];
    }
  }
  return next as AssistantThreadMetadata;
}

/**
 * A refresh's threads over the store's: a thread whose metadata changed here
 * while the refresh read it keeps those changes (`overlayLocalMetadataChanges`).
 */
export function mergeRefreshedThreadMetadata(
  loaded: readonly AssistantMemoryThread[],
  current: readonly AssistantMemoryThread[],
  snapshots: ReadonlyMap<string, AssistantThreadMetadata | undefined>
): AssistantMemoryThread[] {
  const currentById = new Map(current.map((thread) => [thread.id, thread]));
  return loaded.map((thread) => {
    const local = currentById.get(thread.id)?.metadata;
    const before = snapshots.get(thread.id);
    return local === undefined || local === before
      ? thread
      : { ...thread, metadata: overlayLocalMetadataChanges(before, local, thread.metadata) };
  });
}
