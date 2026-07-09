import { create } from 'zustand';
import type { TapestryRange } from './tapestry/types';
import type { TapestryRangeMap } from './utils/context-selected-token-summary';

export interface WorkspaceContextCuratedRange {
  approxTokens?: number | null;
  endLine: number;
  isActive: boolean;
  startLine: number;
}

export interface WorkspaceContextCuratedFile {
  approxTokens: number | null;
  outputApproxTokens: number | null;
  path: string;
  ranges: WorkspaceContextCuratedRange[];
  /** Display name of the root, for disambiguating the same relative path across roots. */
  rootDisplayName?: string;
  /** Durable RootId of the file's root (multi-root); absent for legacy snapshots. */
  rootId?: string;
}

export interface WorkspaceContextCurationSnapshot {
  files: WorkspaceContextCuratedFile[];
  includeProjectTree: boolean;
  projectTreeApproxTokens: number | null;
  projectTreeTokenCountLoading: boolean;
  selectedOutputApproxTokens: number | null;
  selectedSourceApproxTokens: number | null;
  selectionFolderId: string | null;
  tokenBudget: number | null;
  useTapestryRanges: boolean;
}

interface WorkspaceContextCurationState {
  clearTapestryRanges: () => void;
  contextSnapshot: WorkspaceContextCurationSnapshot | null;
  /** Drop snapshot + ranges (session reset / factory reset). */
  reset: () => void;
  setContextSnapshot: (snapshot: WorkspaceContextCurationSnapshot | null) => void;
  setTapestryRanges: (
    ranges: TapestryRangeMap | ((prev: TapestryRangeMap) => TapestryRangeMap)
  ) => void;
  setTapestryRangesForKey: (compositeKey: string, ranges: TapestryRange[]) => void;
  tapestryRangesByKey: TapestryRangeMap;
}

// This store intentionally bridges the context preview and assistant wrapper,
// which are mounted in different UI subtrees. Snapshots carry selectionFolderId
// and range state is pruned when the folder actually CHANGES, so stale roots
// are not reused. A null previousFolderId means there is no previous snapshot
// yet (session init, e.g. the very first snapshot of the session) rather than
// a folder change, so it must not wipe ranges written before that first
// snapshot arrives (e.g. a synchronous search-bridge write that lands just
// ahead of the preview panel's first publish).
export const useWorkspaceContextCurationStore = create<WorkspaceContextCurationState>((set) => ({
  clearTapestryRanges: () => set({ tapestryRangesByKey: {} }),
  contextSnapshot: null,
  reset: () => set({ contextSnapshot: null, tapestryRangesByKey: {} }),
  setContextSnapshot: (snapshot) =>
    set((state) => {
      const previousFolderId = state.contextSnapshot?.selectionFolderId ?? null;
      const nextFolderId = snapshot?.selectionFolderId ?? null;
      const isFolderChange = previousFolderId !== null && previousFolderId !== nextFolderId;
      return {
        contextSnapshot: snapshot,
        ...(isFolderChange ? { tapestryRangesByKey: {} } : {}),
      };
    }),
  setTapestryRanges: (ranges) =>
    set((state) => ({
      tapestryRangesByKey:
        typeof ranges === 'function' ? ranges(state.tapestryRangesByKey) : ranges,
    })),
  setTapestryRangesForKey: (compositeKey, ranges) =>
    set((state) => ({
      tapestryRangesByKey: {
        ...state.tapestryRangesByKey,
        [compositeKey]: ranges,
      },
    })),
  tapestryRangesByKey: {},
}));
