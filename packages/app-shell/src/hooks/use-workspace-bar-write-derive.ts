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

/** Every field the write queue's per-dimension revision tracking distinguishes. */
export type FolderWriteIdentityField =
  | 'checkoutLocalRootId'
  | 'checkoutMode'
  | 'primaryRootId'
  | 'secondaryRootIds'
  | 'threadId';

export const FOLDER_WRITE_IDENTITY_FIELDS: readonly FolderWriteIdentityField[] = [
  'checkoutLocalRootId',
  'checkoutMode',
  'primaryRootId',
  'secondaryRootIds',
  'threadId',
];

function sameSecondaryRootIdSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const aIds = new Set(a);
  return b.every((id) => aIds.has(id));
}

/**
 * Which fields differ between two write-queue identity snapshots (BST-1400
 * item 2 v4 — per-dimension revisions). `secondaryRootIds` compares as a
 * SET — a resynced query result carries no ordering guarantee, and ordering
 * is not part of this set's identity — everything else by `===`.
 *
 * This is the primitive both halves of tail retirement are built on:
 * `recordLiveIdentity` (in `use-workspace-bar-write-tail-queue.ts`) calls it
 * on consecutive `threadFoldersRef` snapshots to decide which per-field
 * revision counters to bump, and `touchedFolderWriteFields` below calls it
 * to decide which fields a write's OWN derive actually changed. See that
 * queue's docblock for why retirement is asked per field rather than as one
 * "did anything change" question — v1 through v3 of this mechanism all
 * failed by collapsing the two.
 */
export function changedFolderWriteIdentityFields(
  a: FolderWriteIdentity,
  b: FolderWriteIdentity
): ReadonlySet<FolderWriteIdentityField> {
  const changed = new Set<FolderWriteIdentityField>();
  if (a.threadId !== b.threadId) {
    changed.add('threadId');
  }
  if (a.primaryRootId !== b.primaryRootId) {
    changed.add('primaryRootId');
  }
  if (a.checkoutMode !== b.checkoutMode) {
    changed.add('checkoutMode');
  }
  if (a.checkoutLocalRootId !== b.checkoutLocalRootId) {
    changed.add('checkoutLocalRootId');
  }
  if (!sameSecondaryRootIdSet(a.secondaryRootIds, b.secondaryRootIds)) {
    changed.add('secondaryRootIds');
  }
  return changed;
}

/**
 * Which identity fields a queued write's own `request` actually changed,
 * relative to the `current` it derived from — the "touched" set
 * `settleWrite` records so retirement can ask "has the ref caught up on
 * EVERY dimension THIS write changed?" instead of "has the ref moved for
 * any reason at all?" (BST-1400 item 2 v4). `threadId` is deliberately
 * never touched by a write's own derive (a write's thread is fixed context,
 * not something it changes) — a thread switch is handled as its own
 * retirement hatch, not through this set.
 */
export function touchedFolderWriteFields(
  current: ThreadCheckoutFolders,
  request: ThreadCheckoutWrite,
  persistedMode: 'local' | 'worktree'
): ReadonlySet<FolderWriteIdentityField> {
  return changedFolderWriteIdentityFields(folderWriteIdentityOf(current), {
    checkoutLocalRootId: request.checkoutLocalRootId,
    checkoutMode: persistedMode,
    primaryRootId: request.primaryRootId,
    secondaryRootIds: request.ids,
    threadId: current.threadId,
  });
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
  if (next?.removed) {
    throw new Error(
      `${next.displayName} was removed from the workspace. Re-add it before making it primary.`
    );
  }
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
  // BST-1990: a removed folder is dropped in this same write, never demoted or
  // kept, because the host refuses any binding that still names one.
  const removed = removedRootIds(current);
  const demotesPrimary = Boolean(
    current.primaryRootId && current.primaryRootId !== rootId && !removed.has(current.primaryRootId)
  );
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
  const kept = (id: string): boolean => id !== rootId && !removed.has(id);
  const secondaryRoots = [
    ...current.secondaryRoots.filter((root) => kept(root.rootId)),
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
    ids: [...current.secondaryRootIds.filter(kept), ...demoted.map((root) => root.rootId)],
    primaryRoot: { ...next, path: nextPath },
    primaryRootId: rootId,
    secondaryRoots,
  };
}

