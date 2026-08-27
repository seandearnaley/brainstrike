/**
 * Branch chips for the Threads panel's folder sections (BST-1404): the git
 * branch each workspace folder is currently on.
 *
 * ONE `useGitInventory()` for the whole panel — the inventory already spans
 * every repository and worktree across every root, so a per-folder git call
 * would be N round trips for data one call already carries.
 *
 * GATED ON `enabled`, which maps to both `active: enabled` and
 * `deferInitialLoad: !enabled`. One
 * inventory load is a FULL repository/worktree scan across every workspace root
 * — the cost that made `deferInitialLoad` exist at all (BST-1116 W6 review
 * finding 4, where merely mounting the git panel header paid for it). Branch
 * chips exist ONLY in the Threads panel's `groupBy: 'folder'` view, so an
 * ungated hook would charge that scan to every panel mount in every grouping
 * mode.
 *
 * This is NOT the silent disable that hook's doc forbids: ENTERING folders
 * grouping is the gesture. `enabled` flips with the grouping mode, and because
 * the option change is a dependency of the inventory hook's own load effect,
 * that flip performs the load with no second `refresh()` call here that would
 * double the scan. Leaving folder grouping pauses invalidation-driven scans;
 * re-entering performs a fresh load. While `enabled` is false the last map may
 * remain in memory but is not rendered, and `available` still reports the
 * bridge honestly.
 *
 * BARE WORKTREES ARE OMITTED. They carry no checkout, hence no branch, and the
 * chip has nothing to say about them — see the loop below.
 *
 * THREE LOOKUPS. The panel tries durable root id first, then an exact
 * durable-id + path claim for the root checkout when nested worktrees make the
 * id-only join ambiguous, then path only for a legacy thread with no root id.
 *
 * 1. `byRootId` — the UNAMBIGUOUS subset of `WorktreeDescriptor.containment`.
 *    The path join alone is not enough, because the two sides of it come from
 *    different producers: `roots.path` keeps the path the folder was MOUNTED
 *    through, while git reports the REALPATH. A root mounted through a symlink
 *    (`/var/...` vs `/private/var/...` — every macOS `mkdtemp` path) therefore
 *    never matched, and the chip silently vanished while the composer's own
 *    chip, which asks git by rootId, still said `main` for the same root.
 *    `containment` is a list of DB `roots.id` (main builds it from
 *    `loadWorkspaceRootsFromDatabase`, i.e. `roots.id`, against realpath'd
 *    root paths — see `git-inventory-service.ts` and
 *    `docs/agents/changeset-diff.md`), which is the same id space as
 *    `AssistantMemoryThread.metadata.operatingRootId`. So the id join needs no
 *    path normalization on either side and is immune to the symlink skew.
 *
 * A ROOT ID CONTAINED BY MORE THAN ONE WORKTREE IS OMITTED, never guessed at.
 * `containment` is many-to-one: a workspace root holding three repositories
 * contains three worktrees on three branches and HAS no branch of its own —
 * Zero or 2+ containing worktrees ⇒ absent from `byRootId` ⇒ the panel renders
 * no chip, the same answer it already gives for any root it cannot name. A
 * worktree whose containment is `'outside-roots'` contributes no id at all.
 *
 * 2. `byRootIdAndPath` — a durable root id plus EXACT normalized worktree
 *    path. This recovers the root checkout when that root also contains a
 *    nested agent worktree, without borrowing a replacement root mounted at
 *    the same path because the worktree must explicitly claim the thread's id.
 *
 * 3. `byRootPath` — EXACT PATH EQUALITY on the normalized worktree path, used
 *    only for a legacy thread with no durable root id. It must never override
 *    a present id: a replacement root may be mounted at the same display path.
 *
 * Desktop only: without the `window.changes` bridge `available` is false and
 * all three maps are empty. Web omits the chip rather than inventing one.
 */
import type { GitInventory, WorktreeDescriptor } from '@brainstrike/types';
import { useMemo } from 'react';
import { normalizeRootPathForLookup } from '../assistant-selection-write-back';
import { useGitInventory } from '../changes/use-git-inventory';

const NO_BRANCHES: ReadonlyMap<string, ThreadBranchInfo> = new Map();
const NO_BRANCHES_BY_ID_AND_PATH: ReadonlyMap<
  string,
  ReadonlyMap<string, ThreadBranchInfo>
> = new Map();

/** Sentinel for a root id claimed by more than one worktree — see the header. */
const AMBIGUOUS = Symbol('ambiguous-containment');

export interface ThreadBranchInfo {
  /** `null` on a detached HEAD — never a synthesized name. */
  readonly branch: string | null;
  readonly detached: boolean;
  readonly gitCommonDir: string;
}

