/**
 * BST-1990 PR 3: the workspace bar's side of the Files cards' thread notice.
 * It publishes the selected thread's folders (the binding's operating folder
 * and its secondaries — exactly the folders a run executes in), and applies a
 * card's one-shot "Add to this thread" request through the bar's own
 * add-secondary write. There is no second write path.
 */
import { useThreadFolderScopeStore } from '@brainstrike/file-explorer-ui/thread-folder-scope-store';
import { createLogger } from '@brainstrike/logging';
import { toast } from '@brainstrike/ui';
import { useEffect } from 'react';

const logger = createLogger('ThreadFolderScope');

export interface UseThreadFolderScopeArgs {
  /** The thread's bound operating folder; undefined while it has no binding. */
  readonly bindingRootId: string | undefined;
  readonly foldersPending: boolean;
  readonly recordAddedAsSecondary: (handle: {
    readonly name: string;
    readonly path: string;
  }) => Promise<void>;
  readonly secondaryRootIds: readonly string[];
  readonly threadId: string | undefined;
}

export function useThreadFolderScope({
  bindingRootId,
  foldersPending,
  recordAddedAsSecondary,
  secondaryRootIds,
  threadId,
}: UseThreadFolderScopeArgs): void {
  const publishScope = useThreadFolderScopeStore((state) => state.publishScope);
  useEffect(() => {
    // Without a binding a run executes in every live folder: nothing is outside.
    if (!(threadId && bindingRootId)) {
      publishScope(null);
      return;
    }
    publishScope({ rootIds: [bindingRootId, ...secondaryRootIds], threadId });
    return () => {
      publishScope(null);
    };
  }, [bindingRootId, publishScope, secondaryRootIds, threadId]);

  const pendingAdd = useThreadFolderScopeStore((state) => state.pendingAdd);
  const consumeAdd = useThreadFolderScopeStore((state) => state.consumeAdd);
  useEffect(() => {
    if (!threadId || foldersPending || pendingAdd?.threadId !== threadId) {
      return;
    }
    const request = consumeAdd(threadId);
    if (!request) {
      return;
    }
    recordAddedAsSecondary({ name: request.displayName, path: request.path }).catch(
      (error: unknown) => {
        logger.error('Add to this thread failed', { error, rootId: request.rootId, threadId });
        toast({
          description: error instanceof Error ? error.message : String(error),
          title: 'Add to this thread failed',
          variant: 'destructive',
        });
      }
    );
  }, [consumeAdd, foldersPending, pendingAdd, recordAddedAsSecondary, threadId]);
}
