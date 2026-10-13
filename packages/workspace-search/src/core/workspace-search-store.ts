import type {
  IndexerSourceObservation,
  NativeIndexLifecycleObservation,
} from '@brainstrike/indexing-contract/indexer-client';
import { create } from 'zustand';
import type {
  WorkspaceSearchFileResult,
  WorkspaceSearchMode,
  WorkspaceSearchResults,
} from './search-result-model';

export type WorkspaceSearchStatus = 'idle' | 'searching' | 'results' | 'error';

export interface NativePendingSearch {
  readonly after: NativeIndexLifecycleObservation | null;
  readonly generation: number;
  readonly mode: WorkspaceSearchMode;
  readonly source?: {
    readonly storeId: string;
    readonly query: string;
    readonly observations: readonly IndexerSourceObservation[];
    readonly after?: IndexerSourceObservation;
  };
}

interface WorkspaceSearchState {
  /** Starts a run: increments `generation` (invalidating any in-flight run) and
   * returns the new generation so the caller can tag its async completion. */
  beginSearch: () => number;
  caseSensitive: boolean;
  /**
   * Clears any rendered results back to the idle empty state AND bumps
   * `generation`, so an in-flight run whose query is no longer valid (e.g. a
   * text query shrunk below the min length) can neither leave stale results on
   * screen nor resurrect them when it resolves. No-op-safe to call when idle.
   */
  clearResults: () => void;
  /** embedding_sets.id; null = resolve the workspace-index set at query time. */
  collectionId: string | null;
  consumeNativeSearch: (command: NativePendingSearch) => boolean;
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
  /**
   * Bumps `textResultLimit` by 200 (Show-more paging, text mode only). Does
   * NOT bump `generation` — the caller reruns the search after bumping, and
   * that rerun's own `beginSearch()` is what invalidates any prior in-flight
   * run. Bumping generation here too would be redundant, not incorrect, but
   * keeping this single-purpose keeps the invalidation contract in one place.
   */
  increaseTextResultLimit: () => void;
  isRegex: boolean;
  mode: WorkspaceSearchMode;
  nativePendingSearch: NativePendingSearch | null;
  query: string;
  reset: () => void;
  /** No-op unless `generation` still matches the current run. */
  resolveResults: (r: WorkspaceSearchResults, generation: number) => void;
  results: WorkspaceSearchResults | null;
  retainNativeSearch: (command: NativePendingSearch) => void;
  setCollectionId: (id: string | null) => void;
  setMode: (m: WorkspaceSearchMode) => void;
  setQuery: (q: string) => void;
  status: WorkspaceSearchStatus;
  /** Show-more paging cap for text-mode results (default 200, +200 per click).
   * Reset to the default by any change that starts a fresh search (mode,
   * collection, toggles, query, `clearResults`, `reset`) — a new search should
   * never inherit a deep limit from a previous one. */
  textResultLimit: number;
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

/**
 * Default expansion set: every file id plus every text-mode chunk-group id
 * (`c:${chunkId}`) so text results render fully expanded to their match rows.
 * Semantic children are file-direct (no second level), so they need no chunk
 * entries here — files alone expand them.
 */
function toDefaultExpandedIds(results: WorkspaceSearchResults): Set<string> {
  const ids = new Set<string>();
  for (const file of results.files) {
    ids.add(toFileNodeId(file));
    for (const child of file.children) {
      if (child.kind === 'match') {
        ids.add(`c:${child.chunkId}`);
      }
    }
  }
  return ids;
}

/** Default + increment for the text-mode Show-more paging cap. */
const DEFAULT_TEXT_RESULT_LIMIT = 200;
const TEXT_RESULT_LIMIT_INCREMENT = 200;

const initialState = {
  caseSensitive: false,
  collectionId: null,
  error: null,
  expandedIds: new Set<string>(),
  generation: 0,
  isRegex: false,
  mode: 'text' as const,
  nativePendingSearch: null as NativePendingSearch | null,
  query: '',
  results: null,
  status: 'idle' as const,
  textResultLimit: DEFAULT_TEXT_RESULT_LIMIT,
  wholeWord: false,
} satisfies Omit<
  WorkspaceSearchState,
  | 'retainNativeSearch'
  | 'consumeNativeSearch'
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
  | 'clearResults'
  | 'increaseTextResultLimit'
  | 'reset'
>;

export const useWorkspaceSearchStore = create<WorkspaceSearchState>((set, get) => ({
  ...initialState,
  beginSearch: () => {
    const generation = get().generation + 1;
    set({ error: null, generation, nativePendingSearch: null, status: 'searching' });
    return generation;
  },
  clearResults: () =>
    set((state) => ({
      error: null,
      generation: state.generation + 1,
      nativePendingSearch: null,
      results: null,
      status: 'idle',
      textResultLimit: DEFAULT_TEXT_RESULT_LIMIT,
    })),
  consumeNativeSearch: (command) => {
    if (get().nativePendingSearch !== command || get().generation !== command.generation) {
      return false;
    }
    set({ nativePendingSearch: null });
    return true;
  },
  failSearch: (message, generation) =>
    set((state) =>
      state.generation === generation
        ? { error: message, nativePendingSearch: null, status: 'error' }
        : {}
    ),
  increaseTextResultLimit: () =>
    set((state) => ({ textResultLimit: state.textResultLimit + TEXT_RESULT_LIMIT_INCREMENT })),
  // Keep `generation` monotonic across resets so a run started before the reset
  // can never match a run started after it.
  reset: () =>
    set((state) => ({
      ...initialState,
      expandedIds: new Set<string>(),
      generation: state.generation + 1,
      nativePendingSearch: null,
    })),
  resolveResults: (r, generation) =>
    set((state) =>
      state.generation === generation
        ? {
            expandedIds: toDefaultExpandedIds(r),
            results: r,
            status: 'results',
          }
        : {}
    ),
  retainNativeSearch: (command) =>
    set((state) =>
      state.generation === command.generation &&
      (!command.source || state.query === command.source.query)
        ? { nativePendingSearch: command }
        : {}
    ),
  setCollectionId: (id) =>
    set((state) => ({
      collectionId: id,
      generation: state.generation + 1,
      nativePendingSearch: null,
      results: null,
      status: 'idle',
      textResultLimit: DEFAULT_TEXT_RESULT_LIMIT,
    })),
  setMode: (m) =>
    set((state) => ({
      generation: state.generation + 1,
      mode: m,
      nativePendingSearch: null,
      results: null,
      status: 'idle',
      textResultLimit: DEFAULT_TEXT_RESULT_LIMIT,
    })),
  // A new query is a new search, so the Show-more cap resets here too — even
  // though setQuery does not bump `generation`/touch results/status (the
  // debounced auto-search owns that transition).
  setQuery: (q) =>
    set((state) => ({
      nativePendingSearch: state.query === q ? state.nativePendingSearch : null,
      query: q,
      textResultLimit: DEFAULT_TEXT_RESULT_LIMIT,
    })),
  toggleCase: () =>
    set((state) => ({
      caseSensitive: !state.caseSensitive,
      generation: state.generation + 1,
      nativePendingSearch: null,
      results: null,
      status: 'idle',
      textResultLimit: DEFAULT_TEXT_RESULT_LIMIT,
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
      nativePendingSearch: null,
      results: null,
      status: 'idle',
      textResultLimit: DEFAULT_TEXT_RESULT_LIMIT,
    })),
  toggleWholeWord: () =>
    set((state) => ({
      generation: state.generation + 1,
      nativePendingSearch: null,
      results: null,
      status: 'idle',
      textResultLimit: DEFAULT_TEXT_RESULT_LIMIT,
      wholeWord: !state.wholeWord,
    })),
}));
