import type { ThreadSearchCoverage, ThreadSearchResultItem } from '@brainstrike/db';
import { create } from 'zustand';

export type ThreadSearchStatus = 'idle' | 'searching' | 'results' | 'error';

/**
 * Session store for the Threads panel search (mirrors the
 * workspace-search-store in-flight invalidation contract): a monotonic
 * `generation` token gates every async completion, so a superseded run can
 * never clobber or resurrect state. Session-only; registered with factory
 * reset in `register-factory-reset-session-stores.ts`.
 */
export interface ThreadSearchNavigationTarget {
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
  /**
   * Coverage is monotonic status info (indexing progress), not run output —
   * it is deliberately NOT generation-gated.
   */
  coverage: ThreadSearchCoverage | null;
  error: string | null;
  /** No-op unless `generation` still matches the current run. */
  failSearch: (message: string, generation: number) => void;
  finishNavigation: (requestId: number, error?: string) => void;
  generation: number;
  navigationError: string | null;
  navigationRevision: number;
  navigationTarget: ThreadSearchNavigationTarget | null;
  query: string;
  recordCoverage: (coverage: ThreadSearchCoverage) => void;
  reset: () => void;
  /** No-op unless `generation` still matches the current run. */
  resolveResults: (
    results: readonly ThreadSearchResultItem[],
    semantic: ThreadSearchSemanticState,
    generation: number
  ) => void;
  results: readonly ThreadSearchResultItem[] | null;
  /**
   * The semantic arm's honest availability for the CURRENT results: either it
   * ran, or the visible reason it could not (never a silent lexical-only
   * downgrade).
   */
  semantic: ThreadSearchSemanticState;
  setNavigationTarget: (target: ThreadSearchNavigationTarget) => void;
  setQuery: (query: string) => void;
  status: ThreadSearchStatus;
}

export type ThreadSearchSemanticState =
  | { readonly kind: 'unused' }
  | { readonly kind: 'used' }
  | { readonly kind: 'unavailable'; readonly reason: string };

const SEMANTIC_UNUSED: ThreadSearchSemanticState = { kind: 'unused' };

const initialState = {
  coverage: null,
  error: null,
  generation: 0,
  navigationError: null,
  navigationRevision: 0,
  navigationTarget: null,
  query: '',
  results: null,
  semantic: SEMANTIC_UNUSED,
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
  | 'recordCoverage'
  | 'reset'
  | 'resolveResults'
  | 'setQuery'
>;

export const useThreadSearchStore = create<ThreadSearchState>((set, get) => ({
  ...initialState,
  beginNavigation: () => {
    const navigationRevision = get().navigationRevision + 1;
    set({ navigationError: null, navigationRevision, navigationTarget: null });
    return navigationRevision;
  },
  beginSearch: () => {
    const generation = get().generation + 1;
    set({ error: null, generation, status: 'searching' });
    return generation;
  },
  clearResults: () =>
    set((state) => ({
      error: null,
      generation: state.generation + 1,
      navigationError: null,
      navigationRevision: state.navigationRevision + 1,
      navigationTarget: null,
      results: null,
      semantic: SEMANTIC_UNUSED,
      status: 'idle',
    })),
  clearSearch: () =>
    set((state) => ({
      error: null,
      generation: state.generation + 1,
      navigationError: null,
      navigationRevision: state.navigationRevision + 1,
      navigationTarget: null,
      query: '',
      results: null,
      semantic: SEMANTIC_UNUSED,
      status: 'idle',
    })),
  failSearch: (message, generation) =>
    set((state) => (state.generation === generation ? { error: message, status: 'error' } : {})),
  finishNavigation: (requestId, error) =>
    set((state) =>
      state.navigationRevision === requestId
        ? { navigationError: error ?? null, navigationTarget: null }
        : {}
    ),
  recordCoverage: (coverage) => set({ coverage }),
  // Keep `generation` monotonic across resets so a run started before the
  // reset can never match a run started after it.
  reset: () =>
    set((state) => ({
      ...initialState,
      generation: state.generation + 1,
      navigationRevision: state.navigationRevision + 1,
    })),
  resolveResults: (results, semantic, generation) =>
    set((state) =>
      state.generation === generation ? { results: [...results], semantic, status: 'results' } : {}
    ),
  setNavigationTarget: (target) =>
    set((state) =>
      state.navigationRevision === target.requestId ? { navigationTarget: target } : {}
    ),
  setQuery: (query) => set({ query }),
}));

export function resetThreadSearchStore(): void {
  useThreadSearchStore.getState().reset();
}
