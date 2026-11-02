/**
 * Opening a thread reconnects its folders. A folder the thread works in that the workspace no
 * longer has open (another folder was opened in its place, or it was disconnected) is mounted
 * again by its path. The host allows that only for a folder granted before (Recents) or a
 * managed worktree, so nothing new is granted here.
 *
 * Only the opening does this: the folders are read once, when the thread's folders are known. A
 * folder the person disconnects while the thread stays open stays disconnected, and one that
 * cannot come back keeps the folder chip's Removed state with its Re-add action, and a toast
 * says why.
 */
import type { WorkspaceBarRoot } from '@brainstrike/assistant-ui';
import { createLogger } from '@brainstrike/logging';
import { toast } from '@brainstrike/ui';
import { useEffect, useRef } from 'react';

const logger = createLogger('WorkspaceBar');

interface UseReconnectThreadFoldersArgs {
  /** Mounts a folder granted before, by path; absent where the platform cannot. */
  readonly addRootByPath: ((path: string) => Promise<unknown>) | undefined;
  readonly describeFailure: (error: unknown) => string;
  readonly primaryRoot: WorkspaceBarRoot | undefined;
  /** False while the thread's folders are still being read: a missing folder is not yet known. */
  readonly ready: boolean;
  readonly secondaryRoots: readonly WorkspaceBarRoot[];
  /** The thread whose tab is in front; undefined while this thread's tab is behind another. */
  /** The thread whose tab is in front; undefined while this thread's tab is behind another. */
  readonly threadId: string | undefined;
}

export function useReconnectThreadFolders({
  addRootByPath,
  describeFailure,
  primaryRoot,
  ready,
  secondaryRoots,
  threadId,
}: UseReconnectThreadFoldersArgs): void {
  // The thread in front, and whether its opening was handled. Bringing another thread's tab (or a
  // new chat) to the front starts afresh, so returning to a thread reconnects a folder that left in
  // the meantime.
  const openingRef = useRef<{ handled: boolean; threadId: string | undefined }>({
    handled: false,
    threadId: undefined,
  });
  useEffect(() => {
    if (openingRef.current.threadId !== threadId) {
      openingRef.current = { handled: false, threadId };
    }
    if (!(ready && threadId && addRootByPath) || openingRef.current.handled) {
      return;
    }
    openingRef.current.handled = true;
    // The primary goes last, so it is the folder the Explorer ends on.
    const missing = [...secondaryRoots, ...(primaryRoot ? [primaryRoot] : [])].filter(
      (root): root is WorkspaceBarRoot & { readonly path: string } =>
        root.removed === true && Boolean(root.path)
    );
    if (missing.length === 0) {
      return;
    }
    void (async () => {
      // One at a time: the host orders folder changes anyway, and the last one keeps focus.
      for (const root of missing) {
        try {
          await addRootByPath(root.path);
        } catch (error) {
          logger.warn('A thread folder could not be reconnected', { error, rootId: root.rootId });
          toast({
            description: describeFailure(error),
            title: `Couldn't reconnect ${root.displayName}`,
            variant: 'destructive',
          });
        }
      }
    })();
  }, [addRootByPath, describeFailure, primaryRoot, ready, secondaryRoots, threadId]);
}
