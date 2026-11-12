import { pathFolderName } from '@brainstrike/assistant-contract/thread-checkout-name';
import type { AssistantThreadMetadata } from '@brainstrike/assistant-data';
import { createLogger } from '@brainstrike/logging';
import { toast } from '@brainstrike/ui';
import { useMemo } from 'react';
import type { ThreadCheckoutFolders, ThreadCheckoutWrite } from './use-thread-folders-write';

const logger = createLogger('ThreadCheckout');

export interface ThreadCheckoutState {
  readonly branch: string | null;
  readonly mode: 'local' | 'worktree';
  readonly worktreeId: string | null;
  readonly worktreePath: string | null;
}

export interface UseThreadCheckoutArgs {
  readonly enqueueThreadFoldersWrite: (
    startedForThreadId: string | undefined,
    derive: (current: ThreadCheckoutFolders) => ThreadCheckoutWrite | null
  ) => Promise<void>;
  /** Resolves the durable `roots.id` for a just-mounted path. REJECTS (never resolves
   * to a sentinel) if the row never reconciles — a worktree root that never landed
   * must fail visibly, not persist a binding the server would later reject with
   * `bound_workspace_root_unavailable`. */
  readonly resolveRootIdForPath: (path: string, displayName: string) => Promise<string>;
  readonly selectedMemoryThreadId: string | undefined;
  readonly threadMetadata: AssistantThreadMetadata | undefined;
}

/** A worktree folder's display name: its checkout's name (`swift-badger`), which every surface shows. */
export function displayNameForPath(path: string): string {
  const displayName = pathFolderName(path);
  if (!displayName) {
    throw new Error(`Cannot check out a worktree whose path has no display name: ${path}`);
  }
  return displayName;
}

interface CheckoutRoot {
  readonly displayName: string;
  readonly path: string;
  readonly rootId: string;
}

/**
 * The folders a move into a worktree keeps among the thread's folders: its old primary, or, for a
 * thread with no folder, the named Local folder, so a hand-off finds it there.
 */
