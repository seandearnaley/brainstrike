/**
 * Joins a thread to its cached pull request through the branch it resolves
 * to — the same `(repoCommonDir, branch)` identity
 * `apps/desktop/src/assistant-server/forge-service.ts` keys the cache with,
 * via the canonical `forgePrCacheKey` from `@brainstrike/types` (never a
 * second copy of the key encoding here).
 *
 * `!resolved?.branch` covers TWO distinct "no branch" cases as one: a thread
 * whose folder resolves to nothing (`lookupThreadBranch` returned `null`,
 * e.g. no bound root, or a root git cannot yet name), and a thread whose
 * folder IS resolved but sits on a DETACHED HEAD (`resolved.branch === null`,
 * per `ThreadBranchInfo`'s own contract — never a synthesized name). Both
 * must return null rather than attempt a lookup: a detached checkout has no
 * branch identity to key a PR cache entry by, and querying with a
 * placeholder (e.g. the literal string `"null"`) would risk colliding with a
 * real branch someone actually named `null`, or with another detached
 * worktree that also has nothing to report — either way a fabricated match,
 * not an honest absence.
 */
import type { AssistantMemoryThread } from '@brainstrike/assistant-data';
import { type ForgePrCacheEntry, forgePrCacheKey } from '@brainstrike/types';
import type { ForgePrCacheLookup } from './hooks/use-forge-pr-cache';
import { lookupThreadBranch, type ThreadBranchLookup } from './thread-branch-resolution';

export function lookupThreadForgePr(
  thread: AssistantMemoryThread,
  branchLookup: ThreadBranchLookup,
  prCache: ForgePrCacheLookup
): ForgePrCacheEntry | null {
  const resolved = lookupThreadBranch(thread, branchLookup);
  if (!resolved?.branch) {
    return null;
  }
  return prCache.get(forgePrCacheKey(resolved.gitCommonDir, resolved.branch)) ?? null;
}
