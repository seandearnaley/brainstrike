import { createSafeJsonStorageAdapter } from '@brainstrike/utils/safe-storage';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

type Key = string; // use compositeKey (folder:name:path) or tab id

interface EditorViewStateData {
  scrollTops: Record<Key, number>;
  selections: Record<Key, { start: number; end: number } | undefined>;
}

interface EditorViewStateActions {
  clear: (key?: Key) => void;
  getScrollTop: (key: Key) => number;
  getSelection: (key: Key) => { start: number; end: number } | undefined;
  setScrollTop: (key: Key, top: number) => void;
  setSelection: (key: Key, start: number, end: number) => void;
}

export type EditorViewStateStore = EditorViewStateData & EditorViewStateActions;

const STORE_NAME = 'editor-view-state.v1' as const;

const storage = createSafeJsonStorageAdapter();

export const useEditorViewStateStore = create<EditorViewStateStore>()(
  persist(
    (set, get) => ({
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
      getScrollTop: (key) => get().scrollTops[key] ?? 0,
      getSelection: (key) => get().selections[key],
      scrollTops: {},
      selections: {},

      setScrollTop: (key, top) =>
        set((s) => ({ scrollTops: { ...s.scrollTops, [key]: Math.max(0, top | 0) } })),
      setSelection: (key, start, end) =>
        set((s) => ({ selections: { ...s.selections, [key]: { end, start } } })),
    }),
    {
      name: STORE_NAME,
      partialize: (s) => ({ scrollTops: s.scrollTops, selections: s.selections }),
      storage: createJSONStorage(() => storage),
      version: 1,
    }
  )
);
