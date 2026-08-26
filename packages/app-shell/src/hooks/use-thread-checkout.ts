import type { AssistantThreadMetadata } from '@brainstrike/assistant-data';
import { createLogger } from '@brainstrike/logging';
import { useCallback } from 'react';

const logger = createLogger('ThreadCheckout');

export interface ThreadCheckoutState {
  readonly mode: 'local' | 'worktree';
  readonly worktreeId: string | null;
  readonly worktreePath: string | null;
}

export interface ThreadCheckoutRoot {
  readonly displayName: string;
  readonly path?: string | undefined;
  readonly rootId: string;
}

export interface ThreadCheckoutFolders {
  readonly metadataPending: boolean;
  readonly primaryRoot: ThreadCheckoutRoot | undefined;
  readonly primaryRootId: string | undefined;
  readonly secondaryRootIds: readonly string[];
  readonly secondaryRoots: readonly ThreadCheckoutRoot[];
  readonly threadId: string | undefined;
}

export interface ThreadCheckoutWrite {
  readonly binding?: Record<string, string>;
  readonly ids: readonly string[];
  readonly primaryRoot: ThreadCheckoutRoot | undefined;
  readonly primaryRootId: string | undefined;
  readonly secondaryRoots: readonly ThreadCheckoutRoot[];
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

function displayNameForPath(path: string): string {
  const displayName = path.split(/[\\/]/u).filter(Boolean).at(-1);
  if (!displayName) {
    throw new Error(`Cannot check out a worktree whose path has no display name: ${path}`);
  }
  return displayName;
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
  const checkout: ThreadCheckoutState = {
    mode: threadMetadata?.checkoutMode ?? 'local',
    worktreeId: threadMetadata?.checkoutWorktreeId ?? null,
    worktreePath: threadMetadata?.checkoutWorktreePath ?? null,
  };
  const localRootId =
    checkout.mode === 'worktree' ? (threadMetadata?.secondaryRootIds?.[0] ?? null) : null;

  const selectWorktree = useCallback(
    async (worktree: {
      readonly branch: string | null;
      readonly path: string;
      readonly worktreeId: string;
    }) => {
      const displayName = displayNameForPath(worktree.path);
      const rootId = await resolveRootIdForPath(worktree.path, displayName);
      await enqueueThreadFoldersWrite(selectedMemoryThreadId, (current) => {
        const demotesPrimary = Boolean(current.primaryRootId && current.primaryRootId !== rootId);
        const currentPrimaryPath = current.primaryRoot?.path;
        if (
          demotesPrimary &&
          (!current.primaryRoot ||
            current.primaryRoot.rootId !== current.primaryRootId ||
            !currentPrimaryPath)
        ) {
          logger.error('Select worktree: current primary root is unknown or has no path', {
            primaryRootId: current.primaryRootId,
            worktreeId: worktree.worktreeId,
          });
          return null;
        }
        const demoted =
          demotesPrimary && current.primaryRoot && currentPrimaryPath
            ? [{ ...current.primaryRoot, path: currentPrimaryPath }]
            : [];
        const nextRoot = { displayName, path: worktree.path, rootId };
        return {
          binding: {
            ...(worktree.branch ? { checkoutBranch: worktree.branch } : {}),
            checkoutMode: 'worktree',
            checkoutWorktreeId: worktree.worktreeId,
            checkoutWorktreePath: worktree.path,
            operatingRootDisplayName: displayName,
            operatingRootId: rootId,
            operatingRootPath: worktree.path,
          },
          ids: [
            ...current.secondaryRootIds.filter((secondaryRootId) => secondaryRootId !== rootId),
            ...demoted.map((root) => root.rootId),
          ],
          primaryRoot: nextRoot,
          primaryRootId: rootId,
          secondaryRoots: [
            ...current.secondaryRoots.filter((root) => root.rootId !== rootId),
            ...demoted,
          ],
        };
      });
    },
    [enqueueThreadFoldersWrite, resolveRootIdForPath, selectedMemoryThreadId]
  );

  const handOffToLocal = useCallback(async () => {
    await enqueueThreadFoldersWrite(selectedMemoryThreadId, (current) => {
      const localId = current.secondaryRootIds[0];
      if (!localId) {
        return {
          binding: { checkoutMode: 'local' },
          ids: current.secondaryRootIds,
          primaryRoot: current.primaryRoot,
          primaryRootId: current.primaryRootId,
          secondaryRoots: current.secondaryRoots,
        };
      }
      const localRoot = current.secondaryRoots.find((root) => root.rootId === localId);
      const localPath = localRoot?.path;
      if (!(localRoot && localPath)) {
        logger.error('Hand off to local: remembered root is unknown or has no path', {
          rootId: localId,
        });
        return null;
      }
      return {
        binding: {
          checkoutMode: 'local',
          operatingRootDisplayName: localRoot.displayName,
          operatingRootId: localRoot.rootId,
          operatingRootPath: localPath,
        },
        ids: current.secondaryRootIds.filter((rootId) => rootId !== localId),
        primaryRoot: { ...localRoot, path: localPath },
        primaryRootId: localRoot.rootId,
        secondaryRoots: current.secondaryRoots.filter((root) => root.rootId !== localId),
      };
    });
  }, [enqueueThreadFoldersWrite, selectedMemoryThreadId]);

  return { checkout, handOffToLocal, localRootId, selectWorktree };
}
