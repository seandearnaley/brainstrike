import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

interface SearchPanelData {
  query: string;
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  includeGlobs: string[];
  excludeGlobs: string[];
}

interface SearchPanelActions {
  setQuery: (q: string) => void;
  toggleRegex: () => void;
  toggleCaseSensitive: () => void;
  toggleWholeWord: () => void;
  setIncludeGlobs: (g: string[]) => void;
  setExcludeGlobs: (g: string[]) => void;
  clear: () => void;
}

export type SearchPanelStore = SearchPanelData & SearchPanelActions;

const STORE_NAME = 'search-panel.v1' as const;

// Safe storage for SSR/tests
const memory = new Map<string, string>();
const storage = createJSONStorage(() => ({
  getItem: (k: string) => {
    try {
      if (typeof localStorage !== 'undefined') return localStorage.getItem(k);
    } catch {}
    return memory.get(k) ?? null;
  },
  setItem: (k: string, v: string) => {
    try {
      if (typeof localStorage !== 'undefined') return localStorage.setItem(k, v);
    } catch {}
    memory.set(k, v);
  },
  removeItem: (k: string) => {
    try {
      if (typeof localStorage !== 'undefined') return localStorage.removeItem(k);
    } catch {}
    memory.delete(k);
  },
}));

export const useSearchPanelStore = create<SearchPanelStore>()(
  persist(
    (set) => ({
      query: '',
      regex: false,
      caseSensitive: false,
      wholeWord: false,
      includeGlobs: [],
      excludeGlobs: [],

      setQuery: (q) => set({ query: q }),
      toggleRegex: () => set((s) => ({ regex: !s.regex })),
      toggleCaseSensitive: () => set((s) => ({ caseSensitive: !s.caseSensitive })),
      toggleWholeWord: () => set((s) => ({ wholeWord: !s.wholeWord })),
      setIncludeGlobs: (g) => set({ includeGlobs: g }),
      setExcludeGlobs: (g) => set({ excludeGlobs: g }),
      clear: () =>
        set({
          query: '',
          regex: false,
          caseSensitive: false,
          wholeWord: false,
          includeGlobs: [],
          excludeGlobs: [],
        }),
    }),
    {
      name: STORE_NAME,
      version: 1,
      storage,
      partialize: (s) => ({
        query: s.query,
        regex: s.regex,
        caseSensitive: s.caseSensitive,
        wholeWord: s.wholeWord,
        includeGlobs: s.includeGlobs,
        excludeGlobs: s.excludeGlobs,
      }),
    }
  )
);

// Tuple-friendly selectors (React Compiler/HMR friendly)
export const searchPanelSelectors = {
  queryAndFlags: (s: SearchPanelStore) => [s.query, s.regex, s.caseSensitive, s.wholeWord] as const,
  globs: (s: SearchPanelStore) => [s.includeGlobs, s.excludeGlobs] as const,
};

// Test-only helper to reset store and storage
export function __resetSearchPanelStoreForTests() {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(STORE_NAME);
  } catch {}
  useSearchPanelStore.setState({
    query: '',
    regex: false,
    caseSensitive: false,
    wholeWord: false,
    includeGlobs: [],
    excludeGlobs: [],
  });
}
