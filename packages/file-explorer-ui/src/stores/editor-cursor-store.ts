import { createSafeJsonStorageAdapter } from '@brainstrike/utils';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

type Key = string; // compositeKey (folderId:path)

export interface CursorSelection {
  cursor: number; // caret index in content
  selectionStart: number;
  selectionEnd: number;
}

interface EditorCursorData {
  selections: Record<Key, CursorSelection | undefined>;
}

interface EditorCursorActions {
  setSelection: (key: Key, sel: CursorSelection) => void;
  getSelection: (key: Key) => CursorSelection | undefined;
  clear: (key?: Key) => void;
}

export type EditorCursorStore = EditorCursorData & EditorCursorActions;

const STORE_NAME = 'editor-cursor.v1' as const;

const storage = createJSONStorage(() => createSafeJsonStorageAdapter());

export const useEditorCursorStore = create<EditorCursorStore>()(
  persist(
    (set, get) => ({
      selections: {},
      setSelection: (key, sel) => set((s) => ({ selections: { ...s.selections, [key]: sel } })),
      getSelection: (key) => get().selections[key],
      clear: (key) => {
        if (!key) {
          set({ selections: {} });
          return;
        }
        const { selections } = get();
        const { [key]: _drop, ...rest } = selections;
        set({ selections: rest });
      },
    }),
    {
      name: STORE_NAME,
      version: 1,
      storage,
      partialize: (s) => ({ selections: s.selections }),
    }
  )
);

// Tests helper
export function __resetEditorCursorStoreForTests() {
  try {
    useEditorCursorStore.setState({ selections: {} });
    const persistApi = (
      useEditorCursorStore as unknown as {
        persist?: { clearStorage?: () => void };
      }
    ).persist;
    persistApi?.clearStorage?.();
  } catch {}
}
