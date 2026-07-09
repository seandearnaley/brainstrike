import { create } from 'zustand';
import type {
  WorkspaceSearchFileResult,
  WorkspaceSearchMode,
  WorkspaceSearchResults,
} from './search-result-model';

export type WorkspaceSearchStatus = 'idle' | 'searching' | 'results' | 'error';

interface WorkspaceSearchState {
  /** Starts a run: increments `generation` (invalidating any in-flight run) and
   * returns the new generation so the caller can tag its async completion. */
  beginSearch: () => number;
  caseSensitive: boolean;
  /** embedding_sets.id; null = resolve the workspace-index set at query time. */
  collectionId: string | null;
  error: string | null;
  expandedIds: Set<string>;
  /** No-op unless `generation` still matches the current run (a superseded run's
   * rejection must not clobber a newer run's results). */
  failSearch: (message: string, generation: number) => void;
  /**
   * Monotonic run token. `beginSearch` and every option/collection/mode change
   * (which invalidate in-flight work) increment it; `resolveResults`/`failSearch`
   * are gated on it so stale async completions are dropped. Never decreases.
   */
  generation: number;
  isRegex: boolean;
  mode: WorkspaceSearchMode;
  query: string;
  reset: () => void;
  /** No-op unless `generation` still matches the current run. */
  resolveResults: (r: WorkspaceSearchResults, generation: number) => void;
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
  generation: 0,
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

export const useWorkspaceSearchStore = create<WorkspaceSearchState>((set, get) => ({
  ...initialState,
  beginSearch: () => {
    const generation = get().generation + 1;
    set({ error: null, generation, status: 'searching' });
    return generation;
  },
  failSearch: (message, generation) =>
    set((state) => (state.generation === generation ? { error: message, status: 'error' } : {})),
  // Keep `generation` monotonic across resets so a run started before the reset
  // can never match a run started after it.
  reset: () =>
    set((state) => ({
      ...initialState,
      expandedIds: new Set<string>(),
      generation: state.generation + 1,
    })),
  resolveResults: (r, generation) =>
    set((state) =>
      state.generation === generation
        ? {
            expandedIds: new Set(r.files.map(toFileNodeId)),
            results: r,
            status: 'results',
          }
        : {}
    ),
  setCollectionId: (id) =>
    set((state) => ({
      collectionId: id,
      generation: state.generation + 1,
      results: null,
      status: 'idle',
    })),
  setMode: (m) =>
    set((state) => ({
      generation: state.generation + 1,
      mode: m,
      results: null,
      status: 'idle',
    })),
  setQuery: (q) => set({ query: q }),
  toggleCase: () =>
    set((state) => ({
      caseSensitive: !state.caseSensitive,
      generation: state.generation + 1,
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
      generation: state.generation + 1,
      isRegex: !state.isRegex,
      results: null,
      status: 'idle',
    })),
  toggleWholeWord: () =>
    set((state) => ({
      generation: state.generation + 1,
      results: null,
      status: 'idle',
      wholeWord: !state.wholeWord,
    })),
}));
