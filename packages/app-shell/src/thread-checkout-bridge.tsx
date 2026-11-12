/**
 * ADR-0034: the Explorer follows the active thread. When the selected workspace thread works in
 * a worktree, the Explorer shows that worktree in place of the folder it was made from, and the
 * header of the folder the thread works in names its checkout (decision 3).
 */
import { checkoutName } from '@brainstrike/assistant-contract/thread-checkout-name';
import {
  useAssistantThreadStore,
  useResourceThread,
  WORKSPACE_MEMORY_RESOURCE_ID,
} from '@brainstrike/assistant-data';
import {
  type ThreadCheckout,
  ThreadCheckoutProvider,
  useFileExplorerStoreSelector,
} from '@brainstrike/file-explorer-ui/shell';
import { type ReactNode, useMemo } from 'react';

export function ThreadCheckoutBridge({ children }: { readonly children: ReactNode }) {
  const threadId = useAssistantThreadStore(
    (state) => state.selectedThreadByResourceId[WORKSPACE_MEMORY_RESOURCE_ID]
  );
  const metadata = useResourceThread(WORKSPACE_MEMORY_RESOURCE_ID, threadId)?.metadata;
  const operatingRootId = metadata?.operatingRootId;
  const worktreePath =
    metadata?.checkoutMode === 'worktree' ? (metadata.checkoutWorktreePath ?? null) : null;
  const worktreeRootId = metadata?.checkoutMode === 'worktree' ? (operatingRootId ?? null) : null;
  const localRootId = metadata?.checkoutLocalRootId ?? null;
  const checkout = useMemo<ThreadCheckout | null>(
    () => (worktreeRootId ? { localRootId, worktreeRootId } : null),
    [localRootId, worktreeRootId]
  );
  // The header reads `<project> · <checkout>`, as the composer's where-control does closed: the
  // project is the thread's folder, or in a worktree its Local folder. While that folder is not
  // open, the header keeps the folder's own name.
  const projectRootId = worktreePath ? localRootId : operatingRootId;
  const project = useFileExplorerStoreSelector((state) =>
    projectRootId ? state.rootDescriptors[projectRootId]?.displayName : undefined
  );
  const header =
    operatingRootId && project
      ? { label: `${project} · ${checkoutName(worktreePath)}`, rootId: operatingRootId }
      : null;
  return (
    <ThreadCheckoutProvider checkout={checkout} header={header}>
      {children}
    </ThreadCheckoutProvider>
  );
}