function foldersLeftBehind(
  current: ThreadCheckoutFolders,
  worktreeRootId: string,
  localRoot: CheckoutRoot | undefined,
  checkoutLocalRootId: string
): readonly CheckoutRoot[] {
  if (current.primaryRootId === undefined) {
    return localRoot?.rootId === checkoutLocalRootId && localRoot ? [localRoot] : [];
  }
  const primaryPath = current.primaryRoot?.path;
  return current.primaryRootId !== worktreeRootId && current.primaryRoot && primaryPath
    ? [{ ...current.primaryRoot, path: primaryPath }]
    : [];
}
export function useThreadCheckout(args: UseThreadCheckoutArgs): {
  readonly checkout: ThreadCheckoutState;
  readonly handOffToLocal: () => Promise<void>;
  /** The Local root a hand-off would return to, when the thread is currently checked
   * out into a worktree — `null` in Local mode (nothing to "return to") or when no
   * such root was ever recorded. */
  readonly localRootId: string | null;
  readonly selectWorktree: (worktree: {
    readonly branch: string | null;
    /** The repository's open folder, which a thread with no folder returns to on hand-off. */
    readonly localRoot?: {
      readonly displayName: string;
      readonly path: string;
      readonly rootId: string;
    };
    readonly path: string;
    readonly worktreeId: string;
  }) => Promise<void>;
} {
  const {
    enqueueThreadFoldersWrite,
    resolveRootIdForPath,
    selectedMemoryThreadId,
    threadMetadata,
  } = args;
  const checkout = useMemo<ThreadCheckoutState>(
    () => ({
      branch: threadMetadata?.checkoutBranch ?? null,
      mode: threadMetadata?.checkoutMode ?? 'local',
      worktreeId: threadMetadata?.checkoutWorktreeId ?? null,
      worktreePath: threadMetadata?.checkoutWorktreePath ?? null,
    }),
    [
      threadMetadata?.checkoutMode,
      threadMetadata?.checkoutBranch,
      threadMetadata?.checkoutWorktreeId,
      threadMetadata?.checkoutWorktreePath,
    ]
  );
  const localRootId =
    checkout.mode === 'worktree' ? (threadMetadata?.checkoutLocalRootId ?? null) : null;

  const selectWorktree = async (worktree: {
    readonly branch: string | null;
    readonly localRoot?: {
      readonly displayName: string;
      readonly path: string;
      readonly rootId: string;
    };
    readonly path: string;
    readonly worktreeId: string;
  }) => {
    const displayName = displayNameForPath(worktree.path);
    const rootId = await resolveRootIdForPath(worktree.path, displayName);
    await enqueueThreadFoldersWrite(selectedMemoryThreadId, (current) => {
      // Preserve the original Local root across worktree-to-worktree switches;
      // only a transition from Local establishes a new one. A thread with no
      // folder returns to the repository's open folder the caller named.
      const rawLocalRootId =
        current.checkoutLocalRootId ?? current.primaryRootId ?? worktree.localRoot?.rootId;
      // A local root that resolves to the WORKTREE we are switching into is
      // degenerate (BST-1390): it happens after "Folder didn't follow" hands
      // off without ever recording a real Local root (leaving `primaryRootId`
      // still pointing at the worktree), followed by re-selecting that SAME
      // worktree. Recording it as "the Local root to return to" would make a
      // later hand-off return to the worktree itself. Refuse it explicitly so
      // the user sees how to recover instead of the generic missing-root copy.
      if (rawLocalRootId === rootId) {
        const message =
          "You're already in this worktree and no Local folder is recorded — add a folder first.";
        logger.error(message, {
          primaryRootId: current.primaryRootId,
          worktreeId: worktree.worktreeId,
        });
        throw new Error(message);
      }
      const checkoutLocalRootId = rawLocalRootId;
      if (!checkoutLocalRootId) {
        logger.error('Select worktree: current primary root id is unknown', {
          primaryRootId: current.primaryRootId,
          worktreeId: worktree.worktreeId,
        });
        throw new Error(
          'Could not switch worktrees: the current primary folder is no longer available.'
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
        logger.error(
          'Select worktree: current primary root record is missing, stale, or has no path',
          {
            primaryRootId: current.primaryRootId,
            worktreeId: worktree.worktreeId,
          }
        );
        throw new Error(
          'Could not switch worktrees: the current primary folder is no longer available.'
        );
      }
      const demoted = foldersLeftBehind(current, rootId, worktree.localRoot, checkoutLocalRootId);
      const nextRoot = { displayName, path: worktree.path, rootId };
      const secondaryRoots = [
        ...current.secondaryRoots.filter((root) => root.rootId !== rootId),
        ...demoted,
      ];
      return {
        binding: {
          ...(worktree.branch ? { checkoutBranch: worktree.branch } : {}),
          checkoutLocalRootId,
          checkoutMode: 'worktree',
          checkoutWorktreeId: worktree.worktreeId,
          checkoutWorktreePath: worktree.path,
          operatingRootDisplayName: displayName,
          operatingRootId: rootId,
          operatingRootPath: worktree.path,
        },
        checkoutLocalRootId,
        ids: [
          ...current.secondaryRootIds.filter((id) => id !== rootId),
          ...demoted.map((root) => root.rootId),
        ],
        primaryRoot: nextRoot,
        primaryRootId: rootId,
        secondaryRoots,
      };
    });
  };

  const handOffToLocal = async () => {
    await enqueueThreadFoldersWrite(selectedMemoryThreadId, (current): ThreadCheckoutWrite => {
      const localId = current.checkoutLocalRootId;
      if (!localId) {
        logger.warn('Hand-off to Local has no recorded Local root; retaining the current folder');
        toast({
          description:
            'Thread is Local again, but its folder is still the worktree — add a folder to move it.',
          title: "Folder didn't follow",
        });
        return {
          binding: { checkoutMode: 'local' },
          checkoutLocalRootId: undefined,
          ids: current.secondaryRootIds,
          primaryRoot: current.primaryRoot,
          primaryRootId: current.primaryRootId,
          secondaryRoots: current.secondaryRoots,
        };
      }
      const localRoot = current.secondaryRoots.find((root) => root.rootId === localId);
      const localPath = localRoot?.path;
      if (!(localRoot && localPath)) {
        if (current.secondaryRootsError) {
          throw new Error('Folders failed to load — reopen the thread or restart to retry.');
        }
        if (current.secondaryRootsPending) {
          throw new Error('Folders are still loading — try again in a moment.');
        }
        logger.error('Hand off to local: remembered root is unknown or has no path', {
          rootId: localId,
        });
        throw new Error(
          `Could not hand off to Local: the tracked local folder (root ${localId}) is no longer available. Add it back as a folder to try again.`
        );
      }
      const secondaryRoots = current.secondaryRoots.filter((root) => root.rootId !== localId);
      return {
        binding: {
          checkoutMode: 'local',
          operatingRootDisplayName: localRoot.displayName,
          operatingRootId: localRoot.rootId,
          operatingRootPath: localPath,
        },
        checkoutLocalRootId: undefined,
        ids: current.secondaryRootIds.filter((id) => id !== localId),
        primaryRoot: { ...localRoot, path: localPath },
        primaryRootId: localRoot.rootId,
        secondaryRoots,
      };
    });
  };

  return { checkout, handOffToLocal, localRootId, selectWorktree };
}
