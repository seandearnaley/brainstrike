import type { AssistantThreadMetadata } from './assistant-memory-repository';

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