export interface ThreadBranchByRootPathState {
  /** True when the desktop changes bridge is present. */
  readonly available: boolean;
  /**
   * Keyed by DB `roots.id`, the fallback join — same id space as a thread's
   * `metadata.operatingRootId`. Holds only root ids claimed by EXACTLY ONE
   * worktree; see the header for why an ambiguous id is absent instead.
   */
  readonly byRootId: ReadonlyMap<string, ThreadBranchInfo>;
  /** Root id -> normalized worktree path -> branch for that exact claim. */
  readonly byRootIdAndPath: ReadonlyMap<string, ReadonlyMap<string, ThreadBranchInfo>>;
  /** Keyed by NORMALIZED worktree path (see {@link normalizeRootPathForLookup}). */
  readonly byRootPath: ReadonlyMap<string, ThreadBranchInfo>;
  /**
   * True once the underlying `useGitInventory()` has resolved at least once
   * for the CURRENT `enabled` activation — i.e. `inventory !== null` there.
   * `available` alone answers "is the bridge present", not "has the load for
   * THIS activation settled yet"; a caller that needs to tell "still loading"
   * apart from "resolved, no match" (BST-1391 M2 — a forge push that arrives
   * before the first post-activation load resolves must be buffered, not
   * dropped as a false non-match) reads this rather than re-deriving it.
   */
  readonly loaded: boolean;
}

/**
 * Record this worktree's claim on every root id containing it. The SECOND
 * claim on an id replaces the first with {@link AMBIGUOUS} — ambiguity is a
 * property of the whole inventory, so it cannot be decided while the first
 * claim is being made.
 */
function claimContainedRootIds(
  claims: Map<string, ThreadBranchInfo | typeof AMBIGUOUS>,
  containment: WorktreeDescriptor['containment'],
  info: ThreadBranchInfo
): void {
  if (containment === 'outside-roots') {
    return;
  }
  for (const rootId of containment) {
    claims.set(rootId, claims.has(rootId) ? AMBIGUOUS : info);
  }
}

/** All three lookups in one pass. See the header for why each is required. */
function projectBranches(inventory: GitInventory): {
  byRootId: ReadonlyMap<string, ThreadBranchInfo>;
  byRootIdAndPath: ReadonlyMap<string, ReadonlyMap<string, ThreadBranchInfo>>;
  byRootPath: ReadonlyMap<string, ThreadBranchInfo>;
} {
  const byRootIdAndPath = new Map<string, Map<string, ThreadBranchInfo>>();
  const byRootPath = new Map<string, ThreadBranchInfo>();
  const claims = new Map<string, ThreadBranchInfo | typeof AMBIGUOUS>();
  for (const repository of inventory.repositories) {
    for (const worktree of repository.worktrees) {
      if (worktree.bare) {
        // A bare worktree is `branch: null, detached: false` — it has no
        // checkout, so there is no branch it is "on". Mapping it would hand
        // the row a ThreadBranchInfo with nothing to render: an icon-only
        // pill with no text. Absent is the same answer these maps already
        // give for every other root they cannot name — and it is why a bare
        // worktree does not make its root's containment ambiguous either.
        continue;
      }
      const info: ThreadBranchInfo = {
        branch: worktree.branch,
        detached: worktree.detached,
        gitCommonDir: repository.identity.gitCommonDir,
      };
      const normalizedPath = normalizeRootPathForLookup(worktree.path);
      byRootPath.set(normalizedPath, info);
      if (worktree.containment !== 'outside-roots') {
        for (const rootId of worktree.containment) {
          const claimsByPath = byRootIdAndPath.get(rootId) ?? new Map();
          claimsByPath.set(normalizedPath, info);
          byRootIdAndPath.set(rootId, claimsByPath);
        }
      }
      claimContainedRootIds(claims, worktree.containment, info);
    }
  }
  const byRootId = new Map<string, ThreadBranchInfo>();
  for (const [rootId, claim] of claims) {
    if (claim !== AMBIGUOUS) {
      byRootId.set(rootId, claim);
    }
  }
  return { byRootId, byRootIdAndPath, byRootPath };
}

export function useThreadBranchByRootPath({
  enabled,
}: {
  /** True only while the branch chips can actually be rendered — see above. */
  readonly enabled: boolean;
}): ThreadBranchByRootPathState {
  const { available, inventory } = useGitInventory({
    active: enabled,
    deferInitialLoad: !enabled,
  });
  const { byRootId, byRootIdAndPath, byRootPath } = useMemo(() => {
    if (!inventory) {
      // `null` is "not resolved yet", NOT "no repositories" — either way there
      // is nothing to key, and the caller reads `available` for the difference.
      return {
        byRootId: NO_BRANCHES,
        byRootIdAndPath: NO_BRANCHES_BY_ID_AND_PATH,
        byRootPath: NO_BRANCHES,
      };
    }
    return projectBranches(inventory);
  }, [inventory]);

  return { available, byRootId, byRootIdAndPath, byRootPath, loaded: inventory !== null };
}

/** Exported for the projection test — the hook itself is the only production caller. */
export { projectBranches as projectBranchesForTest };
