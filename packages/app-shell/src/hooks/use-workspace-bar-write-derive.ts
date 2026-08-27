/**
 * The workspace bar's write-queue derive logic, pulled out of
 * `use-workspace-bar.ts` purely to stay under Biome's file-line cap — every
 * export here is plain, hook-free logic already designed to be called from
 * (and unit-tested independently of) the hook. Keep it that way: nothing in
 * this file may import React or read component state directly.
 */
import { createLogger } from '@brainstrike/logging';
import type {
  ThreadCheckoutFolders,
  ThreadCheckoutRoot,
  ThreadCheckoutWrite,
} from './use-thread-folders-write';

const logger = createLogger('WorkspaceBar');

/** What a queued write persisted, for the next write in the queue to chain on. */
export interface ThreadFoldersWriteTail {
  readonly checkoutLocalRootId: string | undefined;
  readonly checkoutMode: 'local' | 'worktree';
  readonly ids: readonly string[];
  readonly primaryRoot: ThreadCheckoutRoot | undefined;
  readonly primaryRootId: string | undefined;
  readonly secondaryRoots: readonly ThreadCheckoutRoot[];
  /** The thread the ids belong to — they are meaningless for any other. */
  readonly threadId: string;
}

export interface ResolvedSecondaryRoots {
  readonly error: boolean;
  readonly key: string;
  readonly roots: readonly ThreadCheckoutRoot[];
}

export function secondaryRootsStatus(
  secondaryRootIds: readonly string[],
  secondaryRootIdsKey: string,
  resolvedSecondaries: ResolvedSecondaryRoots | null
): 'error' | 'pending' | 'ready' {
  if (secondaryRootIds.length === 0) {
    return 'ready';
  }
  if (resolvedSecondaries?.key !== secondaryRootIdsKey) {
    return 'pending';
  }
  return resolvedSecondaries.error ? 'error' : 'ready';
}

/**
 * A folder write raised before the selected thread's row reached the store.
 * Refusing is the same rule `persistThreadRootBinding` applies — an absent
 * folder set is indistinguishable from an empty one — but unlike a thread
 * switch the user asked for this, so it is logged and rejected for the
 * action-specific caller to surface.
 */
export function refuseWriteBeforeThreadMetadata(): never {
  logger.error('Cannot update thread folders before the selected thread metadata is loaded');
  throw new Error("This thread's folders have not loaded yet — try again in a moment.");
}

/**
 * The folder set a queued write derives its next value from. Only a tail from
 * THIS thread describes this write's starting point — the hook is long-lived,
 * so the ref outlives a thread switch and an unconditional chain would write
 * thread A's folder set onto thread B. A chained tail is never "pending": it
 * describes a write that already landed.
 */
export function writeStartingPoint(
  live: ThreadCheckoutFolders,
  tail: ThreadFoldersWriteTail | null,
  startedForThreadId: string
): ThreadCheckoutFolders {
  return tail?.threadId === startedForThreadId
    ? {
        checkoutLocalRootId: tail.checkoutLocalRootId,
        checkoutMode: tail.checkoutMode,
        metadataPending: false,
        primaryRoot: tail.primaryRoot,
        primaryRootId: tail.primaryRootId,
        secondaryRootIds: tail.ids,
        secondaryRoots: tail.secondaryRoots,
        secondaryRootsError: false,
        secondaryRootsPending: false,
        threadId: live.threadId,
      }
    : live;
}

/**
 * The write-queue-identity subset of a folder set: the fields a chained
 * write actually reads off `current`/a tail in `writeStartingPoint`, reduced
 * to ONE shape shared by `ThreadCheckoutFolders` (`threadFoldersRef`'s own
 * snapshots) and `ThreadFoldersWriteTail` (`ids` renamed to
 * `secondaryRootIds`) so both can be compared the same way.
 */
export interface FolderWriteIdentity {
  readonly checkoutLocalRootId: string | undefined;
  readonly checkoutMode: 'local' | 'worktree';
  readonly primaryRootId: string | undefined;
  readonly secondaryRootIds: readonly string[];
  // `undefined` for a `ThreadCheckoutFolders` snapshot taken with no thread
  // selected; a tail's `threadId` is always a real thread (see
  // `ThreadFoldersWriteTail`).
  readonly threadId: string | undefined;
}

export function folderWriteIdentityOf(live: ThreadCheckoutFolders): FolderWriteIdentity {
  return {
    checkoutLocalRootId: live.checkoutLocalRootId,
    checkoutMode: live.checkoutMode,
    primaryRootId: live.primaryRootId,
    secondaryRootIds: live.secondaryRootIds,
    threadId: live.threadId,
  };
}

/**
 * Identity equality between two write-queue snapshots (BST-1400 item 2).
 * `secondaryRootIds` compares as a SET — a resynced query result carries no
 * ordering guarantee, and ordering is not part of this set's identity —
 * everything else by `===`.
 *
 * This is the primitive the write queue's tail-retirement is built on (see
 * `retireWriteTailIfCaughtUp` in `use-workspace-bar.ts`): it is used to
 * detect that `threadFoldersRef` has genuinely MOVED since a write started,
 * not to check whether it moved to any one specific expected value.
 * Retiring only on an exact match against what a write itself persisted
 * (the original version of this fix) could not tell "hasn't caught up yet"
 * apart from "caught up to something ELSE" — a third-party change landing
 * before this write's own change propagated compared unequal to the tail
 * forever, pinning it, and the next same-thread write silently reverted the
 * third-party change. Comparing consecutive `threadFoldersRef` snapshots
 * instead — bumping a revision counter on any identity change, and retiring
 * once that counter has advanced past the value captured when the write
 * started — retires correctly in BOTH cases, because either way the ref no
 * longer needs help from a stale tail.
 */
