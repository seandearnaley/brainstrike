/**
 * Branch chips for the Threads panel's folder sections (BST-1404): the git
 * branch each workspace folder is currently on.
 *
 * ONE `useGitInventory()` for the whole panel — the inventory already spans
 * every repository and worktree across every root, so a per-folder git call
 * would be N round trips for data one call already carries. Loading is EAGER
 * (not `deferInitialLoad`): the chips are part of first paint of the folders
 * view, and a deferred load with no gesture to `refresh()` from would be a
 * silent disable.
 *
 * MATCHING IS EXACT PATH EQUALITY, not `WorktreeDescriptor.containment`.
 * `containment` answers "which roots contain this worktree", which is
 * many-to-one: a workspace root holding three repositories contains three
 * worktrees on three branches and HAS no branch of its own. Choosing one of
 * them would be a fabricated chip. A root that IS a worktree checkout matches
 * exactly and gets its real branch; anything else is simply absent from the
 * map, and the panel renders no chip.
 *
 * Desktop only: without the `window.changes` bridge `available` is false and
 * the map is empty. Web omits the chip rather than inventing one.
 */
import { useMemo } from 'react';
import { normalizeRootPathForLookup } from '../assistant-selection-write-back';
import { useGitInventory } from '../changes/use-git-inventory';

const NO_BRANCHES: ReadonlyMap<string, ThreadBranchInfo> = new Map();

export interface ThreadBranchInfo {
  /** `null` on a detached HEAD or a bare worktree — never a synthesized name. */
  readonly branch: string | null;
  readonly detached: boolean;
}

export interface ThreadBranchByRootPathState {
  /** True when the desktop changes bridge is present. */
  readonly available: boolean;
  /** Keyed by NORMALIZED worktree path (see {@link normalizeRootPathForLookup}). */
  readonly byRootPath: ReadonlyMap<string, ThreadBranchInfo>;
}

export function useThreadBranchByRootPath(): ThreadBranchByRootPathState {
  const { available, inventory } = useGitInventory();
  const byRootPath = useMemo<ReadonlyMap<string, ThreadBranchInfo>>(() => {
    if (!inventory) {
      // `null` is "not resolved yet", NOT "no repositories" — either way there
      // is nothing to key, and the caller reads `available` for the difference.
      return NO_BRANCHES;
    }
    const map = new Map<string, ThreadBranchInfo>();
    for (const repository of inventory.repositories) {
      for (const worktree of repository.worktrees) {
        map.set(normalizeRootPathForLookup(worktree.path), {
          branch: worktree.branch,
          detached: worktree.detached,
        });
      }
    }
    return map;
  }, [inventory]);

  return { available, byRootPath };
}
