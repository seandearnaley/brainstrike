import { create } from 'zustand';
import type {
  WorkspaceSearchFileResult,
  WorkspaceSearchHit,
  WorkspaceSearchMatch,
  WorkspaceSearchSummary,
} from './search-result-model';

export type WorkspaceSearchStatus = 'idle' | 'searching' | 'results' | 'error';

interface WorkspaceSearchState {
  /**
   * Adds a running search's streamed matches, grouped by file in the order
   * found. No-op unless `generation` still names the current search.
   */
  appendMatches: (hits: readonly WorkspaceSearchHit[], generation: number) => void;
  /** Starts a search: bumps `generation` (dropping any older search's late matches) and returns it. */
  beginSearch: () => number;
  caseSensitive: boolean;
  /** Back to the idle empty state, dropping any running search's late matches. */
  clearResults: () => void;
  /** File rows the user collapsed; every other file shows its matches. */
  collapsedIds: ReadonlySet<string>;
  /** No-op unless `generation` still names the current search. */
  completeSearch: (summary: WorkspaceSearchSummary, generation: number) => void;
  error: string | null;
  /** No-op unless `generation` still names the current search. */
  failSearch: (message: string, generation: number) => void;
  /** Matched files, in the order found. */
  files: readonly WorkspaceSearchFileResult[];
  /**
   * Monotonic search token. Starting a search, clearing, resetting and every
   * option change bump it; late matches and answers of an older search are
   * dropped. Never decreases.
   */
  generation: number;
  isRegex: boolean;
  query: string;
  reset: () => void;
  setQuery: (q: string) => void;
  status: WorkspaceSearchStatus;
  /** The finished search's caps; `null` while it runs. */
  summary: WorkspaceSearchSummary | null;
  toggleCase: () => void;
  toggleCollapsed: (fileId: string) => void;
  toggleRegex: () => void;
  toggleWholeWord: () => void;
  totalMatches: number;
  wholeWord: boolean;
}

/** A file row's id: unique per root and path. */
export function fileResultId(file: Pick<WorkspaceSearchFileResult, 'path' | 'rootId'>): string {
  return `f:${file.rootId}:${file.path}`;
}

const emptyResults = {
  collapsedIds: new Set<string>() as ReadonlySet<string>,
  error: null,
  files: [] as readonly WorkspaceSearchFileResult[],
  summary: null,
  totalMatches: 0,
};

const initialState = {
  ...emptyResults,
  caseSensitive: false,
  generation: 0,
  isRegex: false,
  query: '',
  status: 'idle' as WorkspaceSearchStatus,
  wholeWord: false,
};

/**
 * Merges a batch into the file list in one pass: one new array per batch, and
 * each file the batch touched is copied once, however many of its lines it holds.
 */
function mergeHits(
  files: readonly WorkspaceSearchFileResult[],
  hits: readonly WorkspaceSearchHit[]
): WorkspaceSearchFileResult[] {
  const next = [...files];
  const indexById = new Map<string, number>();
  next.forEach((file, index) => {
    indexById.set(fileResultId(file), index);
  });
  // The match arrays this batch owns: copied (or created) on a file's first hit.
  const touched = new Map<number, WorkspaceSearchMatch[]>();
  for (const { line, lineText, path, rootId } of hits) {
    const id = fileResultId({ path, rootId });
    let index = indexById.get(id);
    if (index === undefined) {
      index = next.length;
      indexById.set(id, index);
      next.push({ matches: [], path, rootId });
    }
    let matches = touched.get(index);
    if (!matches) {
      const file = next[index];
      matches = file ? [...file.matches] : [];
      touched.set(index, matches);
      next[index] = { matches, path, rootId };
    }
    matches.push({ line, lineText });
  }
  return next;
}

/** An option change invalidates the running search and its results. */
function optionChange(state: WorkspaceSearchState) {
  return { ...emptyResults, generation: state.generation + 1, status: 'idle' as const };
}

export const useWorkspaceSearchStore = create<WorkspaceSearchState>((set, get) => ({
  ...initialState,
  appendMatches: (hits, generation) =>
    set((state) =>
      state.generation === generation && state.status === 'searching' && hits.length > 0
        ? { files: mergeHits(state.files, hits), totalMatches: state.totalMatches + hits.length }
        : {}
    ),
  beginSearch: () => {
    const generation = get().generation + 1;
    set({ ...emptyResults, generation, status: 'searching' });
    return generation;
  },
  clearResults: () => set(optionChange),
  completeSearch: (summary, generation) =>
    set((state) =>
      state.generation === generation && state.status === 'searching'
        ? { status: 'results', summary }
        : {}
    ),
  failSearch: (message, generation) =>
    set((state) => (state.generation === generation ? { error: message, status: 'error' } : {})),
  // Keep `generation` monotonic across resets so a search started before the
  // reset can never match one started after it.
  reset: () => set((state) => ({ ...initialState, generation: state.generation + 1 })),
  setQuery: (q) => set({ query: q }),
  toggleCase: () =>
    set((state) => ({ ...optionChange(state), caseSensitive: !state.caseSensitive })),
  toggleCollapsed: (fileId) =>
    set((state) => {
      const next = new Set(state.collapsedIds);
      if (next.has(fileId)) {
        next.delete(fileId);
      } else {
        next.add(fileId);
      }
      return { collapsedIds: next };
    }),
  toggleRegex: () => set((state) => ({ ...optionChange(state), isRegex: !state.isRegex })),
  toggleWholeWord: () => set((state) => ({ ...optionChange(state), wholeWord: !state.wholeWord })),
}));
