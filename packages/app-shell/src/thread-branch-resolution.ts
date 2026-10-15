import type { AssistantMemoryThread } from '@brainstrike/assistant-data';
import type {
  ThreadBranchByRootPathState,
  ThreadBranchInfo,
} from './hooks/use-thread-branch-by-root-path';
import { normalizeRootPathForLookup } from './root-path-lookup';

export type ThreadBranchLookup = Pick<
  ThreadBranchByRootPathState,
  'byRootId' | 'byRootIdAndPath' | 'byRootPath'
>;

export function lookupThreadBranch(
  thread: AssistantMemoryThread,
  branchLookup: ThreadBranchLookup
): ThreadBranchInfo | null {
  const rootId = thread.metadata?.operatingRootId;
  if (rootId) {
    const branchById = branchLookup.byRootId.get(rootId);
    if (branchById) {
      return branchById;
    }
    const rootPath = thread.metadata?.operatingRootPath;
    return rootPath
      ? (branchLookup.byRootIdAndPath.get(rootId)?.get(normalizeRootPathForLookup(rootPath)) ??
          null)
      : null;
  }
  const rootPath = thread.metadata?.operatingRootPath;
  return rootPath
    ? (branchLookup.byRootPath.get(normalizeRootPathForLookup(rootPath)) ?? null)
    : null;
}
