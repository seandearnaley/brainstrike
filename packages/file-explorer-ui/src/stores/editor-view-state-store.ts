import { createSafeJsonStorageAdapter } from '@brainstrike/utils/safe-storage';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

type Key = string; // use compositeKey (folder:name:path) or tab id

interface EditorViewStateData {
  scrollTops: Record<Key, number>;
  selections: Record<Key, { start: number; end: number } | undefined>;
  /**
   * Transient (NOT persisted) 1-based line to scroll a freshly opened tab to on
   * first render — e.g. a workspace-search match target. Consumed once on the
   * opening render; it intentionally survives reloads as nothing (persisting a
   * one-shot scroll target would fight restored scroll position on every boot).
   */
  targetLines: Record<Key, number | undefined>;
}

interface EditorViewStateActions {
  clear: (key?: Key) => void;
  /**
   * Consume the one-shot target line for a key WITHOUT touching scrollTop or
   * selection. Callers (e.g. workspace-tab-host's FileTabBody) call this right
   * after the opening render has used the target line, so a later remount of
   * the same key (tab switch away/back, close/reopen) reads no target and
   * falls back to the restored scroll position instead of re-scrolling.
   */
  clearTargetLine: (key: Key) => void;
  getScrollTop: (key: Key) => number;
  getSelection: (key: Key) => { start: number; end: number } | undefined;
  getTargetLine: (key: Key) => number | undefined;
  setScrollTop: (key: Key, top: number) => void;
  setSelection: (key: Key, start: number, end: number) => void;
  setTargetLine: (key: Key, line: number) => void;
}

export type EditorViewStateStore = EditorViewStateData & EditorViewStateActions;

const STORE_NAME = 'editor-view-state.v1' as const;

const storage = createSafeJsonStorageAdapter();

export const useEditorViewStateStore = create<EditorViewStateStore>()(
  persist(
    (set, get) => ({
      clear: (key) => {
        if (!key) {
          set({ scrollTops: {}, selections: {}, targetLines: {} });
          return;
        }
        const { scrollTops, selections, targetLines } = get();
        const { [key]: _a, ...restScrolls } = scrollTops;
        const { [key]: _b, ...restSel } = selections;
        const { [key]: _c, ...restTargets } = targetLines;
        set({ scrollTops: restScrolls, selections: restSel, targetLines: restTargets });
      },
      clearTargetLine: (key) => {
        const { targetLines } = get();
        if (!(key in targetLines)) {
          return;
        }
        const { [key]: _removed, ...restTargets } = targetLines;
        set({ targetLines: restTargets });
      },
      getScrollTop: (key) => get().scrollTops[key] ?? 0,
      getSelection: (key) => get().selections[key],
      getTargetLine: (key) => get().targetLines[key],
      scrollTops: {},
      selections: {},

      setScrollTop: (key, top) =>
        set((s) => ({ scrollTops: { ...s.scrollTops, [key]: Math.max(0, top | 0) } })),
      setSelection: (key, start, end) =>
        set((s) => ({ selections: { ...s.selections, [key]: { end, start } } })),
      setTargetLine: (key, line) =>
        set((s) => ({ targetLines: { ...s.targetLines, [key]: Math.max(1, line | 0) } })),
      targetLines: {},
    }),
    {
      name: STORE_NAME,
      // targetLines is intentionally excluded: it is a one-shot scroll target.
      partialize: (s) => ({ scrollTops: s.scrollTops, selections: s.selections }),
      storage: createJSONStorage(() => storage),
      version: 1,
    }
  )
);