/** Every thread folder the workspace no longer serves (BST-1990). */
function removedRootIds(current: ThreadCheckoutFolders): ReadonlySet<string> {
  return new Set(
    [current.primaryRoot, ...current.secondaryRoots].flatMap((root) =>
      root?.removed ? [root.rootId] : []
    )
  );
}

/** The binding keys that make `root` the thread's operating folder. */
function operatingRootBinding(root: ThreadCheckoutRoot & { readonly path: string }) {
  return {
    operatingRootDisplayName: root.displayName,
    operatingRootId: root.rootId,
    operatingRootPath: root.path,
  };
}

/** Why the hand-off return folder keeps its Remove action disabled (BST-1456). */
export const HAND_OFF_RETURN_ROOT_REMOVE_REASON = 'This folder is where Hand off returns to.';

/** Why a removed primary keeps its Remove action disabled. */
export const REMOVED_PRIMARY_NEEDS_ANOTHER_FOLDER = 'Choose another folder for this thread first.';

/**
 * "Remove from this thread" (BST-1990). It drops the chosen folder and every
 * removed one in the same write, because the host refuses a binding that keeps
 * any. Only a removed primary can be removed: the first live secondary takes its
 * place. Leaving the hand-off return folder or the worktree primary takes the
 * thread back to Local in the same write, as a hand-off does.
 */
export function deriveRemoveFromThread(
  current: ThreadCheckoutFolders,
  rootId: string
): ThreadCheckoutWrite {
  const removed = removedRootIds(current);
  const dropped = new Set([...removed, rootId]);
  let promoted: (ThreadCheckoutRoot & { readonly path: string }) | undefined;
  if (rootId === current.primaryRootId) {
    if (!current.primaryRoot?.removed) {
      throw new Error('The primary folder stays; make another folder primary first.');
    }
    const next = current.secondaryRoots.find((root) => !dropped.has(root.rootId) && root.path);
    if (!next?.path) {
      throw new Error(REMOVED_PRIMARY_NEEDS_ANOTHER_FOLDER);
    }
    promoted = { ...next, path: next.path };
  } else if (
    current.checkoutMode === 'worktree' &&
    current.checkoutLocalRootId === rootId &&
    !removed.has(rootId)
  ) {
    throw new Error(HAND_OFF_RETURN_ROOT_REMOVE_REASON);
  }
  const keep = (id: string): boolean => !dropped.has(id) && id !== promoted?.rootId;
  const backToLocal =
    current.checkoutMode === 'worktree' &&
    (promoted !== undefined ||
      (current.checkoutLocalRootId !== undefined && dropped.has(current.checkoutLocalRootId)));
  const binding = {
    ...(backToLocal ? { checkoutMode: 'local' } : {}),
    ...(promoted ? operatingRootBinding(promoted) : {}),
  };
  return {
    ...(Object.keys(binding).length > 0 ? { binding } : {}),
    checkoutLocalRootId: backToLocal ? undefined : current.checkoutLocalRootId,
    ids: current.secondaryRootIds.filter(keep),
    primaryRoot: promoted ?? current.primaryRoot,
    primaryRootId: promoted?.rootId ?? current.primaryRootId,
    secondaryRoots: current.secondaryRoots.filter((root) => keep(root.rootId)),
  };
}

/**
 * "Use another folder…" (BST-1990): a thread with no live folder takes a
 * mounted workspace folder as its primary, dropping its removed folders in the
 * same write. While any thread folder is live, Make primary is the action.
 */
export function deriveUseFolder(
  current: ThreadCheckoutFolders,
  root: ThreadCheckoutRoot & { readonly path: string }
): ThreadCheckoutWrite {
  const live = [current.primaryRoot, ...current.secondaryRoots].some(
    (folder) => folder && !folder.removed
  );
  if (live) {
    throw new Error('This thread still has a live folder; make it primary instead.');
  }
  const leavesWorktree = current.checkoutMode === 'worktree';
  return {
    binding: {
      ...(leavesWorktree ? { checkoutMode: 'local' } : {}),
      ...operatingRootBinding(root),
    },
    checkoutLocalRootId: undefined,
    ids: [],
    primaryRoot: root,
    primaryRootId: root.rootId,
    secondaryRoots: [],
  };
}
