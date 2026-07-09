import { createSafeJsonStorageAdapter } from '@brainstrike/storage';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

type Key = string; // use compositeKey (folder:name:path) or tab id

export type FileViewMode = 'source' | 'preview';

/** Inclusive, 1-based line range to select in a freshly opened tab. */
export interface EditorSelectionTarget {
  readonly endLine: number;
  readonly startLine: number;
}

/**
 * One-shot view target for a freshly opened tab: the line to scroll to and,
 * optionally, a line range to select (e.g. a search chunk the user opened so
 * they can copy the block immediately). Consumed once on the opening render.
 */
export interface EditorViewTarget {
  readonly line: number;
  readonly selection?: EditorSelectionTarget;
}

interface EditorViewStateData {
  modes: Record<Key, FileViewMode>;
  scrollTops: Record<Key, number>;
  selections: Record<Key, { start: number; end: number } | undefined>;
  /**
   * Transient (NOT persisted) one-shot view target to apply on a freshly opened
   * tab's first render — e.g. a workspace-search match line, or a chunk range to
   * scroll to AND select. Consumed once on the opening render; it intentionally
   * survives reloads as nothing (persisting a one-shot target would fight
   * restored scroll position on every boot).
   */
  targets: Record<Key, EditorViewTarget | undefined>;
}

interface EditorViewStateActions {
  clear: (key?: Key) => void;
  /**
   * Consume the one-shot view target for a key WITHOUT touching scrollTop or
   * the persisted selection. Callers (e.g. workspace-tab-host's FileTabBody)
   * call this right after the opening render has used the target, so a later
   * remount of the same key (tab switch away/back, close/reopen) reads no target
   * and falls back to the restored scroll position instead of re-applying it.
   */
  clearTarget: (key: Key) => void;
  getMode: (key: Key) => FileViewMode | undefined;
  getScrollTop: (key: Key) => number;
  getSelection: (key: Key) => { start: number; end: number } | undefined;
  getTarget: (key: Key) => EditorViewTarget | undefined;
  setMode: (key: Key, mode: FileViewMode) => void;
  setScrollTop: (key: Key, top: number) => void;
  setSelection: (key: Key, start: number, end: number) => void;
  setTarget: (key: Key, target: EditorViewTarget) => void;
}

export type EditorViewStateStore = EditorViewStateData & EditorViewStateActions;

const STORE_NAME = 'editor-view-state.v1' as const;

const storage = createSafeJsonStorageAdapter();

/** Coerce a raw line into a positive, 1-based integer. */
function normalizeLine(line: number): number {
  return Math.max(1, line | 0);
}

/** Normalize a view target's line(s) so downstream consumers get sane 1-based values. */
function normalizeTarget(target: EditorViewTarget): EditorViewTarget {
  const line = normalizeLine(target.line);
  if (!target.selection) {
    return { line };
  }
  const startLine = normalizeLine(target.selection.startLine);
  const endLine = Math.max(startLine, normalizeLine(target.selection.endLine));
  return { line, selection: { endLine, startLine } };
}

export const useEditorViewStateStore = create<EditorViewStateStore>()(
  persist(
    (set, get) => ({
      clear: (key) => {
        if (!key) {
          set({ modes: {}, scrollTops: {}, selections: {}, targets: {} });
          return;
        }
        const { modes, scrollTops, selections, targets } = get();
        const previewKey = `preview:${key}`;
        const { [key]: _a, [previewKey]: _p, ...restScrolls } = scrollTops;
        const { [key]: _b, ...restSel } = selections;
        const { [key]: _c, ...restTargets } = targets;
        const { [key]: _d, ...restModes } = modes;
        set({
          modes: restModes,
          scrollTops: restScrolls,
          selections: restSel,
          targets: restTargets,
        });
      },
      clearTarget: (key) => {
        const { targets } = get();
        if (!(key in targets)) {
          return;
        }
        const { [key]: _removed, ...restTargets } = targets;
        set({ targets: restTargets });
      },
      getMode: (key) => get().modes[key],
      getScrollTop: (key) => get().scrollTops[key] ?? 0,
      getSelection: (key) => get().selections[key],
      getTarget: (key) => get().targets[key],
      modes: {},
      scrollTops: {},
      selections: {},

      setMode: (key, mode) => set((s) => ({ modes: { ...s.modes, [key]: mode } })),
      setScrollTop: (key, top) =>
        set((s) => ({ scrollTops: { ...s.scrollTops, [key]: Math.max(0, top | 0) } })),
      setSelection: (key, start, end) =>
        set((s) => ({ selections: { ...s.selections, [key]: { end, start } } })),
      setTarget: (key, target) =>
        set((s) => ({ targets: { ...s.targets, [key]: normalizeTarget(target) } })),
      targets: {},
    }),
    {
      migrate: (persistedState, version) => {
        if (version < 2) {
          // v1 payloads predate modes; keep scroll/selection state and start modes fresh.
          return { ...(persistedState as Partial<EditorViewStateData>), modes: {} };
        }
        return persistedState as Partial<EditorViewStateData>;
      },
      name: STORE_NAME, // unchanged: 'editor-view-state.v1' — renaming would orphan users' data
      // targets is intentionally excluded: it is a one-shot view target.
      partialize: (s) => ({ modes: s.modes, scrollTops: s.scrollTops, selections: s.selections }),
      storage: createJSONStorage(() => storage),
      version: 2,
    }
  )
);
