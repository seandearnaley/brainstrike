import type { AssistantThreadMetadata } from './assistant-memory-repository';

/** Mirrors the repository's checkout-key deletion after persistence succeeds. */
export function mergeThreadMetadataAfterPersistence(
  current: AssistantThreadMetadata | undefined,
  patch: AssistantThreadMetadata
): AssistantThreadMetadata {
  const retained = { ...(current ?? {}) };
  if (patch.checkoutMode) {
    Reflect.deleteProperty(retained, 'checkoutBranch');
  }
  if (patch.checkoutMode === 'local') {
    Reflect.deleteProperty(retained, 'checkoutLocalRootId');
    Reflect.deleteProperty(retained, 'checkoutWorktreeId');
    Reflect.deleteProperty(retained, 'checkoutWorktreePath');
  }
  return { ...retained, ...patch };
}
