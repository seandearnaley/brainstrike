import type { AssistantMemoryThread } from '@brainstrike/assistant-data';
import type { ForgePrCacheEntry } from '@brainstrike/types';
import { type ForgePrCacheLookup, forgePrCacheKey } from './hooks/use-forge-pr-cache';
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
