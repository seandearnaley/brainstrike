import { createSafeJsonStorageAdapter } from '@brainstrike/storage';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

type Key = string; // compositeKey (folderId:path)

export interface CursorSelection {
  cursor: number; // caret index in content
  selectionEnd: number;
  selectionStart: number;
}

interface EditorCursorData {
  selections: Record<Key, CursorSelection | undefined>;
}

interface EditorCursorActions {
  clear: (key?: Key) => void;
  getSelection: (key: Key) => CursorSelection | undefined;
  setSelection: (key: Key, sel: CursorSelection) => void;
}

export type EditorCursorStore = EditorCursorData & EditorCursorActions;

const STORE_NAME = 'editor-cursor.v1' as const;

const storage = createJSONStorage(() => createSafeJsonStorageAdapter());

export const useEditorCursorStore = create<EditorCursorStore>()(
  persist(
    (set, get) => ({
      clear: (key) => {
        if (!key) {
          set({ selections: {} });
          return;
        }
        const { selections } = get();
        const { [key]: _drop, ...rest } = selections;
        set({ selections: rest });
      },
      getSelection: (key) => get().selections[key],
      selections: {},
      setSelection: (key, sel) => set((s) => ({ selections: { ...s.selections, [key]: sel } })),
    }),
    {
      name: STORE_NAME,
      partialize: (s) => ({ selections: s.selections }),
      storage,
      version: 1,
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
