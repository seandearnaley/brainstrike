import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

type Key = string; // use compositeKey (folder:name:path) or tab id

interface EditorViewStateData {
  scrollTops: Record<Key, number>;
  selections: Record<Key, { start: number; end: number } | undefined>;
}

interface EditorViewStateActions {
  setScrollTop: (key: Key, top: number) => void;
  getScrollTop: (key: Key) => number;
  setSelection: (key: Key, start: number, end: number) => void;
  getSelection: (key: Key) => { start: number; end: number } | undefined;
  clear: (key?: Key) => void;
}

export type EditorViewStateStore = EditorViewStateData & EditorViewStateActions;

const STORE_NAME = 'editor-view-state.v1' as const;

// Safe storage that falls back to memory in non-browser environments
const memory: Map<string, string> = new Map();
const storage = {
  getItem: (name: string) => {
    try {
      if (typeof localStorage !== 'undefined') return localStorage.getItem(name);
    } catch {}
    return memory.get(name) ?? null;
  },
  setItem: (name: string, value: string) => {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(name, value);
        return;
      }
    } catch {}
    memory.set(name, value);
  },
  removeItem: (name: string) => {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(name);
        return;
      }
    } catch {}
    memory.delete(name);
  },
};

export const useEditorViewStateStore = create<EditorViewStateStore>()(
  persist(
    (set, get) => ({
      scrollTops: {},
      selections: {},

      setScrollTop: (key, top) =>
        set((s) => ({ scrollTops: { ...s.scrollTops, [key]: Math.max(0, top | 0) } })),
      getScrollTop: (key) => get().scrollTops[key] ?? 0,
      setSelection: (key, start, end) =>
        set((s) => ({ selections: { ...s.selections, [key]: { start, end } } })),
      getSelection: (key) => get().selections[key],
      clear: (key) => {
        if (!key) {
          set({ scrollTops: {}, selections: {} });
          return;
        }
        const { scrollTops, selections } = get();
        const { [key]: _a, ...restScrolls } = scrollTops;
        const { [key]: _b, ...restSel } = selections;
        set({ scrollTops: restScrolls, selections: restSel });
      },
    }),
    {
      name: STORE_NAME,
      version: 1,
      storage: createJSONStorage(() => storage),
      partialize: (s) => ({ scrollTops: s.scrollTops, selections: s.selections }),
    }
  )
);
