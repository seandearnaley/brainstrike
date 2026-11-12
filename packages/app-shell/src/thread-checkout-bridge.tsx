/**
 * ADR-0034: the Explorer follows the active thread. When the selected workspace thread works in
 * a worktree, the Explorer shows that worktree in place of the folder it was made from, and the
 * header of the folder the thread works in names its checkout (decision 3), and its control opens
 * the composer's where-control while one is shown. A thread working in the scratch folder the
 * host made for it shows that folder, which is no open folder, and no other thread's. While no
 * thread is selected the new-thread composer is the active thread, so its draft's folders are
 * followed.
 */
import { checkoutName } from '@brainstrike/assistant-contract/thread-checkout-name';
import {
  newThreadId,
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
import {
  requestWhereControlOpen,
  useWhereControlRequests,
} from './workspace-bar/where-control-requests';

export function ThreadCheckoutBridge({ children }: { readonly children: ReactNode }) {
  const threadId = useAssistantThreadStore(
    (state) =>
      state.selectedThreadByResourceId[WORKSPACE_MEMORY_RESOURCE_ID] ??
      newThreadId(WORKSPACE_MEMORY_RESOURCE_ID)
  );
  const metadata = useResourceThread(WORKSPACE_MEMORY_RESOURCE_ID, threadId)?.metadata;
  const operatingRootId = metadata?.operatingRootId;
  const worktreePath =
    metadata?.checkoutMode === 'worktree' ? (metadata.checkoutWorktreePath ?? null) : null;
  const worktreeRootId = metadata?.checkoutMode === 'worktree' ? (operatingRootId ?? null) : null;
  const scratch = useFileExplorerStoreSelector((state) =>
    operatingRootId ? state.rootDescriptors[operatingRootId]?.scratch === true : false
  );
  const threadRootId = worktreeRootId ?? (scratch ? (operatingRootId ?? null) : null);
  const localRootId = metadata?.checkoutLocalRootId ?? null;
  const checkout = useMemo<ThreadCheckout | null>(
    () => (threadRootId ? { localRootId, threadRootId } : null),
    [localRootId, threadRootId]
  );
  // The header reads `<project> · <checkout>`, as the composer's where-control does closed: the
  // project is the thread's folder, or in a worktree its Local folder. While that folder is not
  // open, the header keeps the folder's own name.
  const projectRootId = worktreePath ? localRootId : operatingRootId;
  const project = useFileExplorerStoreSelector((state) =>
    projectRootId ? state.rootDescriptors[projectRootId]?.displayName : undefined
  );
  const whereControlShown = useWhereControlRequests((state) => (state.shown[threadId] ?? 0) > 0);
  const header =
    operatingRootId && project
      ? {
          changeCheckout: whereControlShown ? () => requestWhereControlOpen(threadId) : null,
          label: `${project} · ${checkoutName(worktreePath)}`,
          rootId: operatingRootId,
        }
      : null;
  return (
    <ThreadCheckoutProvider checkout={checkout} header={header}>
      {children}
    </ThreadCheckoutProvider>
  );
}
