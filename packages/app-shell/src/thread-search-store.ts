import { create } from 'zustand';
import type { ThreadSearchResultItem } from './thread-search-service';

type ThreadSearchStatus = 'idle' | 'searching' | 'results' | 'error';

/**
 * Session store for the Threads panel search (mirrors the
 * workspace-search-store in-flight invalidation contract): a monotonic
 * `generation` token gates every async completion, so a superseded run can
 * never clobber or resurrect state. Session-only.
 */

// Run tokens come from these counters, not from store state, so no reset can
// rewind them and let a run started before it match one started after it.
let lastGeneration = 0;
let lastNavigationRevision = 0;
interface ThreadSearchNavigationTarget {
  readonly messageId: string;
  readonly ownerResourceId: string;
  readonly requestId: number;
  readonly threadId: string;
}

interface ThreadSearchState {
  beginNavigation: () => number;
  /** Starts a run: bumps `generation` and returns it for async completion tagging. */
  beginSearch: () => number;
  /**
   * Clears rendered results back to idle (keeping the typed query) AND bumps
   * `generation`, so an in-flight run for a stale query can neither leave
   * stale results on screen nor resurrect them when it resolves — e.g. a
   * query that shrank below the minimum length. No-op-safe when idle.
   */
  clearResults: () => void;
  /** Full dismiss (Esc / clear button): `clearResults` plus the query text. */
  clearSearch: () => void;
  error: string | null;
  /** No-op unless `generation` still matches the current run. */
  failSearch: (message: string, generation: number) => void;
  finishNavigation: (requestId: number, error?: string) => void;
  generation: number;
  navigationError: string | null;
  navigationRevision: number;
  navigationTarget: ThreadSearchNavigationTarget | null;
  query: string;
  reset: () => void;
  /** No-op unless `generation` still matches the current run. */
  resolveResults: (results: readonly ThreadSearchResultItem[], generation: number) => void;
  results: readonly ThreadSearchResultItem[] | null;
  setNavigationTarget: (target: ThreadSearchNavigationTarget) => void;
  setQuery: (query: string) => void;
  status: ThreadSearchStatus;
}

const initialState = {
  error: null,
  generation: 0,
  navigationError: null,
  navigationRevision: 0,
  navigationTarget: null,
  query: '',
  results: null,
  status: 'idle' as const,
} satisfies Omit<
  ThreadSearchState,
  | 'beginNavigation'
  | 'setNavigationTarget'
  | 'finishNavigation'
  | 'beginSearch'
  | 'clearResults'
  | 'clearSearch'
  | 'failSearch'
  | 'reset'
  | 'resolveResults'
  | 'setQuery'
>;

export const useThreadSearchStore = create<ThreadSearchState>((set) => ({
  ...initialState,
  beginNavigation: () => {
    lastNavigationRevision += 1;
    const navigationRevision = lastNavigationRevision;
    set({ navigationError: null, navigationRevision, navigationTarget: null });
    return navigationRevision;
  },
  beginSearch: () => {
    lastGeneration += 1;
    const generation = lastGeneration;
    set({ error: null, generation, status: 'searching' });
    return generation;
  },
  clearResults: () =>
    set({
      error: null,
      generation: ++lastGeneration,
      navigationError: null,
      navigationRevision: ++lastNavigationRevision,
      navigationTarget: null,
      results: null,
      status: 'idle',
    }),
  clearSearch: () =>
    set({
      error: null,
      generation: ++lastGeneration,
      navigationError: null,
      navigationRevision: ++lastNavigationRevision,
      navigationTarget: null,
      query: '',
      results: null,
      status: 'idle',
    }),
  failSearch: (message, generation) =>
    set((state) => (state.generation === generation ? { error: message, status: 'error' } : {})),
  finishNavigation: (requestId, error) =>
    set((state) =>
      state.navigationRevision === requestId
        ? { navigationError: error ?? null, navigationTarget: null }
        : {}
    ),
  // The reset tokens (0) never match a run's token, so an in-flight run is invalidated.
  reset: () => set(initialState),
  resolveResults: (results, generation) =>
    set((state) =>
      state.generation === generation ? { results: [...results], status: 'results' } : {}
    ),
  setNavigationTarget: (target) =>
    set((state) =>
      state.navigationRevision === target.requestId ? { navigationTarget: target } : {}
    ),
  setQuery: (query) => set({ query }),
}));
