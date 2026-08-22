import type { AssistantMemoryThread } from '@brainstrike/assistant-data';
import { normalizeRootPathForLookup } from './assistant-selection-write-back';
import type {
  ThreadBranchByRootPathState,
  ThreadBranchInfo,
} from './hooks/use-thread-branch-by-root-path';

export type ThreadBranchLookup = Pick<ThreadBranchByRootPathState, 'byRootId' | 'byRootPath'>;

export function lookupThreadBranch(
  thread: AssistantMemoryThread,
  branchLookup: ThreadBranchLookup
): ThreadBranchInfo | null {
  const rootId = thread.metadata?.operatingRootId;
  if (rootId) {
    return branchLookup.byRootId.get(rootId) ?? null;
  }
  const rootPath = thread.metadata?.operatingRootPath;
  return rootPath
    ? (branchLookup.byRootPath.get(normalizeRootPathForLookup(rootPath)) ?? null)
    : null;
}