export function sameFolderWriteIdentity(a: FolderWriteIdentity, b: FolderWriteIdentity): boolean {
  if (
    a.threadId !== b.threadId ||
    a.primaryRootId !== b.primaryRootId ||
    a.checkoutMode !== b.checkoutMode ||
    a.checkoutLocalRootId !== b.checkoutLocalRootId ||
    a.secondaryRootIds.length !== b.secondaryRootIds.length
  ) {
    return false;
  }
  const aIds = new Set(a.secondaryRootIds);
  return b.secondaryRootIds.every((id) => aIds.has(id));
}

/**
 * The `checkoutMode` a queued write actually persisted — `'local'` when the
 * write's own binding says so (an atomic make-primary-off-a-worktree switch,
 * or an explicit hand-off), otherwise unchanged from what the write started
 * from. Threaded onto the write-queue tail so a write chained on top of one
 * that just left worktree mode reads the CORRECT mode, not a stale one.
 */
export function persistedCheckoutMode(
  current: ThreadCheckoutFolders,
  request: ThreadCheckoutWrite
): 'local' | 'worktree' {
  const requested = request.binding?.['checkoutMode'];
  if (requested === 'local' || requested === 'worktree') {
    return requested;
  }
  return current.checkoutMode;
}

/**
 * Carries which of `deriveMakePrimary`'s two refusal branches fired, and the
 * root id it fired for, so `onMakePrimary`'s wrapper can reproduce the two
 * distinct `logger.error` calls the derive itself used to make inline —
 * without the pure function knowing about the logger.
 */
export class MakePrimaryDerivationError extends Error {
  readonly reason: 'current-primary' | 'secondary';
  readonly rootId: string | undefined;

  constructor(
    message: string,
    reason: 'current-primary' | 'secondary',
    rootId: string | undefined
  ) {
    super(message);
    this.name = 'MakePrimaryDerivationError';
    this.reason = reason;
    this.rootId = rootId;
  }
}

/**
 * Exported so both refusal branches are directly unit-testable without going
 * through `onMakePrimary`'s own swallowed `.catch`.
 *
 * Atomic worktree-to-Local switch (BST-1456): making a plain secondary
 * primary while the thread is checked out into a worktree leaves the thread
 * with no worktree left to be "checked out into" — `checkoutMode` must drop
 * to `'local'` in THIS SAME write, never a stray follow-up, or the chip
 * reads 'Worktree' with no worktree behind it. That also means the
 * worktree being left is never re-added as a secondary (there is nothing
 * to "return to" it FOR any more) and the hand-off-return `checkoutLocalRootId`
 * is cleared, matching a real hand-off.
 */
export function deriveMakePrimary(
  current: ThreadCheckoutFolders,
  rootId: string
): ThreadCheckoutWrite {
  const next = current.secondaryRoots.find((root) => root.rootId === rootId);
  const nextPath = next?.path;
  if (!(next && nextPath)) {
    if (current.secondaryRootsError) {
      throw new Error('Folders failed to load — reopen the thread or restart to retry.');
    }
    if (current.secondaryRootsPending) {
      throw new Error('Folders are still loading — try again in a moment.');
    }
    throw new MakePrimaryDerivationError(
      `Could not make primary: secondary root ${rootId} is unknown or has no path.`,
      'secondary',
      rootId
    );
  }
  const demotesPrimary = Boolean(current.primaryRootId && current.primaryRootId !== rootId);
  const currentPrimaryPath = current.primaryRoot?.path;
  if (
    demotesPrimary &&
    (!current.primaryRoot ||
      current.primaryRoot.rootId !== current.primaryRootId ||
      !currentPrimaryPath)
  ) {
    throw new MakePrimaryDerivationError(
      `Could not make primary: current primary root ${current.primaryRootId ?? '(unknown)'} is unknown or has no path.`,
      'current-primary',
      current.primaryRootId
    );
  }
  const leavesWorktree = current.checkoutMode === 'worktree';
  const demoted =
    !leavesWorktree && demotesPrimary && current.primaryRoot && currentPrimaryPath
      ? [{ ...current.primaryRoot, path: currentPrimaryPath }]
      : [];
  const secondaryRoots = [
    ...current.secondaryRoots.filter((root) => root.rootId !== rootId),
    ...demoted,
  ];
  return {
    binding: {
      ...(leavesWorktree ? { checkoutMode: 'local' } : {}),
      operatingRootDisplayName: next.displayName,
      operatingRootId: rootId,
      operatingRootPath: nextPath,
    },
    checkoutLocalRootId: leavesWorktree ? undefined : current.checkoutLocalRootId,
    ids: [
      ...current.secondaryRootIds.filter((id) => id !== rootId),
      ...demoted.map((root) => root.rootId),
    ],
    primaryRoot: { ...next, path: nextPath },
    primaryRootId: rootId,
    secondaryRoots,
  };
}
