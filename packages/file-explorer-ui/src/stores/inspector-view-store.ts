import { createSafeJsonStorageAdapter } from '@brainstrike/utils/safe-storage';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

type ContextKey = string; // e.g., folderId, file path, or compositeKey

export interface InspectorFields {
  // Example fields; add/extend as inspector grows
  includeInReport: boolean;
  note: string;
  summaryLevel: number; // e.g., 1..10
}

interface InspectorData {
  byContext: Record<ContextKey, InspectorFields | undefined>;
}

interface InspectorActions {
  clear: (ctx?: ContextKey) => void;
  getFields: (ctx: ContextKey) => InspectorFields | undefined;
  setFields: (ctx: ContextKey, fields: InspectorFields) => void;
  updateFields: (ctx: ContextKey, patch: Partial<InspectorFields>) => void;
}

export type InspectorViewStore = InspectorData & InspectorActions;

const STORE_NAME = 'inspector-view.v1' as const;

const storage = createJSONStorage(() => createSafeJsonStorageAdapter());

const DEFAULTS: InspectorFields = {
  includeInReport: true,
  note: '',
  summaryLevel: 5,
};

export const useInspectorViewStore = create<InspectorViewStore>()(
  persist(
    (set, get) => ({
      byContext: {},
      clear: (ctx) => {
        if (!ctx) {
          set({ byContext: {} });
          return;
        }
        const { byContext } = get();
        const { [ctx]: _drop, ...rest } = byContext;
        set({ byContext: rest });
      },
      getFields: (ctx) => get().byContext[ctx] ?? DEFAULTS,
      setFields: (ctx, fields) => set((s) => ({ byContext: { ...s.byContext, [ctx]: fields } })),
      updateFields: (ctx, patch) =>
        set((s) => ({
          byContext: {
            ...s.byContext,
            [ctx]: { ...(s.byContext[ctx] ?? DEFAULTS), ...patch },
          },
        })),
    }),
    {
      name: STORE_NAME,
      partialize: (s) => ({ byContext: s.byContext }),
      storage,
      version: 1,
    }
  )
);

// Tests helper
export function __resetInspectorViewStoreForTests() {
  try {
    useInspectorViewStore.setState({ byContext: {} });
    const persistApi = (
      useInspectorViewStore as unknown as {
        persist?: { clearStorage?: () => void };
      }
    ).persist;
    persistApi?.clearStorage?.();
  } catch {}
}
