import { create } from 'zustand';
import type {
  WorkspaceSearchFileResult,
  WorkspaceSearchMode,
  WorkspaceSearchResults,
} from './search-result-model';

export type WorkspaceSearchStatus = 'idle' | 'searching' | 'results' | 'error';

interface WorkspaceSearchState {
  beginSearch: () => void;
  caseSensitive: boolean;
  /** embedding_sets.id; null = resolve the workspace-index set at query time. */
  collectionId: string | null;
  error: string | null;
  expandedIds: Set<string>;
  failSearch: (message: string) => void;
  isRegex: boolean;
  mode: WorkspaceSearchMode;
  query: string;
  reset: () => void;
  resolveResults: (r: WorkspaceSearchResults) => void;
  results: WorkspaceSearchResults | null;
  setCollectionId: (id: string | null) => void;
  setMode: (m: WorkspaceSearchMode) => void;
  setQuery: (q: string) => void;
  status: WorkspaceSearchStatus;
  toggleCase: () => void;
  toggleExpanded: (nodeId: string) => void;
  toggleRegex: () => void;
  toggleWholeWord: () => void;
  wholeWord: boolean;
}

/** File node id convention relied on by later tasks (Task 10): `f:${dbRootId}:${path}`. */
function toFileNodeId(file: WorkspaceSearchFileResult): string {
  return `f:${file.dbRootId}:${file.path}`;
}

const initialState = {
  caseSensitive: false,
  collectionId: null,
  error: null,
  expandedIds: new Set<string>(),
  isRegex: false,
  mode: 'text' as const,
  query: '',
  results: null,
  status: 'idle' as const,
  wholeWord: false,
} satisfies Omit<
  WorkspaceSearchState,
  | 'setQuery'
  | 'setMode'
  | 'toggleCase'
  | 'toggleRegex'
  | 'toggleWholeWord'
  | 'setCollectionId'
  | 'toggleExpanded'
  | 'beginSearch'
  | 'resolveResults'
  | 'failSearch'
  | 'reset'
>;

export const useWorkspaceSearchStore = create<WorkspaceSearchState>((set) => ({
  ...initialState,
  beginSearch: () => set({ error: null, status: 'searching' }),
  failSearch: (message) => set({ error: message, status: 'error' }),
  reset: () => set({ ...initialState, expandedIds: new Set<string>() }),
  resolveResults: (r) =>
    set({
      expandedIds: new Set(r.files.map(toFileNodeId)),
      results: r,
      status: 'results',
    }),
  setCollectionId: (id) => set({ collectionId: id, results: null, status: 'idle' }),
  setMode: (m) => set({ mode: m, results: null, status: 'idle' }),
  setQuery: (q) => set({ query: q }),
  toggleCase: () =>
    set((state) => ({
      caseSensitive: !state.caseSensitive,
      results: null,
      status: 'idle',
    })),
  toggleExpanded: (nodeId) =>
    set((state) => {
      const next = new Set(state.expandedIds);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return { expandedIds: next };
    }),
  toggleRegex: () =>
    set((state) => ({
      isRegex: !state.isRegex,
      results: null,
      status: 'idle',
    })),
  toggleWholeWord: () =>
    set((state) => ({
      results: null,
      status: 'idle',
      wholeWord: !state.wholeWord,
    })),
}));
