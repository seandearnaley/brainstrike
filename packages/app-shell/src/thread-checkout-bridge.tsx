/**
 * ADR-0034: the Explorer follows the active thread. When the selected workspace thread works in
 * a worktree, the Explorer shows that worktree in place of the folder it was made from.
 */
import {
  useAssistantThreadStore,
  useResourceThread,
  WORKSPACE_MEMORY_RESOURCE_ID,
} from '@brainstrike/assistant-data';
import { type ThreadCheckout, ThreadCheckoutProvider } from '@brainstrike/file-explorer-ui/shell';
import { type ReactNode, useMemo } from 'react';

export function ThreadCheckoutBridge({ children }: { readonly children: ReactNode }) {
  const threadId = useAssistantThreadStore(
    (state) => state.selectedThreadByResourceId[WORKSPACE_MEMORY_RESOURCE_ID]
  );
  const metadata = useResourceThread(WORKSPACE_MEMORY_RESOURCE_ID, threadId)?.metadata;
  const worktreeRootId =
    metadata?.checkoutMode === 'worktree' ? (metadata.operatingRootId ?? null) : null;
  const localRootId = metadata?.checkoutLocalRootId ?? null;
  const checkout = useMemo<ThreadCheckout | null>(
    () => (worktreeRootId ? { localRootId, worktreeRootId } : null),
    [localRootId, worktreeRootId]
  );
  return <ThreadCheckoutProvider checkout={checkout}>{children}</ThreadCheckoutProvider>;
}
