import { NATIVE_TOOL_DEFAULTS } from '@brainstrike/agent/tool-metadata';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

type NativeToolStateMap = Record<string, boolean>;

interface NativeToolPreferencesData {
  toolStates: NativeToolStateMap;
}

interface NativeToolPreferencesActions {
  isToolEnabled: (toolId: string) => boolean;
  resetTools: () => void;
  setToolEnabled: (toolId: string, enabled: boolean) => void;
  setToolsEnabled: (toolIds: string[], enabled: boolean) => void;
}

export type NativeToolPreferencesStore = NativeToolPreferencesData & NativeToolPreferencesActions;

const STORE_NAME = 'native-tool-preferences.v1' as const;

function readLocalStorage(): Storage | undefined {
  try {
    return typeof globalThis.localStorage === 'undefined' ? undefined : globalThis.localStorage;
  } catch {
    return;
  }
}

function removeStoredValue(storage: Storage | undefined, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    // Best effort: blocked storage should not make cleanup flows fail.
  }
}

function createNativeToolPreferencesStorage(): StateStorage {
  const memory = new Map<string, string>();

  const shouldPersistValue = (value: string): boolean => {
    try {
      const parsed = JSON.parse(value) as { state?: { toolStates?: unknown } };
      const toolStates = parsed.state?.toolStates;
      return Boolean(
        toolStates && typeof toolStates === 'object' && Object.keys(toolStates).length > 0
      );
    } catch {
      return true;
    }
  };

  return {
    getItem: (key) => {
      const storage = readLocalStorage();
      const raw = storage?.getItem(key) ?? memory.get(key) ?? null;
      if (raw === null) {
        return null;
      }

      try {
        JSON.parse(raw);
        return raw;
      } catch {
        removeStoredValue(storage, key);
        memory.delete(key);
        return null;
      }
    },
    setItem: (key, value) => {
      if (!shouldPersistValue(value)) {
        removeStoredValue(readLocalStorage(), key);
        memory.delete(key);
        return;
      }
      const storage = readLocalStorage();
      if (storage) {
        try {
          storage.setItem(key, value);
          return;
        } catch {
          // Fall through to in-memory storage for quota/private-mode failures.
        }
      }
      memory.set(key, value);
    },
    removeItem: (key) => {
      removeStoredValue(readLocalStorage(), key);
      memory.delete(key);
    },
  };
}

const storage = createJSONStorage(() => createNativeToolPreferencesStorage());

const KNOWN_NATIVE_TOOL_IDS = new Set(Object.keys(NATIVE_TOOL_DEFAULTS));

function sanitizeToolStates(value: unknown): NativeToolStateMap {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const cleaned: NativeToolStateMap = {};

  for (const [toolId, enabled] of entries) {
    if (!KNOWN_NATIVE_TOOL_IDS.has(toolId)) {
      continue;
    }
    if (typeof enabled === 'boolean') {
      cleaned[toolId] = enabled;
    }
  }

  return cleaned;
}

function resolveToolEnabled(toolId: string, states: NativeToolStateMap): boolean {
  const value = states[toolId];
  return typeof value === 'boolean' ? value : true;
}

export const useNativeToolPreferencesStore = create<NativeToolPreferencesStore>()(
  persist(
    (set, get) => ({
      toolStates: {},
      setToolEnabled: (toolId, enabled) =>
        set((state) => {
          const next = { ...state.toolStates };
          if (enabled) {
            delete next[toolId];
          } else {
            next[toolId] = false;
          }
          return { toolStates: next };
        }),
      setToolsEnabled: (toolIds, enabled) =>
        set((state) => {
          if (toolIds.length === 0) {
            return state;
          }
          const next = { ...state.toolStates };
          for (const toolId of toolIds) {
            if (enabled) {
              delete next[toolId];
            } else {
              next[toolId] = false;
            }
          }
          return { toolStates: next };
        }),
      resetTools: () => set({ toolStates: {} }),
      isToolEnabled: (toolId: string) => resolveToolEnabled(toolId, get().toolStates),
    }),
    {
      name: STORE_NAME,
      version: 1,
      storage,
      migrate: (state) => {
        const snapshot = state as Partial<NativeToolPreferencesStore> | undefined;
        return {
          ...snapshot,
          toolStates: sanitizeToolStates(snapshot?.toolStates),
        } satisfies Partial<NativeToolPreferencesStore>;
      },
      partialize: (store) => ({
        toolStates: store.toolStates,
      }),
    }
  )
);

export const nativeToolPreferencesSelectors = {
  toolStates: (store: NativeToolPreferencesStore): NativeToolStateMap => store.toolStates,
  isToolEnabled: (store: NativeToolPreferencesStore): NativeToolPreferencesStore['isToolEnabled'] =>
    store.isToolEnabled,
};

export function __resetNativeToolPreferencesStoreForTests(): void {
  try {
    const persistApi = (
      useNativeToolPreferencesStore as unknown as {
        persist?: { clearStorage?: () => void };
      }
    ).persist;
    persistApi?.clearStorage?.();
  } catch {
    // Intentionally silent in tests - storage errors should not fail test resets.
  }
  useNativeToolPreferencesStore.setState({ toolStates: {} });
}
