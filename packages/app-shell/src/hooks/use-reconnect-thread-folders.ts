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
import { useEffect, useEffectEvent, useRef } from 'react';
import { subscribeRootRegistered } from '../roots/root-registration-events';
import { markThreadFoldersReopening } from '../roots/thread-folders-reopening';
import { useWorktreesBridge } from '../workspace-git-services';
import type { WorktreesBridge } from '../worktrees/worktrees-bridge';
import { handOffRecordGone } from './use-workspace-bar-write-derive';

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
    root: WorkspaceBarRoot & { readonly path: string },
    localRootPath: string | undefined
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
  /** The folder a hand-off returns to, by the record the binding names. */
  readonly localRootId: string | undefined;
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

/**
 * The folder of the repository the worktree belongs to: where a hand-off returns. The thread
 * records it by id only, so when that record is gone the repository is found again from git.
 */
async function worktreeRepositoryRoot(
  worktrees: WorktreesBridge,
  worktree: ThreadWorktree
): Promise<string | undefined> {
  const listed = await worktrees.list();
  if (!listed.ok) {
    logger.warn("A thread worktree's repository could not be read", {
      path: worktree.path,
      reason: describeBoundaryFailure(listed.error),
    });
    return undefined;
  }
  return listed.value.find((entry) => entry.path === worktree.path)?.repositoryRoot;
}

/** Mounts the primary, recording its worktree first and following both to their records. */
async function reopenPrimary(
  args: ReopenThreadFoldersArgs,
  root: WorkspaceBarRoot & { readonly path: string }
): Promise<void> {
  const own = args.worktree?.worktree.path === root.path ? args.worktree : undefined;
  if (own) {
    await recordThreadWorktree(own.worktrees, own.worktree, args.threadId);
  }
  // When the record of the folder a hand-off returns to is gone, the repository stands in for it.
  // It opens first, so the Explorer ends on the thread's own folder.
  const localRecordGone =
    own !== undefined && handOffRecordGone(args.secondaryRoots, own.worktree.localRootId);
  const localRootPath = localRecordGone
    ? await worktreeRepositoryRoot(own.worktrees, own.worktree)
    : undefined;
  if (localRootPath) {
    await args.addRootByPath(localRootPath);
  }
  await args.addRootByPath(root.path);
  await args.followPrimaryRecord(root, localRootPath);
}

interface ReopenThreadFoldersArgs {
  readonly addRootByPath: (path: string) => Promise<unknown>;
  readonly describeFailure: (error: unknown) => string;
  readonly followPrimaryRecord: UseReconnectThreadFoldersArgs['followPrimaryRecord'];
  readonly missing: readonly (WorkspaceBarRoot & { readonly path: string })[];
  readonly primaryRoot: WorkspaceBarRoot | undefined;
  readonly secondaryRoots: readonly WorkspaceBarRoot[];
  readonly threadId: string;
  readonly worktree:
    | { readonly worktree: ThreadWorktree; readonly worktrees: WorktreesBridge }
    | undefined;
}

/**
 * One at a time: the host orders folder changes anyway, and the last one keeps focus. The
 * thread's other folders mount first, so its worktree's repository is open when it is read.
 * Resolves to the paths of the folders that stay disconnected.
 */
async function reopenThreadFolders(args: ReopenThreadFoldersArgs): Promise<readonly string[]> {
  const unopened: string[] = [];
  for (const root of args.missing) {
    try {
      if (root === args.primaryRoot) {
        await reopenPrimary(args, root);
      } else {
        await args.addRootByPath(root.path);
      }
    } catch (error) {
      unopened.push(root.path);
      // The reason travels as text: the log buffer keeps only a summary of a large error.
      logger.warn('A thread folder stays disconnected', {
        error,
        path: root.path,
        reason: args.describeFailure(error),
        rootId: root.rootId,
      });
    }
  }
  return unopened;
}

interface ThreadOpening {
  handled: boolean;
  readonly threadId: string | undefined;
  /** Folders this opening could not reopen: a folder opened since may be what they need. */
  unopened: ReadonlySet<string>;
}

const NOTHING_UNOPENED: ReadonlySet<string> = new Set();

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
  const openingRef = useRef<ThreadOpening>({
    handled: false,
    threadId: undefined,
    unopened: NOTHING_UNOPENED,
  });
  // `only` limits the reopening to the folders an earlier try left disconnected.
  const reopen = useEffectEvent((only?: ReadonlySet<string>): void => {
    if (!(threadId && addRootByPath)) {
      return;
    }
    // The primary goes last, so it is the folder the Explorer ends on.
    const missing = [...secondaryRoots, ...(primaryRoot ? [primaryRoot] : [])].filter(
      (root): root is WorkspaceBarRoot & { readonly path: string } =>
        root.removed === true && Boolean(root.path) && (!only || only.has(root.path ?? ''))
    );
    if (missing.length === 0) {
      return;
    }
    const opening = openingRef.current;
    opening.unopened = NOTHING_UNOPENED;
    const reopened = markThreadFoldersReopening(threadId);
    void reopenThreadFolders({
      addRootByPath,
      describeFailure,
      followPrimaryRecord,
      missing,
      primaryRoot,
      secondaryRoots,
      threadId,
      worktree: worktree && worktrees ? { worktree, worktrees } : undefined,
    })
      .then((unopened) => {
        opening.unopened = new Set(unopened);
      })
      .finally(reopened);
  });
  useEffect(() => {
    if (openingRef.current.threadId !== threadId) {
      openingRef.current = { handled: false, threadId, unopened: NOTHING_UNOPENED };
    }
    if (!(ready && threadId && addRootByPath) || openingRef.current.handled) {
      return;
    }
    openingRef.current.handled = true;
    reopen();
  }, [addRootByPath, ready, threadId]);
  // A folder that could not reopen may need another one open first: a worktree whose record is
  // gone is recorded again only once its repository is open. So each folder the person opens
  // while this thread is in front gives the folders it left disconnected another go. A folder the
  // person disconnects later is not among them, so it stays disconnected.
  const reopenUnopened = useEffectEvent((): void => {
    const { unopened } = openingRef.current;
    if (unopened.size > 0) {
      reopen(unopened);
    }
  });
  useEffect(() => subscribeRootRegistered(() => reopenUnopened()), []);
}
