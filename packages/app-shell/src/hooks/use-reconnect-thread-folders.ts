/**
 * Opening a thread reconnects its folders. A folder the thread works in that the workspace no
 * longer has open (another folder was opened in its place, or it was disconnected) is mounted
 * again by its path. The host allows that only for a folder it has recorded, granted before
 * (Recents) or a managed worktree, so nothing new is granted here.
 *
 * A thread names its folders by their records. When a folder's record is gone (a record the
 * app deleted with its data) and the folder at the thread's path is recorded afresh, the thread
 * follows it to that record. A thread working in a worktree also records which one. When the app has lost its record of
 * that worktree while the checkout is intact, the record is written again under the same id
 * before the worktree mounts, so the thread opens as it was left and its runs are admitted.
 *
 * Only the opening does this: the folders are read once, when the thread's folders are known. A
 * folder the person disconnects while the thread stays open stays disconnected. One that cannot
 * come back (never granted here, or gone from disk) keeps the folder chip's Removed state with
 * its Re-add action. That chip is where the person sees it, so no toast interrupts each opening
 * of the thread with the same news.
 */
import { describeBoundaryFailure } from '@brainstrike/assistant-contract/boundary-failure';
import type { WorkspaceBarRoot } from '@brainstrike/assistant-ui';
import { createLogger } from '@brainstrike/logging';
import { useEffect, useRef } from 'react';
import { markThreadFoldersReopening } from '../roots/thread-folders-reopening';
import { useWorktreesBridge } from '../workspace-git-services';
import type { WorktreesBridge } from '../worktrees/worktrees-bridge';

const logger = createLogger('WorkspaceBar');

interface UseReconnectThreadFoldersArgs {
  /** Mounts a folder granted before, by path; absent where the platform cannot. */
  readonly addRootByPath: ((path: string) => Promise<unknown>) | undefined;
  readonly describeFailure: (error: unknown) => string;
  /**
   * Points the thread at the record its primary folder is open under now, when that is not the
   * record the thread names (the old one is gone). A no-op when they agree.
   */
  readonly followPrimaryRecord: (
    root: WorkspaceBarRoot & { readonly path: string }
  ) => Promise<void>;
  readonly primaryRoot: WorkspaceBarRoot | undefined;
  /** False while the thread's folders are still being read: a missing folder is not yet known. */
  readonly ready: boolean;
  readonly secondaryRoots: readonly WorkspaceBarRoot[];
  /** The thread whose tab is in front; undefined while this thread's tab is behind another. */
  readonly threadId: string | undefined;
  /** The worktree the thread works in, as its binding records it; undefined in Local mode. */
  readonly worktree: ThreadWorktree | undefined;
}

interface ThreadWorktree {
  readonly id: string;
  readonly path: string;
}

/**
 * Writes the app's record of the thread's worktree again, under the id the thread names. The
 * usual answer is a refusal because the app still records it; any other refusal is logged and
 * the mount that follows reports the folder as it stands.
 */
async function recordThreadWorktree(
  worktrees: WorktreesBridge,
  worktree: ThreadWorktree,
  threadId: string
): Promise<void> {
  const result = await worktrees.adopt({
    createdBy: 'user',
    id: worktree.id,
    path: worktree.path,
    threadId,
  });
  if (result.ok) {
    logger.warn('Recorded a thread worktree the app had lost', {
      path: worktree.path,
      worktreeId: worktree.id,
    });
  } else if (result.error.code !== 'worktree.already-managed') {
    logger.info('A thread worktree stays unrecorded', {
      path: worktree.path,
      reason: describeBoundaryFailure(result.error),
      worktreeId: worktree.id,
    });
  }
}

export function useReconnectThreadFolders({
  addRootByPath,
  describeFailure,
  followPrimaryRecord,
  primaryRoot,
  ready,
  secondaryRoots,
  threadId,
  worktree,
}: UseReconnectThreadFoldersArgs): void {
  const worktrees = useWorktreesBridge();
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
    const reopened = markThreadFoldersReopening(threadId);
    void (async () => {
      // One at a time: the host orders folder changes anyway, and the last one keeps focus. The
      // thread's other folders mount first, so its worktree's repository is open when it is read.
      for (const root of missing) {
        try {
          if (worktrees && worktree && root === primaryRoot && root.path === worktree.path) {
            await recordThreadWorktree(worktrees, worktree, threadId);
          }
          await addRootByPath(root.path);
          if (root === primaryRoot) {
            await followPrimaryRecord(root);
          }
        } catch (error) {
          // The reason travels as text: the log buffer keeps only a summary of a large error.
          logger.info('A thread folder stays disconnected', {
            error,
            path: root.path,
            reason: describeFailure(error),
            rootId: root.rootId,
          });
        }
      }
    })().finally(reopened);
  }, [
    addRootByPath,
    describeFailure,
    followPrimaryRecord,
    primaryRoot,
    ready,
    secondaryRoots,
    threadId,
    worktree,
    worktrees,
  ]);
}
