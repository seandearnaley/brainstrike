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
  setContextSnapshot: (snapshot: WorkspaceContextCurationSnapshot | null) => void;
  setTapestryRanges: (
    ranges: TapestryRangeMap | ((prev: TapestryRangeMap) => TapestryRangeMap)
  ) => void;
  setTapestryRangesForKey: (compositeKey: string, ranges: TapestryRange[]) => void;
  tapestryRangesByKey: TapestryRangeMap;
}

// This store intentionally bridges the context preview and assistant wrapper,
// which are mounted in different UI subtrees. Snapshots carry selectionFolderId
// and range state is pruned on folder changes so stale roots are not reused.
export const useWorkspaceContextCurationStore = create<WorkspaceContextCurationState>((set) => ({
  contextSnapshot: null,
  tapestryRangesByKey: {},
  clearTapestryRanges: () => set({ tapestryRangesByKey: {} }),
  setContextSnapshot: (snapshot) =>
    set((state) => {
      const previousFolderId = state.contextSnapshot?.selectionFolderId ?? null;
      const nextFolderId = snapshot?.selectionFolderId ?? null;
      return {
        contextSnapshot: snapshot,
        ...(previousFolderId === nextFolderId ? {} : { tapestryRangesByKey: {} }),
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
}));
