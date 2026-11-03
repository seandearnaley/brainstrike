/**
 * A thread names its folders by their records. When a folder reopens under another record than
 * the one the thread names (the old record is gone), the thread follows it there in one write.
 */
import type { WorkspaceBarRoot } from '@brainstrike/assistant-ui';
import { createLogger } from '@brainstrike/logging';
import { useCallback } from 'react';
import { displayNameForPath } from './use-thread-checkout';
import type { ThreadCheckoutFolders, ThreadCheckoutWrite } from './use-thread-folders-write';
import { deriveRecordedPrimary } from './use-workspace-bar-write-derive';

const logger = createLogger('WorkspaceBar');

export function useFollowPrimaryRecord({
  checkoutLocalRootId,
  enqueueThreadFoldersWrite,
  resolveRootIdForPath,
  selectedMemoryThreadId,
  worktree,
}: {
  readonly checkoutLocalRootId: string | undefined;
  /** The worktree the thread works in, as its binding records it; undefined in Local mode. */
  readonly worktree: { readonly id: string; readonly path: string } | undefined;
  readonly enqueueThreadFoldersWrite: (
    threadId: string | undefined,
    derive: (current: ThreadCheckoutFolders) => ThreadCheckoutWrite | null
  ) => Promise<void>;
  readonly resolveRootIdForPath: (path: string, displayName: string) => Promise<string>;
  readonly selectedMemoryThreadId: string | undefined;
}): (
  root: WorkspaceBarRoot & { readonly path: string },
  localRootPath: string | undefined
) => Promise<void> {
  return useCallback(
    async (root, localRootPath) => {
      const rootId = await resolveRootIdForPath(root.path, root.displayName);
      const localName = localRootPath ? displayNameForPath(localRootPath) : undefined;
      const localRoot =
        localRootPath && localName && worktree
          ? {
              displayName: localName,
              path: localRootPath,
              rootId: await resolveRootIdForPath(localRootPath, localName),
            }
          : undefined;
      if (rootId === root.rootId && (!localRoot || localRoot.rootId === checkoutLocalRootId)) {
        return;
      }
      logger.warn("A thread follows its folders to the records they're open under now", {
        localRootId: localRoot?.rootId,
        path: root.path,
        previousRootId: root.rootId,
        rootId,
      });
      await enqueueThreadFoldersWrite(selectedMemoryThreadId, (current) =>
        deriveRecordedPrimary(
          current,
          { displayName: root.displayName, path: root.path, rootId },
          localRoot && worktree ? { root: localRoot, worktree } : undefined
        )
      );
    },
    [
      checkoutLocalRootId,
      enqueueThreadFoldersWrite,
      resolveRootIdForPath,
      selectedMemoryThreadId,
      worktree,
    ]
  );
}
